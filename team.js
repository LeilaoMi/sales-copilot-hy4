/* ============================================================
 * 销冠助手 · 团队看板（只有管理员看得到）
 *
 * 定位要摆正：这是**只读的进度看板**，不是又一个客户列表。
 *   管理员能看到每个人手上多少客户、多少在谈、这个月成了几单、有没有该跟没跟的。
 *   但看不到具体哪个客户的名字、联系人、谈了什么——
 *   那些是销售的饭碗，连老板都不该随手翻。
 *
 * 为什么单独一个模块而不是塞进 store：
 *   队员的数据**不进本地库**。混进去就跟自己的数据纠缠不清了：
 *   导出备份会把别人的客户一起导走，清空数据会连累别人，同步时更会串味。
 *   所以这里拿到的始终是内存里的一份快照，用完即弃。
 *
 * aggregate() 是纯函数，不碰网络也不碰 Store，方便单独测。
 * ============================================================ */
window.Team = (function () {
  const S = window.Store;

  /* ---------- 纯函数：把扁平的记录行聚合成每个人一行 ----------
   * rows 形如 [{ user_id, kind, id, data, deleted, team_id }]
   * members 形如 [{ id, role, display_name }] */
  function aggregate(rows, members) {
    const byUser = {};
    (members || []).forEach(m => {
      byUser[m.id] = {
        id: m.id,
        name: m.display_name || String(m.id).slice(0, 8),
        role: m.role,
        customers: 0,
        openDeals: 0,
        openAmount: 0,
        wonThisMonth: 0,
        wonAmount: 0,
        lostThisMonth: 0,
        overdue: 0,
        followUps: 0,
        lastFollowAt: ''
      };
    });

    const mk = k => { if (!byUser[k]) byUser[k] = null; };
    const month = S.monthKey ? S.monthKey() : S.todayStr().slice(0, 7);
    const today = S.todayStr();

    (rows || []).forEach(r => {
      if (!r || r.deleted || !r.data) return;
      const u = byUser[r.user_id];
      if (!u) return;                      // 不是本队成员的行，跳过
      const d = r.data;

      if (r.kind === 'customers') {
        u.customers++;
        if (d.nextFollowAt && d.nextFollowAt < today) u.overdue++;
      } else if (r.kind === 'deals') {
        if (d.stage === 'won') {
          if ((d.closedAt || '').slice(0, 7) === month) {
            u.wonThisMonth++;
            u.wonAmount += Number(d.amount) || 0;
          }
        } else if (d.stage === 'lost') {
          if ((d.closedAt || '').slice(0, 7) === month) u.lostThisMonth++;
        } else {
          u.openDeals++;
          u.openAmount += Number(d.amount) || 0;
        }
      } else if (r.kind === 'followups') {
        u.followUps++;
        const at = String(d.at || '').slice(0, 10);
        if (at && at > u.lastFollowAt) u.lastFollowAt = at;
      }
    });

    const list = Object.values(byUser).filter(Boolean);
    /* 在谈金额多的排前面——这是最直观的「谁手上活最多」 */
    list.sort((a, b) => b.openAmount - a.openAmount || b.customers - a.customers);

    const total = {
      members: list.length,
      customers: list.reduce((n, x) => n + x.customers, 0),
      openDeals: list.reduce((n, x) => n + x.openDeals, 0),
      openAmount: list.reduce((n, x) => n + x.openAmount, 0),
      wonThisMonth: list.reduce((n, x) => n + x.wonThisMonth, 0),
      wonAmount: list.reduce((n, x) => n + x.wonAmount, 0),
      lostThisMonth: list.reduce((n, x) => n + x.lostThisMonth, 0),
      overdue: list.reduce((n, x) => n + x.overdue, 0),
      idle: list.filter(x => !x.lastFollowAt || daysSince(x.lastFollowAt) >= 3).length
    };

    return { rows: list, total: total, month: month };
  }

  function daysSince(dateStr) {
    const n = S.diffDays ? S.diffDays(dateStr) : null;
    return n === null ? 0 : -n;
  }

  /* ---------- 从云端拉全队记录（只有管理员调得动，RLS 保证） ---------- */
  async function load() {
    const A = window.Auth;
    if (!A || !A.isOn() || !A.isAdmin() || !A.teamId()) {
      return { rows: [], total: emptyTotal(), month: '', error: '没有权限或还没入队' };
    }
    let rows = [];
    let members = [];
    try {
      rows = await A.teamRecords();
      members = await A.teamMembers();
    } catch (e) {
      return { rows: [], total: emptyTotal(), month: '', error: e.message || '读取失败' };
    }
    return aggregate(rows, members);
  }

  function emptyTotal() {
    return {
      members: 0, customers: 0, openDeals: 0, openAmount: 0,
      wonThisMonth: 0, wonAmount: 0, lostThisMonth: 0, overdue: 0, idle: 0
    };
  }

  return { aggregate, load, emptyTotal };
})();
