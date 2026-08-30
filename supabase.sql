-- ============================================================
-- 销冠助手 · Supabase 建库脚本（多人版 v2）
-- 在 Supabase 控制台 → SQL Editor 里**整段**执行即可，可重复执行（幂等）
--
-- 这一版解决的是上一版做不到的事：
--   上版是「一行 = 一个空间，整包 JSON，anon 全开」，
--   谁拿到 URL + anon key + 空间名，谁就能读写全部数据，
--   更做不到「同一个团队里，销售之间互相看不见」。
--
-- 这版的核心思路：
--   1) 业务记录**按条**存，不再整包覆盖 —— 两个人改不同的客户不会互相抹掉
--   2) 隔离交给数据库（RLS），不交给前端 —— 前端代码写错也漏不出去
--   3) 团队内「成员只见自己的，管理员可见全队的」—— 但管理员只读，不能改别人的单
-- ============================================================

-- ---------- 0. 工具函数 ----------
create or replace function touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;


-- ============================================================
-- 1. 团队
-- ============================================================
create table if not exists teams (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  owner_id    uuid references auth.users(id) on delete cascade,
  /* 邀请码：没有它这个功能根本转不起来，原因见文件末尾的 FAQ */
  invite_code text unique,
  created_at  timestamptz not null default now()
);

-- ============================================================
-- 2. 成员档案：角色写在这里
--    role: owner 拥有者 / admin 管理员 / member 使用员
-- ============================================================
create table if not exists profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  team_id       uuid references teams(id) on delete set null,
  role          text not null default 'member'
                  check (role in ('owner', 'admin', 'member')),
  display_name  text,
  created_at    timestamptz not null default now()
);

-- 新用户注册时自动建档案，否则第一次同步会因为查不到 profile 卡住。
-- 首个注册的人自动成为 owner，并顺手建一个同名团队——
-- 一个人用的时候也得有个团队，否则后面所有「团队」逻辑都要写空判断。
create or replace function handle_new_user()
returns trigger as $$
declare
  new_team_id uuid;
  member_count int;
begin
  select count(*) into member_count from profiles;

  if member_count = 0 then
    /* 顺手把邀请码生成好：不然第一个人想加同事进来看不到码，
     * 会以为这个功能坏了 */
    insert into teams (name, owner_id, invite_code)
      values (
        coalesce(new.raw_user_meta_data->>'name', '我的团队'),
        new.id,
        upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))
      )
      returning id into new_team_id;

    insert into profiles (id, team_id, role, display_name)
      values (new.id, new_team_id, 'owner',
              coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)));
  else
    insert into profiles (id, team_id, role, display_name)
      values (new.id, null, 'member',
              coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)));
  end if;

  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();


-- ============================================================
-- 3. 业务记录：统一宽表
--
-- 为什么不每种实体建一张表（customers / deals / followups ...）：
--   这个工具是**本地优先**的，所有查询都发生在浏览器内存里，
--   云端只干两件事——跨设备同步、以及当隔离边界。
--   既然云端不承担查询，一张宽表就够了，
--   以后加了新实体（比如「报价单」）一行代码都不用改库。
--
-- 主键用 (user_id, kind, id) 复合：id 是本地生成的，
--   不同用户可能撞 id，所以必须带上 user_id 才唯一。
-- 删除是软删（deleted=true）：硬删的话「删除」这个动作没法同步给别人。
-- ============================================================
create table if not exists records (
  user_id     uuid not null references auth.users(id) on delete cascade,
  kind        text not null,              -- customers / deals / followups / scripts / ...
  id          text not null,              -- 本地生成的记录 id
  team_id     uuid references teams(id) on delete set null,
  data        jsonb not null,             -- 整条记录原样存，前端自己解析
  updated_at  timestamptz not null default now(),
  deleted     boolean not null default false,
  primary key (user_id, kind, id)
);

create index if not exists records_sync_idx on records (user_id, updated_at);
create index if not exists records_team_idx on records (team_id);

-- ============================================================
-- 4. 团队共享话术库
--
-- 和借鉴项目的「全局 10k 知识库」的关键区别：**按团队隔离**，不是全局可读。
-- 全局可读意味着别家公司的人也能翻你的话术，这在真实团队里是不能接受的。
-- 自己团队内部共享才有意义：老人踩过的坑，新人直接拿来用。
-- ============================================================
create table if not exists team_scripts (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references teams(id) on delete cascade,
  author_id   uuid references auth.users(id) on delete set null,
  title       text not null,
  content     text not null,
  scene       text,
  tags        text[],
  used_count  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists team_scripts_team_idx on team_scripts (team_id, updated_at);

-- ============================================================
-- 5. 个人设置（目标金额、AI 配置、同步配置等）
--   单独一张表而不是塞进 records：设置是整份读写的，没有按条合并的必要。
-- ============================================================
create table if not exists user_settings (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  data        jsonb not null,
  updated_at  timestamptz not null default now()
);


-- ============================================================
-- 6. RLS：隔离在这一层落地，不在前端
-- ============================================================
alter table teams         enable row level security;
alter table profiles      enable row level security;
alter table records       enable row level security;
alter table team_scripts  enable row level security;
alter table user_settings enable row level security;

-- 取「我所在的团队」和「我是不是管理员」。
-- 必须加 security definer：普通写法会在查 profiles 时又触发 profiles 的 RLS，
-- 形成无限递归，表现为所有查询都返回空——这个坑很隐蔽，报错信息也不提示。
create or replace function my_team_id()
returns uuid as $$
  select team_id from profiles where id = auth.uid();
$$ language sql security definer stable;

create or replace function my_role()
returns text as $$
  select role from profiles where id = auth.uid();
$$ language sql security definer stable;

-- ---------- profiles ----------
drop policy if exists "profile_self" on profiles;
create policy "profile_self" on profiles
  for select to authenticated
  using (id = auth.uid() or team_id = my_team_id());

drop policy if exists "profile_self_update" on profiles;
create policy "profile_self_update" on profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- ---------- teams ----------
drop policy if exists "team_member_read" on teams;
create policy "team_member_read" on teams
  for select to authenticated
  using (id = my_team_id() or owner_id = auth.uid());

drop policy if exists "team_owner_write" on teams;
create policy "team_owner_write" on teams
  for update to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

drop policy if exists "team_owner_insert" on teams;
create policy "team_owner_insert" on teams
  for insert to authenticated
  with check (owner_id = auth.uid());

-- ---------- records：这是「数据各自独立」的主战场 ----------
-- 成员：自己的记录，读写都行
drop policy if exists "records_self" on records;
create policy "records_self" on records
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- 管理员：同团队**只读**。
-- 刻意不给 update/delete——管理员能在看板上看全队进度就够了，
-- 改别人的客户和报价是另一回事，手一抖就是事故。
drop policy if exists "records_admin_read" on records;
create policy "records_admin_read" on records
  for select to authenticated
  using (
    my_role() in ('owner', 'admin')
    and team_id is not null
    and team_id = my_team_id()
  );

-- ---------- team_scripts ----------
-- 同团队可读；作者本人或管理员可改可删
drop policy if exists "scripts_team_read" on team_scripts;
create policy "scripts_team_read" on team_scripts
  for select to authenticated
  using (team_id = my_team_id());

drop policy if exists "scripts_own_write" on team_scripts;
create policy "scripts_own_write" on team_scripts
  for all to authenticated
  using (author_id = auth.uid())
  with check (
    author_id = auth.uid()
    and team_id = my_team_id()
  );

drop policy if exists "scripts_admin_write" on team_scripts;
create policy "scripts_admin_write" on team_scripts
  for all to authenticated
  using (my_role() in ('owner', 'admin') and team_id = my_team_id())
  with check (team_id = my_team_id());

-- ---------- user_settings ----------
-- 设置里存着 AI Key，除了本人谁都不能看，管理员也不行
drop policy if exists "settings_self" on user_settings;
create policy "settings_self" on user_settings
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());


-- ---------- 邀请码：加入团队的唯一入口 ----------
/* 为什么非得有这个东西：
 *   新注册的成员 team_id 是空的，而管理员的 RLS 只看得到**同团队**的人。
 *   于是管理员看不见新人 → 没法把他拉进来 → 他永远是空的 → 还是看不见。
 *   这是个死循环，光靠 RLS 解不开。
 *
 *   所以改成「管理员亮出邀请码，成员自己输入加入」：
 *   成员改的是**自己那一行**的 team_id，这本来就在他的权限内；
 *   但改成哪个队由 security definer 函数按邀请码决定，
 *   这样他没法凭空填一个 team_id 混进别人的团队。 */
create or replace function reset_invite_code()
returns text as $$
declare c text;
begin
  if my_role() not in ('owner', 'admin') then
    raise exception '只有管理员能重置邀请码';
  end if;
  if my_team_id() is null then
    raise exception '你还没有团队';
  end if;
  c := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  update teams set invite_code = c where id = my_team_id();
  return c;
end;
$$ language plpgsql security definer;

create or replace function my_invite_code()
returns text as $$
  select invite_code from teams where id = my_team_id();
$$ language sql security definer stable;

create or replace function join_team(code text)
returns uuid as $$
declare tid uuid;
begin
  if code is null or length(trim(code)) = 0 then
    raise exception '请填邀请码';
  end if;
  select id into tid from teams where invite_code = upper(trim(code));
  if tid is null then
    raise exception '邀请码不对，找管理员要一个';
  end if;
  update profiles set team_id = tid where id = auth.uid();
  if not found then
    raise exception '没找到你的档案，试试重新登录';
  end if;
  return tid;
end;
$$ language plpgsql security definer;

/* 退出团队：成员自己可以退，管理员也能把人移出去（后者走 profiles 的 admin 策略） */
create or replace function leave_team()
returns void as $$
begin
  update profiles set team_id = null where id = auth.uid();
end;
$$ language plpgsql security definer;

grant execute on function reset_invite_code() to authenticated;
grant execute on function my_invite_code() to authenticated;
grant execute on function join_team(text) to authenticated;
grant execute on function leave_team() to authenticated;


-- ---------- updated_at 自动维护 ----------
drop trigger if exists records_touch on records;
create trigger records_touch before insert or update on records
  for each row execute function touch_updated_at();

drop trigger if exists team_scripts_touch on team_scripts;
create trigger team_scripts_touch before insert or update on team_scripts
  for each row execute function touch_updated_at();

drop trigger if exists user_settings_touch on user_settings;
create trigger user_settings_touch before insert or update on user_settings
  for each row execute function touch_updated_at();


-- ============================================================
-- 常见问题
-- ============================================================
-- Q: 前端报 401
--    A: 没登录，或者 token 过期了。重新登录即可。
--
-- Q: 前端报 403 / 一直返回空数组
--    A: 十有八九是 profiles 表里没有你这条档案。
--       老项目（v1 建过库的）不会自动补，手动执行：
--         insert into profiles (id, role, display_name)
--         select id, 'owner', split_part(email, '@', 1) from auth.users
--         where id not in (select id from profiles);
--
-- Q: 管理员看不到成员的数据
--    A: 成员的 team_id 是空的。让管理员在「团队」页把人加进来，
--       或者手动：update profiles set team_id = '<团队ID>' where id = '<成员ID>';
--
-- Q: 管理员在团队页看不到新注册的人
--    A: 这是设计如此，不是 bug——管理员的 RLS 只看得到**同团队**的人，
--       而新人注册后 team_id 是空的。让管理员看见所有注册用户，
--       等于把「谁在用这个系统」暴露给所有管理员，不划算。
--       正路是邀请码：管理员在团队页点「重置邀请码」拿到 8 位码，
--       新人在自己的设置页填这个码加入。
--
-- Q: 成员能不能自己填个 team_id 混进别人的团队
--    A: 不能。加入必须走 join_team(code)，team_id 由邀请码在数据库里查出来，
--       成员改的是自己那一行，但改成哪个队他说了不算。
--
-- Q: 我想让管理员也能改成员的数据
--    A: 可以，但不建议。真要开：
--       create policy "records_admin_write" on records
--         for update to authenticated
--         using (my_role() in ('owner','admin') and team_id = my_team_id())
--         with check (team_id = my_team_id());
--
-- Q: 老库（sales_sync）要删吗
--    A: 留着不影响。想清掉：drop table if exists sales_sync;
