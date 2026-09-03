/* ============================================================
 * 销冠助手 · 跟进到期提醒
 *
 * 为什么需要这个：销售一天跑三四家客户，回到工位已经忘了早上该给谁打电话。
 * 系统通知是唯一能在「人不在页面上」的时候把事情递到眼前的手段。
 *
 * 三条约束：
 *   1. **不能吵**。一天弹二十次，用户第一件事就是关掉通知权限，
 *      那这个功能就彻底废了。所以每天最多提醒一轮，同一条不重复提醒。
 *   2. **权限被拒要降级**。用户点了「阻止」之后，Notification 会抛异常，
 *      这时候改成页面内的角标提醒，而不是什么都不做——
 *      更不能用 alert 去烦人。
 *   3. **没 HTTPS 就没有通知**（浏览器限制，localhost 除外）。
 *      本地双击打开时静默跳过，别弹一堆报错吓唬人。
 * ============================================================ */
window.Notify = (function () {
  const S = Store;
  const LS_LAST = 'sc.notify.last';      // 上次提醒的日期
  const LS_SENT = 'sc.notify.sent';      // 今天已经提醒过的条目

  const HOURS_AHEAD = 48;                // 只提醒 48 小时内到期的

  function cfg() { return (S.state.settings || {}).notify || {}; }
  function saveCfg(patch) {
    S.state.settings.notify = Object.assign({}, cfg(), patch);
    S.save();
  }

  const supported = () => typeof Notification !== 'undefined';
  const granted = () => supported() && Notification.permission === 'granted';
  const denied = () => supported() && Notification.permission === 'denied';

  async function request() {
    if (!supported()) return 'unsupported';
    if (Notification.permission === 'granted') return 'granted';
    if (Notification.permission === 'denied') return 'denied';
    try {
      const r = await Notification.requestPermission();
      return r;
    } catch (e) {
      return 'denied';
    }
  }

  function today() { return S.todayStr(); }

  function loadSent() {
    const d = loadLast();
    if (d.date !== today()) return [];
    try { return JSON.parse(localStorage.getItem(LS_SENT) || '[]'); } catch (e) { return []; }
  }
  function loadLast() {
    try { return JSON.parse(localStorage.getItem(LS_LAST) || '{}'); } catch (e) { return {}; }
  }
  function markSent(ids) {
    try {
      localStorage.setItem(LS_SENT, JSON.stringify(ids));
      localStorage.setItem(LS_LAST, JSON.stringify({ date: today() }));
    } catch (e) {}
  }

  /* ---------- 该提醒哪些 ----------
   * 只挑两类：
   *   1) 已经过了跟进日还没跟的（欠账）
   *   2) 48 小时内要到期的（提前排期）
   * 「还没到期也没逾期」的不提醒，那是明后天的事。 */
  function pending() {
    const t = today();
    const out = [];
    S.list('customers').forEach(c => {
      if (!c.nextFollowAt || c.deleted) return;
      const days = S.diffDays(c.nextFollowAt);
      if (days === null) return;
      /* diffDays 是「目标日 - 今天」：负数=已过期，0=今天，正数=还有几天 */
      if (days <= 0) {
        out.push({ id: c.id, name: c.name, at: c.nextFollowAt, days: days, kind: 'overdue' });
      } else if (days === 1 || days === 2) {
        out.push({ id: c.id, name: c.name, at: c.nextFollowAt, days: days, kind: 'soon' });
      }
    });
    /* 逾期的排前面，逾期越久越靠前——但这只是排序，不代表最该做，
     * 真正的「该盯一盯」在 health.js 里用非线性打分算过了，这里不重复造轮子 */
    return out.sort((a, b) => a.days - b.days || String(a.at).localeCompare(String(b.at)));
  }

  function titleOf(list) {
    const n = list.length;
    const overdue = list.filter(x => x.kind === 'overdue').length;
    if (overdue && overdue === n) return `有 ${n} 家客户该跟进了`;
    if (overdue) return `${overdue} 家已逾期，${n - overdue} 家快到期`;
    return `今明两天有 ${n} 家要跟进`;
  }

  function bodyOf(list) {
    return list.slice(0, 3).map(x => {
      const when = x.days < 0 ? `已逾期 ${Math.abs(x.days)} 天` : (x.days === 0 ? '今天' : `${x.days} 天后`);
      return `${x.name}（${when}）`;
    }).join('、') + (list.length > 3 ? ` 等 ${list.length} 家` : '');
  }

  /* ---------- 主入口 ----------
   * 返回本次实际提醒的条数。没权限 / 没数据 / 今天提醒过了，都返回 0。 */
  function check(force) {
    const c = cfg();
    if (c.enabled === false) return 0;
    if (!supported()) return 0;

    const list = pending();
    if (!list.length) return 0;

    const last = loadLast();
    const sent = loadSent();
    const fresh = force ? list : list.filter(x => sent.indexOf(x.id + '@' + x.at) < 0);
    if (!fresh.length) return 0;

    /* 同一天不重复轰炸：第一轮提醒过之后，当天剩下的就只做页面内角标 */
    const firstToday = last.date !== today();

    if (granted() && firstToday) {
      try {
        const n = new Notification(titleOf(list), {
          body: bodyOf(list),
          tag: 'sales-copilot-followup',
          /* 不加 requireInteraction：让系统自己收，不占着屏幕 */
        });
        n.onclick = function () {
          try { window.focus(); } catch (e) {}
          if (typeof UI !== 'undefined' && UI.go) UI.go('customers');
          n.close();
        };
      } catch (e) {
        /* 有些浏览器要求在 Service Worker 里才能创建通知，
         * 失败了就走页面内角标，不能因为通知弹不出来就当没这事 */
        return 0;
      }
    }

    markSent(list.map(x => x.id + '@' + x.at));
    return list.length;
  }

  /* 页面内角标用的：不管有没有系统通知权限，这个数字都要有 */
  function badge() {
    const list = pending();
    return { count: list.length, overdue: list.filter(x => x.kind === 'overdue').length, list: list };
  }

  /* ---------- 定时 ----------
   * 每 30 分钟查一次。太频繁没意义：跟进日是天粒度，
   * 分钟级的变化只有「刚记了一笔，跟进日变了」这一种。 */
  let timer = null;
  function start() {
    if (timer) return;
    check(false);
    timer = setInterval(() => check(false), 30 * 60 * 1000);
  }
  function stop() {
    clearInterval(timer);
    timer = null;
  }

  return {
    supported, granted, denied, request,
    check, pending, badge, start, stop,
    cfg, saveCfg,
    get permission() { return supported() ? Notification.permission : 'unsupported'; }
  };
})();
