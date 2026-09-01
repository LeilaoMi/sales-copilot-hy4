/* ============================================================
 * 销冠助手 · 数据层
 * 数据全部保存在浏览器本地（localStorage），无后端、无网络请求。
 * ============================================================ */
window.Store = (function () {

  const KEY = 'sales_copilot_v1';

  /* ---------- 常量字典 ---------- */
  const STAGES = [
    { id: 'lead',      name: '线索',   color: '#94a3b8', prob: 10 },
    { id: 'contact',   name: '接触',   color: '#38bdf8', prob: 25 },
    { id: 'solution',  name: '方案',   color: '#6366f1', prob: 45 },
    { id: 'quote',     name: '报价',   color: '#f59e0b', prob: 65 },
    { id: 'negotiate', name: '谈判',   color: '#ec4899', prob: 80 },
    { id: 'won',       name: '赢单',   color: '#16a34a', prob: 100 },
    { id: 'lost',      name: '输单',   color: '#ef4444', prob: 0 }
  ];
  const BOARD_STAGES = STAGES.filter(s => s.id !== 'lost');
  const LEVELS = [
    { id: 'A', name: 'A 重点', cls: 'tag-a' },
    { id: 'B', name: 'B 常规', cls: 'tag-b' },
    { id: 'C', name: 'C 观察', cls: 'tag-c' }
  ];
  const CUSTOMER_STATUS = ['潜在', '跟进中', '已成交', '已流失'];
  const FOLLOW_TYPES = ['电话', '微信', '拜访', '会议', '邮件', '其他'];
  const INDUSTRIES = ['制造业', '零售快消', '医疗健康', '教育培训', '金融保险', '地产建筑', '物流运输', '政企单位', '互联网', '其他'];
  const SOURCES = ['陌生拜访', '展会', '转介绍', '官网留资', '老客户复购', '电话陌拜', '社群/自媒体', '其他'];

  const stageOf = id => STAGES.find(s => s.id === id) || STAGES[0];
  const levelOf = id => LEVELS.find(l => l.id === id) || LEVELS[2];

  /* ---------- 工具 ---------- */
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const pad = n => String(n).padStart(2, '0');
  const toDate = v => (v ? new Date(v) : null);
  const fmtDate = v => { const d = toDate(v); return d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : ''; };
  const fmtDateTime = v => { const d = toDate(v); return d ? `${fmtDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}` : ''; };
  const todayStr = () => fmtDate(new Date());
  const monthKey = v => { const d = toDate(v) || new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
  const monthLabel = v => { const d = toDate(v) || new Date(); return `${d.getMonth() + 1}月`; };
  const monthFullLabel = v => { const d = toDate(v) || new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
  const addDays = (v, n) => { const d = toDate(v) || new Date(); d.setDate(d.getDate() + n); return fmtDate(d); };
  const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / 86400000);
  const diffDays = v => { // 相对今天相差天数：负=已过期
    if (!v) return null;
    const d = toDate(v); d.setHours(0, 0, 0, 0);
    const t = new Date(); t.setHours(0, 0, 0, 0);
    return Math.round((d - t) / 86400000);
  };
  const money = n => {
    const v = Number(n) || 0;
    if (Math.abs(v) >= 100000000) return (v / 100000000).toFixed(2) + '亿';
    if (Math.abs(v) >= 10000) return (v / 10000).toFixed(v % 10000 === 0 ? 0 : 1) + '万';
    return v.toLocaleString('zh-CN');
  };
  const moneyFull = n => '¥' + (Number(n) || 0).toLocaleString('zh-CN', { maximumFractionDigits: 0 });
  /* 本月还剩几天（含今天）：回款预测与目标倒推都靠它判断「来不来得及」 */
  const daysLeftInMonth = () => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() - d.getDate();
  };
  const escapeHtml = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sum = (arr, f) => arr.reduce((a, b) => a + (Number(f ? f(b) : b) || 0), 0);
  const clone = o => JSON.parse(JSON.stringify(o));

  /* ---------- 状态 ---------- */
  let state = emptyState();

  function emptyState() {
    return {
      version: 1,
      settings: {
        owner: '张伟', monthlyTarget: 300000, commissionRate: 3, company: '个人销售',
        ai: { enabled: false, base: 'https://api.deepseek.com/v1', key: '', model: 'deepseek-chat' },
        pwa: false,
        // 健康度：sensitivity 越小越严格（0.7 严格 / 1 标准 / 1.5 宽松）
        health: { enabled: true, sensitivity: 1, snoozeDays: 7 },
        /* 已经完成过首次引导（灌过示例数据）。
         *
         * 为什么非得有个标记：以前判「要不要灌示例」看的是
         * 「客户和商机是不是都为 0」，于是用户清空数据后一刷新，
         * 示例又自己长回来了 —— 他明明要一个干净的空库，
         * 程序却当成新用户。空库有歧义，只能靠显式标记消除。
         *
         * 放在 settings 里是因为它得跟着同步走：
         * 否则在 A 设备清空后换新设备打开，新设备没这个标记又灌一遍，
         * 再同步回去，A 也跟着遭殃 —— 两台设备互相灌，没完没了。 */
        onboarded: false
      },
      customers: [],
      deals: [],
      followups: [],
      scripts: []
    };
  }

  /* ---------- 持久化（localStorage 不可用时退化为内存） ---------- */
  const SYNC_KEYS = ['customers', 'deals', 'followups', 'scripts'];
  let persistent = true;

  /* 数据迁移：补齐 updatedAt（同步依赖它做冲突判定），老数据平滑升级 */
  function migrate() {
    const now = Date.now();
    let i = 0;
    SYNC_KEYS.forEach(k => {
      (state[k] || []).forEach(r => {
        if (!r.updatedAt) {
          const t = Date.parse(r.createdAt || r.at || r.closedAt || 0);
          r.updatedAt = (t && !isNaN(t)) ? t : now + (i++);
        }
      });
    });

    /* 补阶段轨迹：健康度要算「在这个阶段停了多久」。
     * 老数据没有中间过程，只能用创建日当起点，并打 synth 标记 ——
     * 表示这条是补的、不可信，健康度会退化到默认基准，且文案要说实话。
     * 用户一旦真实推进过阶段，就会追加真实轨迹，标记自动失效。 */
    state.deals.forEach(d => {
      if (!Array.isArray(d.stageHistory) || !d.stageHistory.length) {
        const t = Date.parse(d.createdAt || d.closedAt || 0);
        d.stageHistory = [{
          stage: d.stage || 'lead',
          at: (t && !isNaN(t)) ? t : now + (i++),
          synth: true
        }];
      } else if (d.stageHistory.length > 50) {
        d.stageHistory = d.stageHistory.slice(-50);
      }
    });

    /* 话术库升级：老版本只有 12 条，新版 46 条且带 tags（检索质量依赖 tags）。
     * 老用户升级后必须自动拿到新话术，否则他打开还是旧的，等于没升级。
     *
     * 判断依据是「新种子缺不缺」，不是版本号 —— 版本号会被
     * Object.assign(emptyState(), parsed) 用默认值填掉，老数据里没这个字段时
     * 会被判成「已升级」，迁移永远不执行（这个坑踩过一次）。查内容是自证的。
     *
     * 规则：旧版内置话术视为已被新版覆盖 → 移除；用户自建的 → 一条不动。 */
    if (!state.scripts) state.scripts = [];
    const fresh = defaultScripts();
    if (fresh.length) {
      const freshTitles = {};
      fresh.forEach(x => { freshTitles[x.title] = 1; });

      /* 第一步：按标题合并重复的**内置**话术。
       *
       * 为什么要做：内置话术的 id 以前是 Math.random() 生成的（见 playbook.js 里
       * stableId 的注释）。两台设备各生成一套、id 互不相同，云同步按 id 合并，
       * 于是手机 48 条 + 电脑 48 条 = 云端 96 条标题重复的话术，
       * 每多一台设备再多 48 条。
       *
       * 两个必须注意的点：
       *   一、**只合并内置的**。用户自己攒的话术哪怕重名也是他的东西，
       *       替他删掉一条不可接受。
       *   二、重复项不能直接从数组里 splice 掉。那样云端的那条孤儿不会被删，
       *       下次同步又被拉回本地，表现就是「清了又长回来」。
       *       必须留墓碑（deleted + 新的 updatedAt），同步时才会真的删掉云端那条。 */
      const keptBuiltin = {};
      state.scripts.forEach(x => {
        if (!x || !x.title || !x.builtin) return;
        const prev = keptBuiltin[x.title];
        if (!prev) { keptBuiltin[x.title] = x; return; }
        const pt = Number(prev.updatedAt) || 0;
        const xt = Number(x.updatedAt) || 0;
        if (xt > pt) {
          prev.deleted = true; prev.updatedAt = Date.now();
          keptBuiltin[x.title] = x;
        } else {
          x.deleted = true; x.updatedAt = Date.now();
        }
      });

      /* 第二步：旧版内置话术视为已被新版覆盖 → 移除 */
      let keep = state.scripts.filter(x => !(x.builtin && !freshTitles[x.title]));

      /* 第三步：补齐还缺的内置话术 */
      const have = {};
      keep.forEach(x => { have[x.title] = 1; });
      fresh.forEach(x => { if (!have[x.title]) keep.push(x); });

      keep.forEach(x => { if (!Array.isArray(x.tags)) x.tags = []; });
      state.scripts = keep;
    }

    if (!state.deviceId) state.deviceId = 'dev-' + uid();
  }

  /* 本次 load() 是不是「全新安装」（localStorage 里压根没数据）。
   * 这是判断要不要灌示例数据的**唯一**正确依据。
   * 不能看「库里空不空」—— 用户清空过的库也是空的，
   * 但那不是新用户，给他灌示例等于把他的操作当没发生过。 */
  let freshInstall = false;

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        state = Object.assign(emptyState(), parsed);
        state.settings = Object.assign(emptyState().settings, parsed.settings || {});
        freshInstall = false;
        migrate();
        return;
      }
    } catch (e) { persistent = false; }
    state = emptyState();
    state.scripts = defaultScripts();
    freshInstall = true;
    migrate();
    save();
  }
  /* 有没有任何业务数据（话术库不算 —— 它每次全新安装都会自带种子，
   * 拿它当「这人用过」的证据会永远为真，示例就再也不会出现了）。 */
  function hasBusinessData() {
    return (state.customers && state.customers.length) > 0
      || (state.deals && state.deals.length) > 0
      || (state.followups && state.followups.length) > 0;
  }

  /* 三个条件全满足才灌示例，缺一不可：
   *
   *   1. 本机是全新安装（localStorage 里压根没数据）
   *      —— 少了这条：用户清空过的库也是空的，会被误判成新用户。
   *   2. 从没引导过
   *      —— 少了这条：老用户升级后这个字段是 false，反倒不灌了；
   *         更糟的是 A 清空 → 传到云端 → B 拉到空库 → B 灌示例 → 推回，
   *         A 又看到示例，两台设备互相灌，死循环。
   *   3. 此刻库里没有任何业务数据
   *      —— 少了这条：老用户换新设备首次打开，同步把真实数据拉下来之后，
   *         前两条依然成立（确实是全新安装、确实没引导过），
   *         于是示例混进真实客户里，比重生还难清理。
   *
   * 第 3 条要求调用时机：必须在同步的首次拉取完成之后再问，
   * 拉取之前问等于没问。ui.js 的 init() 就是这么排的。 */
  function shouldSeedDemo() {
    if (state.settings.onboarded) return false;
    if (freshInstall !== true) return false;
    return !hasBusinessData();
  }
  function markOnboarded() {
    state.settings.onboarded = true;
    /* settings 的同步靠 updatedAt 做 LWW（见 sync.js 的 applySnapshot），
     * 不更新它，这个标记就传不到别的设备：新设备照样会再灌一次示例，
     * 跨设备保护形同虚设，死循环照旧。 */
    state.settings.updatedAt = Date.now();
    save();
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); }
    catch (e) { persistent = false; }
  }
  /* 清空业务数据时要活下来的东西：个人设置。
   *
   * 尤其是 settings.sync（endpoint + token）。用户在设置页一个字一个字
   * 填进去的，清空一次业务数据就让他重填一遍已经够烦了，真正要命的是
   * **界面上一声不吭**：mode 悄悄变回 off，同步胶囊不再动，
   * 他以为数据还在往云端传，实际上早就断了 —— 等他在另一台设备上发现
   * 数据对不上，可能是几周以后的事。
   *
   * 「配置」和「数据」是两回事：数据可以清空，配置不能。 */
  function carrySettings() {
    return Object.assign({}, state.settings || {});
  }

  function reset(keepScripts) {
    const s = keepScripts ? state.scripts : defaultScripts();
    const prev = carrySettings();
    const now = Date.now();

    /* 清空必须留墓碑，不能让记录凭空消失。
     *
     * 不留墓碑的话，「清空」只在本机生效：云端那条记录还好好的，
     * 下次同步一 merge 它又回来了。用户在**线上**反复清不掉示例数据，
     * 主因就在这儿 —— 本地判定的问题只是另一半（那一半只在不开同步时发作）。
     *
     * 墓碑让「清空」变成一个能传播的动作：推到云端，别的设备也会跟着清。
     * 代价是数据文件里会留一批墓碑，由设置里的「压缩数据」（purge）清理。 */
    const tombs = {};
    SYNC_KEYS.forEach(k => {
      if (k === 'scripts') { tombs[k] = []; return; }   // 话术库不删，也就不留墓碑
      tombs[k] = (state[k] || []).map(r =>
        r.deleted ? r : Object.assign({}, r, { deleted: true, updatedAt: now }));
    });

    state = emptyState();
    /* 个人设置整份保留，包括 onboarded —— 它是「这个人用过」的证据，
     * 不是数据的一部分。一旦清回 false，换个设备或清一次缓存，
     * 示例就又长回来了，等于把他刚才那一下清空作废。 */
    state.settings = prev;
    state.scripts = s;
    SYNC_KEYS.forEach(k => { if (k !== 'scripts') state[k] = tombs[k]; });
    migrate();
    save();
  }
  const isPersistent = () => persistent;

  /* 全局版本号：所有记录中最大的 updatedAt，用于快速判断是否变化 */
  const revision = () => {
    let max = 0;
    SYNC_KEYS.forEach(k => (state[k] || []).forEach(r => { if (r.updatedAt > max) max = r.updatedAt; }));
    return max;
  };

  /* ---------- 增删改查 ----------
   * 注意：删除采用「墓碑软删除」（deleted + updatedAt），
   * 否则删除操作无法在多设备间同步（删了又会被别的设备同步回来）。 */
  const list = name => state[name].filter(x => !x.deleted);
  function get(name, id) {
    const o = state[name].find(x => x.id === id);
    return (o && !o.deleted) ? o : null;
  }
  function insert(name, obj) {
    const o = Object.assign({ id: uid(), updatedAt: Date.now() }, obj);
    state[name].unshift(o);
    save();
    if (window.Sync && Sync.onLocalChange) Sync.onLocalChange();
    return o;
  }
  function update(name, id, patch) {
    const o = get(name, id);
    if (o) {
      Object.assign(o, patch, { updatedAt: Date.now() });
      /* 示例数据转正：用户在示例客户上改了一个字，它就不再是演示品了，
       * 而是他自己的真实数据 —— 摘掉标记，让它正常参与云同步。
       * 只在这里摘，别处不动：插入新数据的路径走 insert()，本来就干净。 */
      if (o.demo) delete o.demo;
      save();
      if (window.Sync && Sync.onLocalChange) Sync.onLocalChange();
    }
    return o;
  }
  function remove(name, id) {
    const o = state[name].find(x => x.id === id);
    if (o && !o.deleted) {
      o.deleted = true;
      o.updatedAt = Date.now();
      save();
      if (window.Sync && Sync.onLocalChange) Sync.onLocalChange();
    }
  }
  /* 物理清理：把墓碑记录真正删掉（本地「压缩数据」用，不同步给其他设备） */
  function purge() {
    let n = 0;
    SYNC_KEYS.forEach(k => {
      const before = state[k].length;
      state[k] = state[k].filter(x => !x.deleted);
      n += before - state[k].length;
    });
    save();
    return n;
  }

  /* 联动：删除客户时清理其商机与跟进（同为软删除，才能同步） */
  function removeCustomer(id) {
    state.deals.forEach(d => { if (d.customerId === id && !d.deleted) { d.deleted = true; d.updatedAt = Date.now(); } });
    state.followups.forEach(f => { if (f.customerId === id && !f.deleted) { f.deleted = true; f.updatedAt = Date.now(); } });
    remove('customers', id);
  }

  /* ---------- 商机阶段变更（含赢单/输单时间） ---------- */
  /* force=true 时即使阶段未变也重新应用联动（新建商机选赢单/输单时用） */
  function setStage(dealId, stageId, force) {
    const d = get('deals', dealId);
    if (!d) return;
    if (d.stage === stageId && !force) return;
    d.stage = stageId;
    d.updatedAt = Date.now();
    // 记录阶段轨迹：健康度判断要用「你自己走过的真实节奏」当基准，
    // 而不是写死一个全局天数——否则长周期客户会天天误报，报几次就没人看了
    d.stageHistory = Array.isArray(d.stageHistory) ? d.stageHistory : [];
    d.stageHistory.push({ stage: stageId, at: Date.now() });
    // 只留最近 50 条：来回拖阶段会让这个数组无限增长，而它是要同步的。
    // 健康度只需要最近几段的节奏，更早的历史留着只是白白占同步流量。
    if (d.stageHistory.length > 50) d.stageHistory = d.stageHistory.slice(-50);
    if (stageId === 'won' || stageId === 'lost') {
      d.closedAt = d.closedAt || new Date().toISOString();
      const c = get('customers', d.customerId);
      if (c && stageId === 'won') { c.status = '已成交'; c.nextFollowAt = ''; c.updatedAt = Date.now(); }
      if (c && stageId === 'lost' && c.status !== '已成交') { c.status = '已流失'; c.updatedAt = Date.now(); }
    } else {
      d.closedAt = null;
    }
    save();
    if (window.Sync && Sync.onLocalChange) Sync.onLocalChange();
  }
  /* ---------- 统计 ---------- */
  function stats() {
    const now = new Date();
    const mk = monthKey(now);
    const openDeals = list('deals').filter(d => d.stage !== 'won' && d.stage !== 'lost');
    const wonDeals = list('deals').filter(d => d.stage === 'won');
    const lostDeals = list('deals').filter(d => d.stage === 'lost');
    const closed = wonDeals.length + lostDeals.length;

    const monthWon = wonDeals.filter(d => monthKey(d.closedAt) === mk);
    const revenue = sum(monthWon, d => d.amount);
    const target = Number(state.settings.monthlyTarget) || 0;
    const rate = target ? revenue / target : 0;

    // 上月同期
    const lastMk = monthKey(new Date(now.getFullYear(), now.getMonth() - 1, 1));
    const lastRevenue = sum(wonDeals.filter(d => monthKey(d.closedAt) === lastMk), d => d.amount);

    // 漏斗（不含赢单，展示在谈阶段）
    const funnel = BOARD_STAGES.map(s => {
      const arr = openDeals.filter(d => d.stage === s.id);
      return { id: s.id, name: s.name, color: s.color, count: arr.length, amount: sum(arr, d => d.amount) };
    });
    const wonFunnel = { id: 'won', name: '赢单', color: '#16a34a', count: wonDeals.length, amount: sum(wonDeals, d => d.amount) };

    // 近 6 个月业绩
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const k = monthKey(d);
      const arr = wonDeals.filter(x => monthKey(x.closedAt) === k);
      months.push({ key: k, label: monthLabel(d), value: sum(arr, x => x.amount), count: arr.length });
    }

    // 待跟进：今天到期 + 逾期
    const pending = list('customers')
      .filter(c => c.nextFollowAt && c.status !== '已流失')
      .map(c => ({ c, dd: diffDays(c.nextFollowAt) }))
      .filter(x => x.dd !== null && x.dd <= 0)
      .sort((a, b) => a.dd - b.dd);
    const overdue = pending.filter(x => x.dd < 0);
    const todayDue = pending.filter(x => x.dd === 0);

    // 赢单相关
    const winRate = closed ? wonDeals.length / closed : 0;
    const avgDeal = wonDeals.length ? sum(wonDeals, d => d.amount) / wonDeals.length : 0;
    const cycles = wonDeals.filter(d => d.closedAt && d.createdAt).map(d => daysBetween(d.createdAt, d.closedAt));
    const avgCycle = cycles.length ? Math.round(sum(cycles) / cycles.length) : 0;
    const weighted = sum(openDeals, d => (Number(d.amount) || 0) * stageOf(d.stage).prob / 100);
    const openAmount = sum(openDeals, d => d.amount);

    // 本月新增客户
    const newCustomers = list('customers').filter(c => monthKey(c.createdAt) === mk).length;

    // 客户分级分布
    const byLevel = LEVELS.map(l => ({
      id: l.id, name: l.name, color: l.id === 'A' ? '#ef4444' : l.id === 'B' ? '#f59e0b' : '#94a3b8',
      count: list('customers').filter(c => c.level === l.id).length
    }));

    // 本季度累计
    const qStart = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
    const quarterRevenue = sum(wonDeals.filter(d => new Date(d.closedAt) >= qStart), d => d.amount);

    /* ---------- 本月回款预测 ----------
     * 旧写法有两个硬伤，都会让数字虚高到害人：
     *   ① 注释写着「预计本月内成交」，代码却根本没过滤月份——下个月的单也算了进来；
     *   ② 报价/谈判阶段直接全额相加，等于假设 100% 必成。
     * 现在改成逐单按「阶段赢率 × 本月内成交概率」加权，并给出保守/乐观区间。
     * 销售要的是"我这个月大概能拿多少"，不是一个假精确的数字。 */
    const left = daysLeftInMonth();
    const conv = (window.Health && window.Health.conversion) ? window.Health.conversion() : {};
    // 阶段赢率：优先用从自己成交记录学来的，样本不够才退回默认档位
    const winProbOf = d => (conv[d.stage] != null ? conv[d.stage].p : stageOf(d.stage).prob / 100);
    /* 本月内成交的概率。关键是「相对本月还剩几天」而不是绝对天数——
     * 月底剩 2 天时，说"12 天后成交"的单子基本就是下个月的事了；
     * 月初剩 28 天时，同样是 12 天后，就在本月内。
     * 早期版本用固定的 15 天窗口，月末会把一堆下月的单算成高概率。 */
    const thisMonthProb = d => {
      if (!d.expectedClose) return 0.15;          // 连日期都没填，别指望它
      const dd = diffDays(d.expectedClose);
      if (dd === null) return 0.15;
      if (dd < 0) return 0.5;                     // 已经拖了，还有机会但打折
      if (dd <= left) return 1;                   // 本月内到期
      const over = dd - left;                     // 比本月多出几天
      if (over <= 7) return 0.25;                 // 晚一周内，有可能提前签
      if (over <= 21) return 0.1;                 // 晚三周，很难
      return 0.03;                                // 基本没戏
    };

    /* 两个口径必须满足「保守 ≤ 乐观」，否则看的人会懵：
     *   乐观 = Σ(金额 × 本月内成交概率)       —— 只赌时间，假设谈得成
     *   保守 = Σ(金额 × 概率 × 阶段赢率)      —— 时间和赢率都打折
     * 早期版本把「乐观」定义成"本月内到期的全额"，结果月末会出现
     * 乐观=0 而保守>0 的倒挂，逻辑上说不通。 */
    let forecast = 0, optimistic = 0, noDate = 0;
    openDeals.forEach(d => {
      const amt = Number(d.amount) || 0;
      const pm = thisMonthProb(d);
      if (!d.expectedClose) noDate++;              // 没填成交日的只能按最低概率估
      forecast += amt * pm * winProbOf(d);
      optimistic += amt * pm;
    });

    /* ---------- 目标倒推：这个月还来得及吗 ----------
     * 加权预测回答的是「能回多少」，销售月底真正焦虑的是「还差多少、来不来得及」。
     * 这是倒推，不是正推。给方向，不给判决——话说太满会打击士气。 */
    const gapAmount = Math.max(0, target - revenue);
    const needDeals = avgDeal ? Math.ceil(gapAmount / avgDeal) : 0;
    let verdict = 'done', advice = '';
    if (gapAmount <= 0) {
      verdict = 'done';
      advice = '本月目标已完成，冲超额提成，或者把单子压到下个月初。';
    } else if (forecast >= gapAmount) {
      verdict = 'on-track';
      advice = `按现在的节奏能补上缺口。重点盯住已经进入报价/谈判的几单，别在最后关头掉链子。`;
    } else if (forecast >= gapAmount * 0.6) {
      verdict = 'tight';
      const short = gapAmount - forecast;
      advice = `现有在谈单按赢率折算只能覆盖 ${moneyFull(short === gapAmount ? forecast : forecast)}，缺口约 ${moneyFull(short)}。`
        + `本月剩 ${left} 天，还来得及补 ${needDeals || 1} 个能快速签的单，或者把某单的成交日往前推。`;
    } else {
      verdict = 'unlikely';
      const short = gapAmount - forecast;
      advice = `缺口 ${moneyFull(gapAmount)}，现有弹药按赢率折算只够 ${moneyFull(forecast)}，差 ${moneyFull(short)}。`
        + `本月剩 ${left} 天，硬冲大单来不及了。两条路：① 找 ${Math.max(1, needDeals)} 个金额小、决策快的单子补量；`
        + `② 提前跟老板对齐预期，把目标挪到下月，别月底被动。`;
    }

    const forecast2 = {
      conservative: Math.round(forecast),   // 时间和赢率都打折
      optimistic: Math.round(optimistic),   // 只赌时间，假设谈得成
      gap: gapAmount,
      left: left,
      needDeals: needDeals,
      verdict: verdict,
      advice: advice,
      // 用的是自己学来的赢率还是默认档位，UI 上要说明白
      learned: Object.keys(conv).length,
      // 数据完整度：预测准不准，取决于用户有没有把成交日填上。
      // 不藏着掖着，直接告诉他漏了几条，他补上之后预测自然就准了。
      noDate: noDate,
      openCount: openDeals.length
    };

    return {
      mk, revenue, target, rate, lastRevenue, delta: revenue - lastRevenue,
      funnel, wonFunnel, months, pending, overdue, todayDue,
      winRate, avgDeal, avgCycle, weighted, openAmount, newCustomers, byLevel,
      quarterRevenue, forecast: forecast2,
      likely: Math.round(forecast),   // 兼容旧字段，含义已从「阶段全额」改为「概率加权」
      counts: {
        customers: list('customers').length,
        deals: list('deals').length,
        open: openDeals.length,
        followups: list('followups').length,
        won: wonDeals.length,
        lost: lostDeals.length
      }
    };
  }

  /* 客户维度聚合：商机总额、最近跟进 */
  function customerMeta(c) {
    const ds = list('deals').filter(d => d.customerId === c.id);
    const fs = list('followups').filter(f => f.customerId === c.id);
    const last = fs.map(f => f.at).sort().pop() || '';
    return {
      dealCount: ds.length,
      dealAmount: sum(ds, d => d.amount),
      openAmount: sum(ds.filter(d => !['won', 'lost'].includes(d.stage)), d => d.amount),
      wonAmount: sum(ds.filter(d => d.stage === 'won'), d => d.amount),
      followCount: fs.length,
      lastFollow: last
    };
  }

  const customerName = id => { const c = get('customers', id); return c ? c.name : '（客户已删除）'; };
  const dealName = id => { const d = get('deals', id); return d ? d.title : ''; };

  /* ---------- 导入导出 ---------- */
  function exportJSON() { return JSON.stringify(state, null, 2); }
  function importJSON(text) {
    const obj = JSON.parse(text);
    if (!obj || typeof obj !== 'object') throw new Error('文件格式不正确');
    state = Object.assign(emptyState(), obj);
    state.settings = Object.assign(emptyState().settings, obj.settings || {});
    SYNC_KEYS.forEach(k => { if (!Array.isArray(state[k])) state[k] = []; });
    migrate();
    save();
  }
  function customersToCSV() {
    const head = ['客户名称', '联系人', '职务', '电话', '微信', '分级', '行业', '来源', '状态', '下次跟进', '商机总额', '备注'];
    const rows = list('customers').map(c => {
      const m = customerMeta(c);
      return [c.name, c.contact, c.title, c.phone, c.wechat, c.level, c.industry, c.source, c.status, c.nextFollowAt, m.dealAmount, c.note];
    });
    const q = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    return '\uFEFF' + [head, ...rows].map(r => r.map(q).join(',')).join('\n');
  }

  /* ---------- 话术库 ----------
   * 种子数据放在 playbook.js 里（46 条，带 tags 用于检索）。
   * 这里只做委托 —— 话术库的重心是「检索」和「自己沉淀」，
   * 种子只是冷启动时别让它空着。 */
  function defaultScripts() {
    if (window.Playbook) return window.Playbook.defaultScripts();
    return [];  // playbook.js 没加载时退化为空库，不影响其它功能
  }

  /* ---------- 示例数据（相对今天生成，图表演示更真实） ---------- */
  /* keepScripts=true 时保留用户的话术库。
   * 「载入示例数据」的按钮文案承诺了「话术库保留」，代码必须兑现 ——
   * 用户自己攒的话术是他的实战经验，价值远高于任何示例数据，冲掉不可接受。
   * 补缺失的新种子，但不覆盖他改过的任何一条。 */
  function seed(keepScripts) {
    const prev = state && Array.isArray(state.scripts) ? state.scripts : null;
    const prevSettings = carrySettings();
    state = emptyState();
    /* 个人设置整份保留：「载入示例数据」换的是业务数据，
     * 不该顺手把 owner、目标金额、AI 配置、云同步一起重置掉。 */
    state.settings = prevSettings;
    /* 灌过示例 = 完成过引导，顺手把标记置上并推进同步时间戳。
     * 在这里做而不是丢给调用方，是因为「灌示例」本身就是引导的全部内容，
     * 指望每个调用方都记得补一步，迟早有人忘（然后这个 bug 又回来了）。 */
    markOnboarded();
    if (keepScripts && prev && prev.length) {
      const have = {};
      prev.forEach(x => { have[x.title] = 1; });
      state.scripts = prev.concat(defaultScripts().filter(x => !have[x.title]));
    } else {
      state.scripts = defaultScripts();
    }

    const T = (n) => addDays(todayStr(), n);
    const dISO = (n, h) => { const d = new Date(); d.setDate(d.getDate() + n); d.setHours(h || 10, 0, 0, 0); return d.toISOString(); };

    const cs = [
      { name: '恒力精工制造', contact: '王建国', title: '生产副总', phone: '13805120001', wechat: 'wjguo_hl', level: 'A', industry: '制造业', source: '展会', status: '跟进中', note: '两条产线，痛点在排产与质检追溯；老板关注 ROI，汇报对象是集团 CIO。', next: -3 },
      { name: '优鲜到家连锁', contact: '陈敏', title: '运营总监', phone: '13905120002', wechat: 'chenmin_yx', level: 'A', industry: '零售快消', source: '转介绍', status: '跟进中', note: '138 家门店，Q3 计划开 30 家；关注门店巡检与订货协同。已看过演示，反馈正面。', next: 0 },
      { name: '仁和医疗集团', contact: '刘志强', title: '信息科主任', phone: '13705120003', wechat: 'lrh_liu', level: 'A', industry: '医疗健康', source: '官网留资', status: '跟进中', note: '需要本地化部署+等保三级；采购要走招标，周期 3 个月起。', next: 2 },
      { name: '启明教育科技', contact: '赵雪', title: '创始人', phone: '13605120004', wechat: 'zhaoxue_qm', level: 'B', industry: '教育培训', source: '社群/自媒体', status: '跟进中', note: '预算敏感，先要试用；决策快，认人。', next: 1 },
      { name: '中安保保险经纪', contact: '孙浩', title: '渠道负责人', phone: '13505120005', wechat: 'sunhao_zab', level: 'B', industry: '金融保险', source: '陌生拜访', status: '跟进中', note: '关注合规与数据权限；内部已有系统，属于替换型需求。', next: 4 },
      { name: '华远建设集团', contact: '周立', title: '项目经理', phone: '13405120006', wechat: 'zhouli_hy', level: 'B', industry: '地产建筑', source: '老客户复购', status: '跟进中', note: '二期项目，一期用得不错，这次要加劳务实名制模块。', next: -1 },
      { name: '顺达物流', contact: '吴芳', title: '总经理', phone: '13305120007', wechat: 'wufang_sd', level: 'C', industry: '物流运输', source: '电话陌拜', status: '潜在', note: '刚接触，需求不明确，先发案例养着。', next: 6 },
      { name: '云海互联', contact: '郑凯', title: 'CTO', phone: '13205120008', wechat: 'zhengkai_yh', level: 'B', industry: '互联网', source: '官网留资', status: '跟进中', note: '技术型客户，要看 API 和架构文档；反感销售话术，讲事实。', next: 8 },
      { name: '市城投信息化中心', contact: '马主任', title: '副主任', phone: '13105120009', wechat: '', level: 'A', industry: '政企单位', source: '转介绍', status: '跟进中', note: '预算充足但流程长，需要资质材料与案例背书。', next: 12 },
      { name: '嘉禾食品', contact: '林静', title: '财务总监', phone: '13005120010', wechat: 'linjing_jh', level: 'C', industry: '零售快消', source: '展会', status: '已流失', note: '去年对比后选了竞品，价格战失败；半年后再联系。', next: 0 }
    ];

    const customers = cs.map((c, i) => ({
      id: 'c' + (i + 1),
      name: c.name, contact: c.contact, title: c.title, phone: c.phone, wechat: c.wechat,
      level: c.level, industry: c.industry, source: c.source, status: c.status,
      tags: '', note: c.note,
      createdAt: dISO(-160 + i * 12),
      nextFollowAt: c.next === 0 && c.status === '已流失' ? '' : T(c.next)
    }));
    customers[9].nextFollowAt = '';

    const deals = [
      { id: 'd1', cid: 'c1', title: '智能排产系统（2条产线）', amount: 268000, stage: 'negotiate', created: -92, close: 7, note: '已报价两次，二次让利 5%；本周争取签框架。' },
      { id: 'd2', cid: 'c2', title: '门店巡检+订货协同平台', amount: 185000, stage: 'quote', created: -54, close: 18, note: '关注 30 家新店上线节奏，方案已通过运营会。' },
      { id: 'd3', cid: 'c3', title: '本地化部署+等保三级改造', amount: 520000, stage: 'solution', created: -40, close: 62, note: '要招标，先做技术参数引导；需准备资质材料。' },
      { id: 'd4', cid: 'c4', title: '校区管理系统 3 年套餐', amount: 68000, stage: 'contact', created: -22, close: 30, note: '试用账号已开，老板要看到续费率提升的数据。' },
      { id: 'd5', cid: 'c5', title: '渠道佣金结算系统替换', amount: 320000, stage: 'contact', created: -18, close: 45, note: '存量系统合同明年 3 月到期，需提前 3 个月切入。' },
      { id: 'd6', cid: 'c6', title: '劳务实名制模块（二期）', amount: 120000, stage: 'quote', created: -30, close: 12, note: '老客户，价格好谈，重点在交付排期。' },
      { id: 'd7', cid: 'c7', title: 'TMS 运输管理（探索中）', amount: 90000, stage: 'lead', created: -10, close: 60, note: '需求未确认，先发同行业案例。' },
      { id: 'd8', cid: 'c8', title: '开放平台 API 集成', amount: 156000, stage: 'solution', created: -26, close: 25, note: '技术评估阶段，需安排架构师对接。' },
      { id: 'd9', cid: 'c9', title: '智慧城市数据中台子包', amount: 780000, stage: 'contact', created: -15, close: 90, note: '流程长，先做关系与资质铺垫。' },
      { id: 'd10', cid: 'c1', title: '质检追溯模块（追加）', amount: 88000, stage: 'lead', created: -6, close: 40, note: '主单签下来后顺势追加。' },
      /* 已成交（用于业绩曲线） */
      { id: 'd11', cid: 'c6', title: '一期项目管理平台', amount: 210000, stage: 'won', created: -168, close: -150, note: '老客户复购，交付顺利。' },
      { id: 'd12', cid: 'c2', title: '门店小程序（首单）', amount: 96000, stage: 'won', created: -140, close: -118, note: '首单切入，为二期铺路。' },
      { id: 'd13', cid: 'c5', title: '报表分析模块', amount: 145000, stage: 'won', created: -120, close: -86, note: '预算内签单。' },
      { id: 'd14', cid: 'c4', title: '试点校区系统', amount: 42000, stage: 'won', created: -95, close: -58, note: '小单试水，效果不错。' },
      { id: 'd15', cid: 'c8', title: '数据看板 POC', amount: 38000, stage: 'won', created: -70, close: -32, note: 'POC 转正式项目的跳板。' },
      /* 这两条注释写着「本月刚签」，日期就必须真的落在本月。
       * 以前写的是 close: -14 / -9（N 天前），跨月之后就露馅了：
       * 9 月 1 号打开，-14 天是 8 月 18 号，早就不是本月。
       * 于是每月头两周打开 demo，「本月回款」和「目标完成率」全是一片 0，
       * 战情台最显眼的两个数字是空的 —— 第一眼就让人以为软件算错了。
       *
       * 改用 closeInMonth：0 = 本月 1 号，1 = 今天。
       * 1 号打开时两条都落在今天，也不会掉出本月。 */
      { id: 'd16', cid: 'c7', title: '车辆定位模块', amount: 58000, stage: 'won', created: -48, closeInMonth: 0.3, note: '本月刚签，客户要求 2 周上线。' },
      { id: 'd17', cid: 'c9', title: '一期可视化大屏', amount: 260000, stage: 'won', created: -60, closeInMonth: 0.7, note: '本月签单，走完招标流程。' },
      /* 输单 */
      { id: 'd18', cid: 'c10', title: '经销商订货系统', amount: 175000, stage: 'lost', created: -110, close: -66, note: '价格战输给本地厂商，低价冲量。', lost: '价格高出竞品 30%' },
      { id: 'd19', cid: 'c3', title: '移动查房模块', amount: 130000, stage: 'lost', created: -100, close: -44, note: '客户内部项目暂停。', lost: '客户预算冻结' }
    ];

    /* 取「本月第 day 天」的时刻。
     * 不能用「N 天前」来表达「本月签的单」：月初那天数一减就掉到上个月去了。
     * Math.min 是为了不越过今天（1 号打开时 day 只能是 1）。 */
    const thisMonthIso = (day, h) => {
      const d = new Date();
      d.setDate(Math.min(day, d.getDate()));
      d.setHours(h || 16, 0, 0, 0);
      return d.toISOString();
    };

    const dealObjs = deals.map(d => {
      const closed = ['won', 'lost'].includes(d.stage);
      let closeIso, updatedIso, expectIso;
      if (d.closeInMonth != null) {
        const dom = new Date().getDate();
        const day = Math.max(1, Math.round(dom * d.closeInMonth));
        closeIso = thisMonthIso(day, 16);
        updatedIso = thisMonthIso(day, 15);
        expectIso = thisMonthIso(day, 16);
      } else {
        closeIso = dISO(d.close, 16);
        updatedIso = dISO(closed ? d.close : -2, 15);
        expectIso = T(d.close);
      }
      return {
        id: d.id, customerId: d.cid, title: d.title, amount: d.amount,
        stage: d.stage, note: d.note, lostReason: d.lost || '',
        createdAt: dISO(d.created, 9),
        updatedAt: updatedIso,
        expectedClose: expectIso,
        closedAt: closed ? closeIso : null
      };
    });

    const fRaw = [
      ['c1', '拜访', -30, '到厂参观两条产线，王副总亲自接待。确认核心痛点是换线损耗与质检追溯，现场拍了 20 张照片。'],
      ['c1', '会议', -14, '做了方案汇报，参会 6 人（生产/IT/财务）。财务追问 ROI 测算口径，已补一页测算表。'],
      ['c1', '电话', -3, '王总说集团 CIO 下周回，等他拍板。提醒：别催太紧，他不喜欢被推。'],
      ['c2', '微信', -9, '发了同规模连锁的案例，陈总回复"不错，下周约时间细聊"。'],
      ['c2', '会议', -2, '运营会过会，方案通过。下一步：出报价 + 30 家新店上线排期表。'],
      ['c3', '电话', -5, '信息科刘主任确认要走招标，让我先提供技术参数建议稿。已承诺 3 天内给。'],
      ['c4', '微信', -1, '试用第 5 天，赵总说"功能够用，就是有点贵"。走试点小单路线。'],
      ['c6', '电话', -1, '周经理：二期预算下来了，让我尽快报价。'],
      ['c8', '邮件', -4, '发了 API 文档与架构说明，对方架构师在评估，预计一周后给反馈。'],
      ['c9', '拜访', -7, '首次拜访马主任，聊了 40 分钟。对方关注资质与本地案例，已发材料清单。'],
      ['c5', '电话', -6, '孙浩说现有系统合同明年 3 月到期，现在谈太早，让我 11 月再联系。'],
      ['c7', '电话', -3, '吴总客气但没需求，先加了微信发案例。'],
      ['c10', '电话', -66, '输单复盘：对方选了本地厂商，价格低 30%。教训：早锁定预算上限。']
    ];
    const followups = fRaw.map((f, i) => ({
      id: 'f' + (i + 1), customerId: f[0], dealId: '',
      type: f[1], at: dISO(f[2], 14 + (i % 4)), content: f[3],
      nextAt: ''
    }));

    /* 打上 demo 标记：示例数据是本地演示品，不是资产。
     *
     * 有了这个标记，云同步推送时会把它们过滤掉，示例永远不会进云端 ——
     * 否则「新设备没配同步 → 自动灌了示例 → 之后配上同步 → 一把推上去」
     * 就会把假客户混进真客户里，比重生还难清理（得一条条认哪些是假的）。
     *
     * 用户一旦动手编辑某条示例（改客户名、改金额、写跟进），
     * update() 会把标记摘掉，它就转正成真实数据，正常参与同步。
     * 「你改过的就是你的」—— 这条规则比任何版本号判断都可靠。 */
    [customers, dealObjs, followups].forEach(arr => arr.forEach(r => { r.demo = true; }));

    state.customers = customers;
    state.deals = dealObjs;
    state.followups = followups;
    migrate();
    save();
  }

  return {
    KEY, STAGES, BOARD_STAGES, LEVELS, CUSTOMER_STATUS, FOLLOW_TYPES, INDUSTRIES, SOURCES, SYNC_KEYS,
    stageOf, levelOf, uid, fmtDate, fmtDateTime, todayStr, monthKey, monthLabel, monthFullLabel,
    addDays, daysBetween, diffDays, money, moneyFull, escapeHtml, sum, daysLeftInMonth,
    load, save, reset, seed, isPersistent, migrate, revision, purge,
    shouldSeedDemo, markOnboarded,
    list, get, insert, update, remove, removeCustomer, setStage,
    stats, customerMeta, customerName, dealName,
    exportJSON, importJSON, customersToCSV, defaultScripts,
    get state() { return state; }
  };
})();
