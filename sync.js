/* ============================================================
 * 销冠助手 · 云同步引擎（Local-first）
 *
 * 三种模式：
 *   http     —— 自建/兼容后端，整包快照（一个人多设备，最省事）
 *   supabase —— Supabase 表存整包快照（同上，只是换个存放地）
 *   cloud    —— Supabase 账号，**按记录同步**（多人用这个）
 *
 * 设计原则：
 *   1. 本地永远是权威数据源，云端只是同步通道。断网、服务器挂了，工具照常能用。
 *   2. 整包快照只适合一个人用；多人必须按记录同步，否则会互相覆盖（见 cloudAdapter）。
 *   3. 冲突策略：Last-Write-Wins（比 updatedAt），删除用墓碑（deleted 标记）。
 *   4. 「谁能看见谁」交给数据库 RLS，前端不做权限判断——前端判断绕得过去，RLS 绕不过去。
 * ============================================================ */
window.Sync = (function () {
  const S = Store;
  const PUSH_DELAY = 4000;   // 本地变更后 4 秒推送
  const PULL_INTERVAL = 60000; // 每 60 秒拉取一次

  let status = 'off';        // off | idle | syncing | error
  let message = '';
  let lastSyncAt = 0;
  let pushTimer = null;
  let pullTimer = null;
  let applying = false;      // 应用云端数据期间，不再触发本地变更推送
  let busy = false;
  const listeners = [];

  const on = fn => listeners.push(fn);
  const notify = () => listeners.forEach(fn => { try { fn(); } catch (e) {} });
  function setStatus(s, msg) { status = s; message = msg || ''; notify(); }
  const getStatus = () => ({ status, message, lastSyncAt, mode: cfg().mode || 'off' });

  function cfg() { return S.state.settings.sync || { mode: 'off' }; }
  function saveCfg(patch) {
    S.state.settings.sync = Object.assign({ mode: 'off' }, S.state.settings.sync || {}, patch);
    S.state.settings.updatedAt = Date.now();
    S.save();
  }

  /* ---------- 合并：逐条 LWW，墓碑参与 ---------- */
  function merge(a, b) {
    const out = {};
    S.SYNC_KEYS.forEach(k => {
      const map = new Map();
      (a[k] || []).forEach(r => map.set(r.id, r));
      (b[k] || []).forEach(r => {
        const prev = map.get(r.id);
        if (!prev || (Number(r.updatedAt) || 0) >= (Number(prev.updatedAt) || 0)) map.set(r.id, r);
      });
      out[k] = [...map.values()];
    });
    return out;
  }

  /* 本地快照 */
  function snapshot() {
    const st = S.state;
    return {
      v: 1,
      deviceId: st.deviceId,
      savedAt: Date.now(),
      settings: st.settings,
      customers: st.customers,
      deals: st.deals,
      followups: st.followups,
      scripts: st.scripts
    };
  }

  /* 推送专用载荷：把示例数据摘干净。
   *
   * 为什么不能直接改 snapshot()：它还有一个用途是给 applySnapshot()
   * 提供「本地这一侧」去和远端合并。在那儿过滤掉示例，合并结果里就没有示例，
   * 写回 state 时本地刚灌的示例会被当场抹掉 —— 用户一同步示例就没了。
   * 推送（往外发）和合并（跟自己比）是两件事，必须分开。
   *
   * 墓碑要单独说一句：`!r.demo || r.deleted`。
   *
   * 墓碑是「删除」这个动作的唯一载体。云端可能还留着历史上推上去的示例客户
   * （那时候示例没打标记），要是连墓碑一起过滤掉，那批旧示例就永远删不掉了 ——
   * 用户清空、同步、示例复活，无解。
   *
   * 所以规则是：示例记录本身不上云，但示例的**墓碑**必须放行。 */
  function pushPayload() {
    const s = snapshot();
    S.SYNC_KEYS.forEach(k => { s[k] = (s[k] || []).filter(r => !r.demo || r.deleted); });
    return s;
  }

  /* 把合并结果写回本地（不触发推送） */
  function applySnapshot(remote) {
    if (!remote) return 0;
    const local = snapshot();
    const merged = merge(local, remote);
    const before = S.revision();
    applying = true;
    try {
      S.state.customers = merged.customers;
      S.state.deals = merged.deals;
      S.state.followups = merged.followups;
      S.state.scripts = merged.scripts;
      // settings 也按"谁新谁赢"合并（这样目标/提成/AI 配置能跨设备一致；
      // 但同步配置本身以本地为准，避免被云端把 endpoint 冲掉）
      const rs = remote.settings || {};
      const ls = S.state.settings || {};
      if ((Number(rs.updatedAt) || 0) > (Number(ls.updatedAt) || 0)) {
        S.state.settings = Object.assign({}, rs, { sync: ls.sync || rs.sync });
      }
      S.save();
    } finally { applying = false; }
    return S.revision() !== before ? 1 : 0;
  }

  /* ---------- 适配器：自建 / 兼容后端 ---------- */
  /* 令牌用两种头各发一份：有些云平台的网关会剥离 Authorization，
     多带一个 X-Sync-Token 就能绕过去。服务端两个都认。 */
  const authHeaders = c => ({
    'Authorization': 'Bearer ' + (c.token || ''),
    'X-Sync-Token': (c.token || '')
  });

  const httpAdapter = {
    label: '自建服务器',
    async pull(c) {
      const r = await fetch(c.endpoint.replace(/\/$/, ''), { headers: authHeaders(c) });
      if (r.status === 404) return null;               // 云端还没有数据
      if (!r.ok) throw new Error('拉取失败 HTTP ' + r.status +
        (r.status === 401 ? '（令牌不对，或网关把认证头吃掉了）' : ''));
      const j = await r.json();
      return j.data || j;
    },
    async push(c, data) {
      /* 额外发一个 X-Device-Id 头。
       * EdgeOne 适配器靠它把每台设备的数据写进各自的文件，避免互相覆盖；
       * data.deviceId 也在 body 里，适配器会兜底去读，但带上头更明确，
       * 万一将来 body 里没带这个字段，多设备隔离依然成立。
       * 自建 server.js 不认识这个头，直接忽略，不受影响。 */
      const r = await fetch(c.endpoint.replace(/\/$/, ''), {
        method: 'PUT',
        headers: Object.assign(
          { 'Content-Type': 'application/json', 'X-Device-Id': String(data.deviceId || '') },
          authHeaders(c)),
        body: JSON.stringify({ data: data, baseRevision: data.revision || 0 })
      });
      if (!r.ok) throw new Error('推送失败 HTTP ' + r.status +
        (r.status === 401 ? '（令牌不对，或网关把认证头吃掉了）' : ''));
      const j = await r.json();
      return j.data || null;
    }
  };

  /* ---------- 适配器：Supabase（Postgres + REST） ---------- */
  const supabaseAdapter = {
    label: 'Supabase',
    rowUrl(c) {
      return `${(c.url || '').replace(/\/$/, '')}/rest/v1/${c.table || 'sales_sync'}?id=eq.${encodeURIComponent(c.space || 'default')}`;
    },
    headers(c) {
      return {
        'apikey': c.key || '',
        'Authorization': 'Bearer ' + (c.key || ''),
        'Content-Type': 'application/json'
      };
    },
    async pull(c) {
      const r = await fetch(this.rowUrl(c) + '&select=data', { headers: this.headers(c) });
      if (!r.ok) throw new Error('拉取失败 HTTP ' + r.status);
      const rows = await r.json();
      return rows && rows[0] ? rows[0].data : null;
    },
    async push(c, data) {
      const r = await fetch((c.url || '').replace(/\/$/, '') + '/rest/v1/' + (c.table || 'sales_sync'), {
        method: 'POST',
        headers: Object.assign(this.headers(c), { 'Prefer': 'resolution=merge-duplicates,return=minimal' }),
        body: JSON.stringify({ id: c.space || 'default', data: data, updated_at: new Date().toISOString() })
      });
      if (!r.ok) throw new Error('推送失败 HTTP ' + r.status + '（检查表名/RLS 策略）');
      return null;
    }
  };

  /* ---------- 适配器：Supabase 账号（记录级，多人） ----------
   *
   * 为什么多人必须换掉整包快照，有三条理由，按分量排序：
   *
   * 一、**归属没法做**（这是决定性的）。
   *   整包快照是「一个空间 = 一份完整状态」。两个人共用一个空间，
   *   云端躺着的就是一份混在一起的 JSON，数据库压根分不清哪条客户是谁的。
   *   于是 RLS 无用武之地，权限、隔离、管理员视图全都没法落地。
   *   按记录存之后，每条都带 user_id，隔离才能在数据库层真正生效。
   *
   * 二、**并发窗口里云端会短暂不完整**。
   *   两人几乎同时同步时，都是「先拉、再改、后推」。
   *   后推的那份会把先推的改动在云端挤掉——虽然有 merge 兜底，
   *   但在这个窗口里第三个人拉到的就是残缺数据。
   *   按记录推，后推的只覆盖自己改的那条，别人的原地不动。
   *
   * 三、**流量**。改一条客户要传整份快照，几百条记录时无所谓，
   *   几千条跟进记录时每次同步都搬一遍就浪费了。
   *
   * 顺带纠正一个容易夸大的说法：整包快照**不至于**把对方全部改动抹掉，
   *   因为合并是逐条比 updatedAt 的。它的毛病在上面三条，不在「互相删库」。
   *
   * 另外，「谁能看见谁」完全交给数据库 RLS，
   *   这里一个权限判断都不写——写了也不可靠，前端判断是能绕过去的。 */
  const cloudAdapter = {
    label: 'Supabase 账号',
    async pull(c) {
      const since = c.pullCursor || '1970-01-01T00:00:00Z';
      const rows = await Auth.api(
        '/rest/v1/records?user_id=eq.' + encodeURIComponent(Auth.userId()) +
        '&updated_at=gt.' + encodeURIComponent(since) +
        '&select=kind,id,data,deleted,updated_at&order=updated_at.asc&limit=2000',
        { method: 'GET' });
      return { rows: rows || [] };
    },
    async push(c, changes) {
      if (!changes.length) return null;
      const tid = Auth.teamId() || null;
      const body = changes.map(r => ({
        user_id: Auth.userId(),
        kind: r.kind,
        id: r.id,
        team_id: tid,
        data: r.data,
        deleted: !!r.deleted
      }));
      /* 分批：一次塞几千条 URL 和 body 都容易超限，500 一批比较稳 */
      for (let i = 0; i < body.length; i += 500) {
        await Auth.api('/rest/v1/records?on_conflict=user_id,kind,id', {
          method: 'POST',
          headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(body.slice(i, i + 500))
        });
      }
      return null;
    },
    async pullSettings() {
      const rows = await Auth.api(
        '/rest/v1/user_settings?user_id=eq.' + encodeURIComponent(Auth.userId()) +
        '&select=data,updated_at', { method: 'GET' });
      return rows && rows[0] ? rows[0] : null;
    },
    async pushSettings(data) {
      await Auth.api('/rest/v1/user_settings?on_conflict=user_id', {
        method: 'POST',
        headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ user_id: Auth.userId(), data: data })
      });
    }
  };

  /* 本地自 ts 之后变过的记录。
   * 示例数据依然不上云，但示例的墓碑要放行——理由同 pushPayload()。 */
  function changedSince(ts) {
    const out = [];
    S.SYNC_KEYS.forEach(k => {
      (S.state[k] || []).forEach(r => {
        if (r.demo && !r.deleted) return;
        if ((Number(r.updatedAt) || 0) > ts) {
          out.push({ kind: k, id: r.id, data: r, deleted: !!r.deleted });
        }
      });
    });
    return out;
  }

  /* 把云端记录逐条并回本地（记录级 LWW）。
   * 返回实际改动了几条。 */
  function applyRecords(rows) {
    if (!rows || !rows.length) return 0;
    let changed = 0;
    applying = true;
    try {
      rows.forEach(r => {
        /* 云端返回什么不完全由我们说了算：网关、代理、手写的数据都可能掺进
         * null 或缺字段的行。同步是后台跑的，在这里抛异常没有任何人能看到，
         * 只会让整个同步静默停摆——所以宁可跳过也不能崩。 */
        if (!r || !r.id || S.SYNC_KEYS.indexOf(r.kind) < 0) return;
        if (!Array.isArray(S.state[r.kind])) S.state[r.kind] = [];
        const arr = S.state[r.kind];
        const idx = arr.findIndex(x => x.id === r.id);
        const remote = Object.assign({}, (r.data || {}), { id: r.id, deleted: !!r.deleted });
        if (idx < 0) {
          arr.push(remote);
          changed++;
          return;
        }
        const local = arr[idx];
        const rt = Number(remote.updatedAt) || 0;
        const lt = Number(local.updatedAt) || 0;
        if (rt > lt) { arr[idx] = remote; changed++; }
        /* 远端更旧就保持本地不动——下次推的时候本地这条会被带上去 */
      });
      if (changed) S.save();
    } finally { applying = false; }
    return changed;
  }

  /* 设置整份合并（谁新谁赢），但同步配置永远以本地为准：
   * 否则云端一份旧配置下来，会把用户刚填的地址和令牌冲掉，
   * 表现就是「同步莫名其妙失效了」——这个坑以前踩过。 */
  function applyCloudSettings(remote) {
    if (!remote || !remote.data) return false;
    const rs = remote.data;
    const ls = S.state.settings || {};
    const rAt = Number(rs.updatedAt) || 0;
    const lAt = Number(ls.updatedAt) || 0;
    if (rAt <= lAt) return false;
    S.state.settings = Object.assign({}, rs, { sync: ls.sync || rs.sync });
    S.save();
    return true;
  }

  /* 账号模式一次完整的往返：先拉后推，推完记游标 */
  async function cloudSync(c) {
    const pulled = await cloudAdapter.pull(c);
    const n = applyRecords(pulled.rows);

    /* 拉游标用云端最后一条的时间：下次只拉更新的部分。
     * 一条都没拉到就保持原游标不动。 */
    if (pulled.rows && pulled.rows.length) {
      saveCfg({ pullCursor: pulled.rows[pulled.rows.length - 1].updated_at });
    }

    /* 设置单独往返一次，只处理自己的那份 */
    const rs = await cloudAdapter.pullSettings();
    const setChanged = applyCloudSettings(rs);
    const ls = S.state.settings || {};
    const remoteSettingsAt = rs && rs.updated_at ? Date.parse(rs.updated_at) : 0;
    if ((Number(ls.updatedAt) || 0) > (remoteSettingsAt || 0)) {
      await cloudAdapter.pushSettings(ls);
    }

    /* 推：只推上次推之后变过的。
     * 游标回退 5 秒是刻意的——推送期间用户很可能还在改东西，
     * 这 5 秒的宽限能保证那些改动不会被漏掉，代价只是下次多推几条。 */
    const since = Number(c.pushCursor) || 0;
    const changes = changedSince(since ? since - 5000 : 0);
    await cloudAdapter.push(c, changes);
    saveCfg({ pushCursor: Date.now() });

    return { pulled: n, pushed: changes.length, settingsChanged: setChanged };
  }

  function adapter() {
    const c = cfg();
    if (c.mode === 'cloud') return cloudAdapter;
    return c.mode === 'supabase' ? supabaseAdapter : httpAdapter;
  }

  /* ---------- 主流程：先拉、本地合并、再推 ---------- */
  async function sync(manual) {
    const c = cfg();
    if (c.mode === 'off') { setStatus('off', ''); return { ok: false, msg: '未启用云同步' }; }
    if (busy) return { ok: false, msg: '正在同步中' };
    busy = true;
    setStatus('syncing', manual ? '正在同步…' : '');
    try {
      if (c.mode === 'cloud') {
        if (!Auth.isOn()) {
          setStatus('error', '未登录，账号同步没跑');
          return { ok: false, msg: '未登录' };
        }
        const r = await cloudSync(c);
        lastSyncAt = Date.now();
        S.state.settings.lastSyncAt = lastSyncAt;
        S.save();
        setStatus('idle', '已同步 ' + new Date(lastSyncAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
        notify();
        return { ok: true, detail: r };
      }

      const ad = adapter();
      const remote = await ad.pull(c);
      if (remote) applySnapshot(remote);
      const mine = pushPayload();
      mine.revision = S.revision();
      const back = await ad.push(c, mine);
      if (back) applySnapshot(back);
      lastSyncAt = Date.now();
      const st = S.state.settings;
      st.lastSyncAt = lastSyncAt;
      S.save();
      setStatus('idle', '已同步 ' + new Date(lastSyncAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
      return { ok: true };
    } catch (e) {
      setStatus('error', e.message || String(e));
      return { ok: false, msg: e.message || String(e) };
    } finally {
      busy = false;
      notify();
    }
  }

  /* 本地变更后的延迟推送 */
  function onLocalChange() {
    if (applying) return;
    if ((cfg().mode || 'off') === 'off') return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => sync(false), PUSH_DELAY);
  }

  /* 启动 / 停止
   * 注意：start() 可能被反复调用（每次点「保存并连接」都会调一次），
   * 网络事件监听只注册一次，否则每点一次就多挂一对监听器。 */
  let netBound = false;
  function bindNet() {
    if (netBound) return;
    netBound = true;
    window.addEventListener('online', () => {
      if ((cfg().mode || 'off') !== 'off') sync(false);
    });
    window.addEventListener('offline', () => {
      if ((cfg().mode || 'off') !== 'off') setStatus('error', '网络已断开，本地数据不受影响');
    });
    // 手机切回前台时立刻补一次：轮询在后台是停的，不然要等最多 60 秒
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && (cfg().mode || 'off') !== 'off') sync(false);
    });
  }

  /* 返回首次同步的 Promise：调用方需要等「云端到底有没有数据」这个答案
   * 落定之后，才能判断要不要给新用户灌示例数据。
   * 没配同步时返回已解决的 Promise，调用方不必分叉处理。 */
  function start() {
    const c = cfg();
    if ((c.mode || 'off') === 'off') { setStatus('off', ''); return Promise.resolve({ ok: false, msg: '未启用云同步' }); }
    bindNet();
    setStatus('idle', '待同步');
    clearTimeout(pushTimer);
    clearInterval(pullTimer);
    const first = sync(false);
    // 页面在后台时不轮询，省电省流量；切回前台由 visibilitychange 补一次
    pullTimer = setInterval(() => { if (!document.hidden) sync(false); }, PULL_INTERVAL);
    return first;
  }
  function stop() {
    clearTimeout(pushTimer);
    clearInterval(pullTimer);
    pullTimer = null;
    setStatus('off', '');
  }

  return {
    merge, snapshot, pushPayload, applySnapshot,
    changedSince, applyRecords, applyCloudSettings, cloudSync,
    sync, start, stop, on, onLocalChange, cfg, saveCfg, getStatus
  };
})();
