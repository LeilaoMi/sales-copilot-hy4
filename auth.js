/* ============================================================
 * 销冠助手 · 账号与团队
 *
 * 一条铁律：**没登录也要能完整使用。**
 *   这个工具先是一个人的本地工具，后才是团队工具。
 *   加了账号却把单人用户挡在登录页外面，那是本末倒置。
 *   所以这里所有函数在未登录时都安静返回「没登录」，不弹窗、不拦截、不跳转。
 *
 * 用 Supabase Auth（GoTrue）的原生 REST 接口，不引 SDK：
 *   整个项目是零依赖的，为一个登录功能塞进来一个几百 KB 的 SDK 不划算，
 *   而且 GoTrue 的接口就那么几个，fetch 直接打就行。
 *
 * 安全上的前提：这里拿到的 access_token 存在 localStorage，
 *   而「数据各自独立」不靠前端守规矩，靠数据库 RLS。
 *   就算有人改了前端代码，拿着 anon key 去直接查库，也只查得到自己的东西。
 * ============================================================ */
window.Auth = (function () {
  const S = window.Store;
  const LS = 'sc.auth.session';

  let session = null;      // { access_token, refresh_token, expires_at, user_id, email }
  let profile = null;      // { id, team_id, role, display_name }
  let refreshing = null;   // 并发刷新时共用一个 Promise，避免刷出两个 token

  const listeners = [];
  const on = fn => listeners.push(fn);
  const notify = () => listeners.forEach(fn => { try { fn(); } catch (e) {} });

  /* ---------- 配置 ---------- */
  function cfg() { return (S.state.settings || {}).cloud || {}; }
  function saveCfg(patch) {
    S.state.settings.cloud = Object.assign({}, cfg(), patch);
    S.save();
  }
  function configured() { return !!(cfg().url && cfg().key); }

  /* ---------- 会话存取 ---------- */
  function loadSession() {
    try {
      const raw = localStorage.getItem(LS);
      session = raw ? JSON.parse(raw) : null;
    } catch (e) { session = null; }
    if (session && session.expires_at && Date.now() > session.expires_at - 60000) {
      // 已经过期了，等下次要用的时候再刷新
    }
    return session;
  }
  function saveSession(s) {
    session = s;
    try {
      if (s) localStorage.setItem(LS, JSON.stringify(s));
      else localStorage.removeItem(LS);
    } catch (e) {}
    notify();
  }

  const isOn = () => !!(session && session.access_token);
  const userId = () => (session && session.user_id) || '';
  const email = () => (session && session.email) || '';
  const isExpired = () => !!(session && session.expires_at && Date.now() > session.expires_at - 60000);

  /* ---------- HTTP ---------- */
  function headers(withAuth) {
    const h = { 'apikey': cfg().key || '', 'Content-Type': 'application/json' };
    if (withAuth && session) h['Authorization'] = 'Bearer ' + session.access_token;
    return h;
  }
  const base = () => (cfg().url || '').replace(/\/$/, '');

  async function call(path, opts) {
    const r = await fetch(base() + path, opts);
    let body = null;
    const txt = await r.text();
    try { body = txt ? JSON.parse(txt) : null; } catch (e) { body = txt; }
    if (!r.ok) {
      const msg = (body && (body.msg || body.message || body.error_description || body.error))
        || ('HTTP ' + r.status);
      const err = new Error(msg);
      err.status = r.status;
      throw err;
    }
    return body;
  }

  /* ---------- 注册 / 登录 / 登出 ---------- */
  async function signUp(mail, pwd, name) {
    if (!configured()) throw new Error('还没填 Supabase 地址和 anon key');
    const d = await call('/auth/v1/signup', {
      method: 'POST',
      headers: headers(false),
      body: JSON.stringify({ email: mail, password: pwd, data: { name: name || '' } })
    });
    /* 如果 Supabase 开了邮箱验证，这里不会返回 token，
     * 而是返回一个 user 对象——这时候要提示用户去邮箱点链接。 */
    if (!d.access_token) {
      return { needConfirm: true, email: mail };
    }
    saveSession({
      access_token: d.access_token,
      refresh_token: d.refresh_token,
      expires_at: Date.now() + (d.expires_in || 3600) * 1000,
      user_id: d.user ? d.user.id : '',
      email: mail
    });
    await loadProfile(true);
    return { needConfirm: false };
  }

  async function signIn(mail, pwd) {
    if (!configured()) throw new Error('还没填 Supabase 地址和 anon key');
    const d = await call('/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: headers(false),
      body: JSON.stringify({ email: mail, password: pwd })
    });
    saveSession({
      access_token: d.access_token,
      refresh_token: d.refresh_token,
      expires_at: Date.now() + (d.expires_in || 3600) * 1000,
      user_id: d.user ? d.user.id : '',
      email: (d.user && d.user.email) || mail
    });
    await loadProfile(true);
    return profile;
  }

  async function signOut() {
    try {
      if (isOn()) await call('/auth/v1/logout', { method: 'POST', headers: headers(true) });
    } catch (e) { /* 登出不成功也要把本地清干净，不然下次进来是个死会话 */ }
    saveSession(null);
    profile = null;
  }

  async function refresh() {
    if (!session || !session.refresh_token) throw new Error('没有可刷新的会话');
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const d = await call('/auth/v1/token?grant_type=refresh_token', {
          method: 'POST',
          headers: headers(false),
          body: JSON.stringify({ refresh_token: session.refresh_token })
        });
        saveSession({
          access_token: d.access_token,
          refresh_token: d.refresh_token,
          expires_at: Date.now() + (d.expires_in || 3600) * 1000,
          user_id: d.user ? d.user.id : session.user_id,
          email: session.email
        });
        return session;
      } finally { refreshing = null; }
    })();
    return refreshing;
  }

  /* 带自动续期的请求。token 快过期就先刷一次再发。 */
  async function api(path, opts) {
    if (!isOn()) throw new Error('未登录');
    if (isExpired()) {
      try { await refresh(); } catch (e) { saveSession(null); throw new Error('登录已过期，请重新登录'); }
    }
    const o = Object.assign({}, opts, {
      headers: Object.assign(headers(true), (opts && opts.headers) || {})
    });
    try {
      return await call(path, o);
    } catch (e) {
      /* 401 先尝试刷新一次再重试，还不行才算真的掉线 */
      if (e.status === 401) {
        try {
          await refresh();
          return await call(path, Object.assign({}, o, { headers: headers(true) }));
        } catch (e2) {
          saveSession(null);
          throw new Error('登录已过期，请重新登录');
        }
      }
      throw e;
    }
  }

  /* ---------- 档案（角色 / 团队） ---------- */
  const role = () => (profile && profile.role) || '';
  const isAdmin = () => role() === 'owner' || role() === 'admin';
  const teamId = () => (profile && profile.team_id) || '';
  const displayName = () => (profile && profile.display_name) || email() || '';

  async function loadProfile(force) {
    if (!isOn()) { profile = null; return null; }
    if (profile && !force) return profile;
    try {
      const rows = await api('/rest/v1/profiles?id=eq.' + encodeURIComponent(userId()) +
        '&select=id,team_id,role,display_name', { method: 'GET' });
      profile = (rows && rows[0]) || null;
    } catch (e) {
      profile = null;
    }
    notify();
    return profile;
  }

  /* 团队成员（管理员视角）。
   * 普通成员调这个会拿到空数组——不是 bug，是 RLS 在起作用：
   * profiles 的策略是「自己 + 同团队」，成员能看到同队的同事，
   * 但看不到别人的 team_id 之外的东西。 */
  async function teamMembers() {
    if (!isAdmin() || !teamId()) return [];
    try {
      return await api('/rest/v1/profiles?team_id=eq.' + encodeURIComponent(teamId()) +
        '&select=id,role,display_name,team_id&order=created_at.asc', { method: 'GET' });
    } catch (e) { return []; }
  }

  /* 把一个人拉进团队。只有管理员能干，
   * 而且 RLS 会在数据库层再拦一道——前端判断只是为了让按钮不显示。 */
  async function addToTeam(uid, asRole) {
    if (!isAdmin()) throw new Error('只有管理员能加人');
    const r = await api('/rest/v1/profiles?id=eq.' + encodeURIComponent(uid), {
      method: 'PATCH',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({ team_id: teamId(), role: asRole || 'member' })
    });
    return r && r[0];
  }

  async function setRole(uid, newRole) {
    if (!isAdmin()) throw new Error('只有管理员能改角色');
    if (uid === userId() && newRole !== 'owner') {
      throw new Error('不能把自己的管理员身份去掉，先把 owner 转给别人');
    }
    const r = await api('/rest/v1/profiles?id=eq.' + encodeURIComponent(uid), {
      method: 'PATCH',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({ role: newRole })
    });
    return r && r[0];
  }

  async function removeFromTeam(uid) {
    if (!isAdmin()) throw new Error('只有管理员能移人');
    if (uid === userId()) throw new Error('不能把自己移出团队');
    await api('/rest/v1/profiles?id=eq.' + encodeURIComponent(uid), {
      method: 'PATCH',
      headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify({ team_id: null })
    });
    return true;
  }

  async function renameTeam(name) {
    if (!isAdmin() || !teamId()) throw new Error('只有管理员能改团队名');
    await api('/rest/v1/teams?id=eq.' + encodeURIComponent(teamId()), {
      method: 'PATCH',
      headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify({ name: name })
    });
    return true;
  }

  /* ---------- 测试连接：填完配置先探一下 ---------- */
  async function testConn() {
    if (!configured()) throw new Error('还没填地址和 key');
    /* 用 profiles 表探活：没登录时应该返回 401（说明地址/ key 对），
     * 404（表没建）或 403（没开 RLS）都要明确告诉用户是哪种问题。 */
    const r = await fetch(base() + '/rest/v1/profiles?select=id&limit=1', {
      headers: { 'apikey': cfg().key }
    });
    if (r.status === 401 || r.status === 200) return { ok: true };
    const txt = await r.text();
    if (r.status === 404) throw new Error('地址对得上，但表还没建——请先执行 supabase.sql');
    throw new Error('HTTP ' + r.status + ' ' + txt.slice(0, 80));
  }

  /* ---------- 启动 ---------- */
  function init() {
    loadSession();
    if (isOn() && configured()) {
      loadProfile(true).catch(() => {});
    }
  }

  return {
    init, on, cfg, saveCfg, configured, testConn,
    signUp, signIn, signOut, refresh, api,
    isOn, userId, email, isExpired,
    loadProfile, role, isAdmin, teamId, displayName,
    teamMembers, addToTeam, setRole, removeFromTeam, renameTeam,
    get profile() { return profile; }
  };
})();
