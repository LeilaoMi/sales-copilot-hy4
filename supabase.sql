-- ============================================================
-- 销冠助手 · Supabase / 兼容 Postgres 建表脚本
-- 在 Supabase 控制台 → SQL Editor 里整段执行即可
-- ============================================================

-- 1. 同步表：一行 = 一个「空间」（一个人，或一个团队共用一份数据）
create table if not exists sales_sync (
  id          text primary key,            -- 空间名，前端填的那个，如 default / zhangsan
  data        jsonb       not null,        -- 整包快照
  updated_at  timestamptz not null default now()
);

-- 2. 开启行级安全（RLS）。不开的话 Supabase 会拒绝匿名访问。
alter table sales_sync enable row level security;

-- 3. 匿名 key 策略：允许 anon 角色读写全部空间。
--    适合个人自用 / 小团队内部工具。
--    注意：这意味着「知道 URL + anon key + 空间名」的人就能读写。
--    想更安全，把下面策略换成只允许自己的登录用户，见文件末尾的进阶写法。
drop policy if exists "anon full access" on sales_sync;
create policy "anon full access"
  on sales_sync for all
  to anon
  using (true)
  with check (true);

-- 4. 自动维护 updated_at（可选，只是方便排查）
create or replace function touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists sales_sync_touch on sales_sync;
create trigger sales_sync_touch
  before insert or update on sales_sync
  for each row execute function touch_updated_at();

-- ============================================================
-- 常见问题
-- ============================================================
-- Q: 前端报 "推送失败 HTTP 401/403"
--    A: anon key 填错了，或者没建上面的 RLS 策略。
--
-- Q: 前端报 "推送失败 HTTP 404"
--    A: 表名不是 sales_sync，或者 Project URL 少了 https://。
--       另外前端用的是 PostgREST，URL 形如 https://xxx.supabase.co
--
-- Q: 我想让多个人各用各的
--    A: 前端「空间名」填不同值即可，一行一个空间，互不影响。
--
-- Q: 想更安全一点（进阶）
--    A: 删掉上面的 "anon full access"，改用登录用户隔离：
--
--       drop policy if exists "anon full access" on sales_sync;
--       create policy "own rows only" on sales_sync
--         for all to authenticated
--         using (id = auth.jwt()->>'app_space')
--         with check (id = auth.jwt()->>'app_space');
