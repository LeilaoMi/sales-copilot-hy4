/* ============================================================
 * 销冠助手 · 云同步引擎（Local-first）
 *
 * 设计原则：
 *   1. 本地永远是权威数据源，云端只是同步通道。断网、服务器挂了，工具照常能用。
 *   2. 同步单位是整包快照（数据量小，几十 KB，最简单也最不容易出错）。
 *   3. 冲突策略：逐条 Last-Write-Wins（比 updatedAt），删除用墓碑（deleted 标记）。
 *   4. 单人顺序操作下 100% 正确；多人同时改同一条记录，后写的赢（个人工具可接受）。
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
   * 顺带说明：删除产生的墓碑也在 SYNC_KEYS 里，示例的墓碑同样被过滤 ——
   * 云端从来没有过这条记录，不需要为它留墓碑。 */
  function pushPayload() {
    const s = snapshot();
    S.SYNC_KEYS.forEach(k => { s[k] = (s[k] || []).filter(r => !r.demo); });
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

  function adapter() {
    const c = cfg();
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

  return { merge, snapshot, pushPayload, applySnapshot, sync, start, stop, on, onLocalChange, cfg, saveCfg, getStatus };
})();
