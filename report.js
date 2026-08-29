/* ============================================================
 * 销冠助手 · 周报 / 复盘（纯本地计算，不依赖 AI）
 *
 * 为什么本地算，不丢给 AI：
 * 销售写周报真正的痛苦不是「不会写」，是「想不起来这周干了什么」。
 * 周会前十分钟翻聊天记录、翻 CRM，翻完还剩三分钟写。
 * 所以周报八成的价值是「把散落一周的动作自动归拢」——
 * 这件事本地手里就有全部数据，不需要联网、不需要 API Key，
 * 而且要的是确定：AI 会漏掉一条跟进，本地算术不会漏。
 *
 * AI 润色留作可选增强（见 ai.js 的 weekly 场景），
 * 那是「锦上添花」，不是「离了就瘫」。
 *
 * 另一个刻意的设计：不为凑版式写没有数据支撑的话。
 * 「需要领导支持」这种段落我没有数据，就不生成——
 * 让销售自己填，比替他编一句空话强。
 * ============================================================ */
window.Report = (function () {
  /* 用 window.Store 而不是裸 Store：这样纯 Node 环境下也能 require 进来跑测试，
   * 不必先起浏览器。前提是 store.js 先加载（index.html 里它排第一）。 */
  const S = window.Store;
  const DAY = 86400000;

  /* 商机多久没动算「冷住」。
   * 21 天是拍的，但有数字才有行动依据 —— 说「很久没联系」没人会动。
   * 对外导出，是为了让页面上的说明文字和这里的判定永远一致，
   * 不然改了一处忘了另一处，界面就会对用户撒谎。 */
  const STALE_DAYS = 21;

  /* ---------- 日期归一 ----------
   * 数据里同一个「时间」有三种写法，这是历史遗留：
   *   updatedAt  → 数字时间戳（Date.now()）
   *   at/closedAt/createdAt → ISO 字符串
   *   nextAt/nextFollowAt/expectedClose → YYYY-MM-DD
   * 不归一就比不出大小，周报会漏数据。 */
  function dayOf(v) {
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'number' && isFinite(v)) return S.fmtDate(new Date(v));
    const s = String(v);
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const d = new Date(s);
    return isNaN(d.getTime()) ? '' : S.fmtDate(d);
  }

  /* YYYY-MM-DD 是等宽格式，字典序 == 时间序，直接比字符串最省事也最不容易错 */
  function inRange(v, from, to) {
    const d = dayOf(v);
    if (!d) return false;
    return d >= from && d <= to;
  }

  /* ---------- 时间范围 ----------
   * 「本周」按中国人的习惯从周一起算，不是周日起算。
   * 周日报上去的周报如果少了周六周日两天，是要挨骂的。 */
  function mondayOf(base) {
    const d = new Date(base.getTime());
    d.setHours(0, 0, 0, 0);
    const off = d.getDay() === 0 ? -6 : 1 - d.getDay();
    d.setDate(d.getDate() + off);
    return d;
  }

  const RANGES = [
    { key: 'thisWeek', name: '本周' },
    { key: 'lastWeek', name: '上周' },
    { key: 'last7', name: '近 7 天' },
    { key: 'thisMonth', name: '本月' },
    { key: 'lastMonth', name: '上月' },
    { key: 'last30', name: '近 30 天' }
  ];

  /* 周一补上周五的周报是常态，所以「上周」必须能回看 */
  function rangeOf(key) {
    const now = new Date();
    const today = S.fmtDate(now);
    const mon = mondayOf(now);
    if (key === 'thisWeek') {
      return { key: key, from: S.fmtDate(mon), to: S.fmtDate(new Date(mon.getTime() + 6 * DAY)), name: '本周' };
    }
    if (key === 'lastWeek') {
      const m = new Date(mon.getTime() - 7 * DAY);
      return { key: key, from: S.fmtDate(m), to: S.fmtDate(new Date(m.getTime() + 6 * DAY)), name: '上周' };
    }
    if (key === 'last7') {
      return { key: key, from: S.addDays(today, -6), to: today, name: '近 7 天' };
    }
    if (key === 'thisMonth') {
      const y = now.getFullYear(), m = now.getMonth();
      return { key: key, from: S.fmtDate(new Date(y, m, 1)), to: S.fmtDate(new Date(y, m + 1, 0)), name: '本月' };
    }
    if (key === 'lastMonth') {
      const y = now.getFullYear(), m = now.getMonth();
      return { key: key, from: S.fmtDate(new Date(y, m - 1, 1)), to: S.fmtDate(new Date(y, m, 0)), name: '上月' };
    }
    return { key: 'last30', from: S.addDays(today, -29), to: today, name: '近 30 天' };
  }

  /* 跨了几天：周报里显示区间长度，一眼知道是不是漏填了一整周 */
  function spanDays(from, to) {
    const a = new Date(from + 'T00:00:00'), b = new Date(to + 'T00:00:00');
    return Math.round((b - a) / DAY) + 1;
  }

  /* 跟进正文压成一行，并截断。
   * 从聊天整理存进来的记录是多行的，直接塞进周报会把版面撑烂 */
  function oneLine(t, max) {
    const s = String(t || '').replace(/\s+/g, ' ').trim();
    return s.length > (max || 60) ? s.slice(0, max || 60) + '…' : s;
  }

  /* ============================================================
   * 汇总
   * ============================================================ */
  function build(key) {
    const r = rangeOf(key || 'thisWeek');
    const st = S.stats();
    const today = S.todayStr();

    const customers = S.list('customers');
    const deals = S.list('deals');
    const fus = S.list('followups');
    const scripts = S.list('scripts');

    /* 本周新增客户：createdAt 可能缺失，缺失就不算，不硬凑 */
    const newCustomers = customers.filter(c => inRange(c.createdAt, r.from, r.to));

    /* 本周跟进 */
    const fuIn = fus.filter(f => inRange(f.at, r.from, r.to));
    const covered = {};
    fuIn.forEach(f => { if (f.customerId) covered[f.customerId] = (covered[f.customerId] || 0) + 1; });
    const coveredIds = Object.keys(covered);

    /* 推进中的商机：区间内动过，且还没结束 */
    const advanced = deals.filter(d =>
      !['won', 'lost'].includes(d.stage) && inRange(d.updatedAt, r.from, r.to));

    const won = deals.filter(d => d.stage === 'won' && inRange(d.closedAt, r.from, r.to));
    const lost = deals.filter(d => d.stage === 'lost' && inRange(d.closedAt, r.from, r.to));

    /* 本周沉淀的话术 —— 这是「经验有没有攒下来」的量化，平时没人看，年底回看很有意思。
     * 必须排掉内置的种子话术：清空数据重装后，46 条种子的创建时间就是「刚刚」，
     * 不排掉的话，用户会在周报里看到「本周沉淀话术 46 条」——他一条都没写，
     * 这个数字不但没用，还会让人以为是自己记性出了问题。 */
    const newScripts = scripts.filter(s =>
      !s.builtin && inRange(s.createdAt || s.updatedAt, r.from, r.to));

    /* ---------- 重点客户 ----------
     * 本周跟进过的客户，按在谈金额降序。
     * 排序用金额不跟用跟进次数：跟了 8 次的小单，
     * 不配比跟 2 次的 30 万单子在周报里占更高位置。 */
    const hot = coveredIds.map(id => {
      const c = S.get('customers', id);
      if (!c) return null;
      const m = S.customerMeta(c);
      const mine = fuIn.filter(f => f.customerId === id)
        .sort((a, b) => String(b.at).localeCompare(String(a.at)));
      const openDeals = deals.filter(d => d.customerId === id && !['won', 'lost'].includes(d.stage));
      const top = openDeals.slice().sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0))[0];
      return {
        id: id,
        name: c.name,
        level: c.level,
        openAmount: m.openAmount,
        dealCount: openDeals.length,
        stage: top ? top.stage : '',
        stageName: top ? S.stageOf(top.stage).name : '',
        times: mine.length,
        lastAt: mine.length ? dayOf(mine[0].at) : '',
        lastText: mine.length ? oneLine(mine[0].content, 70) : ''
      };
    }).filter(Boolean).sort((a, b) => (b.openAmount || 0) - (a.openAmount || 0)).slice(0, 6);

    /* ---------- 欠账：该跟没跟的 ----------
     * 直接复用 stats().pending，别自己再算一遍 ——
     * 两处算法不一致时，用户会发现「战情台说 3 个，周报说 5 个」 */
    const owed = st.pending.map(p => {
      const c = p.c;
      return {
        id: c.id,
        name: c.name,
        dd: p.dd,
        at: c.nextFollowAt || '',
        amount: S.customerMeta(c).openAmount
      };
    }).sort((a, b) => (b.amount || 0) - (a.amount || 0)).slice(0, 8);

    /* ---------- 接下来 7 天要兑现的承诺 ----------
     * 来源是跟进记录里的 nextAt（我答应客户的），
     * 这是最容易忘、也最容易丢单的一类事 */
    const soonTo = S.addDays(today, 7);
    const next = [];
    const seenKey = {};
    fus.forEach(f => {
      const d = f.nextAt ? dayOf(f.nextAt) : '';
      if (!d || d < today || d > soonTo) return;
      const k = d + '|' + (f.customerId || '') + '|' + oneLine(f.content, 20);
      if (seenKey[k]) return;
      seenKey[k] = 1;
      next.push({
        at: d,
        name: S.customerName(f.customerId),
        id: f.customerId,
        text: oneLine(f.content, 50)
      });
    });
    customers.forEach(c => {
      const d = c.nextFollowAt ? dayOf(c.nextFollowAt) : '';
      if (!d || d <= today || d > soonTo) return;
      const k = d + '|' + c.id + '|plan';
      if (seenKey[k]) return;
      seenKey[k] = 1;
      next.push({ at: d, name: c.name, id: c.id, text: '计划跟进' });
    });
    next.sort((a, b) => a.at.localeCompare(b.at));

    /* ---------- 风险 ----------
     * 只报能算出来的。算不出来的不装作知道。 */
    const risks = [];

    /* 僵死商机：在谈但三周没动过。
     * 21 天是拍的，但比「很久没动」这种模糊提示有用——
     * 有数字才知道该不该今天打电话 */
    const stale = deals.filter(d => {
      if (['won', 'lost'].includes(d.stage)) return false;
      const last = dayOf(d.updatedAt) || dayOf(d.createdAt);
      if (!last) return false;
      const diff = Math.round((new Date(today + 'T00:00:00') - new Date(last + 'T00:00:00')) / DAY);
      return diff >= STALE_DAYS;
    }).map(d => ({
      id: d.id,
      custId: d.customerId,
      title: d.title,
      name: S.customerName(d.customerId),
      amount: Number(d.amount) || 0,
      days: Math.round((new Date(today + 'T00:00:00') - new Date((dayOf(d.updatedAt) || dayOf(d.createdAt) || today) + 'T00:00:00')) / DAY),
      stage: S.stageOf(d.stage).name
    })).sort((a, b) => b.amount - a.amount).slice(0, 5);

    if (stale.length) risks.push({ kind: 'stale', label: '冷住的商机', items: stale });

    if (lost.length) {
      risks.push({
        kind: 'lost', label: '这段时间丢的单',
        items: lost.map(d => ({
          id: d.id, custId: d.customerId, title: d.title, name: S.customerName(d.customerId),
          amount: Number(d.amount) || 0, reason: d.lostReason || '没填原因'
        }))
      });
    }

    if (owed.length) risks.push({ kind: 'owed', label: '该跟没跟', items: owed });

    /* 目标缺口只在还剩不到 10 天时才提醒 ——
     * 月初就喊「还差 80%」只会让人麻木，月底那一周才真正改变行为 */
    const left = S.daysLeftInMonth();
    if (st.rate < 1 && left <= 10) {
      risks.push({
        kind: 'target', label: '本月目标',
        items: [{
          title: `还差 ${S.moneyFull(st.target - st.revenue)}`,
          name: `剩 ${left} 天，完成 ${Math.round(st.rate * 100)}%`,
          amount: Math.max(0, st.target - st.revenue)
        }]
      });
    }

    const counts = {
      newCustomers: newCustomers.length,
      followCount: fuIn.length,
      covered: coveredIds.length,
      advanced: advanced.length,
      won: won.length,
      wonAmount: S.sum(won, d => Number(d.amount) || 0),
      lost: lost.length,
      lostAmount: S.sum(lost, d => Number(d.amount) || 0),
      scripts: newScripts.length
    };

    const empty = !counts.followCount && !counts.newCustomers && !counts.advanced
      && !counts.won && !counts.lost && !hot.length;

    return {
      key: r.key, name: r.name, from: r.from, to: r.to,
      span: spanDays(r.from, r.to),
      counts: counts, hot: hot, next: next, owed: owed, risks: risks, stale: stale,
      newCustomers: newCustomers, empty: empty, today: today
    };
  }

  /* ============================================================
   * 生成可直接发给领导的文字
   * 目标是「复制 → 粘贴 → 发送」，中间一个字都不用改。
   * ============================================================ */
  function toText(d) {
    const L = [];
    const c = d.counts;

    L.push(`【${d.name}工作小结】${d.from} ~ ${d.to}（${d.span} 天）`);
    L.push('');

    /* 一、做了什么：数字先行，领导扫一眼就够了 */
    const line = [];
    if (c.newCustomers) line.push(`新增客户 ${c.newCustomers} 家`);
    if (c.followCount) line.push(`跟进 ${c.followCount} 次`);
    if (c.covered) line.push(`覆盖 ${c.covered} 家客户`);
    if (c.advanced) line.push(`推进商机 ${c.advanced} 个`);
    if (c.won) line.push(`成交 ${c.won} 单 ${S.moneyFull(c.wonAmount)}`);
    if (c.lost) line.push(`丢单 ${c.lost} 单 ${S.moneyFull(c.lostAmount)}`);
    if (c.scripts) line.push(`沉淀话术 ${c.scripts} 条`);
    L.push('一、进展');
    L.push(line.length ? line.join('；') + '。' : '（这段时间没有录入动作）');
    L.push('');

    /* 二、重点客户：每家一句话，说清「到哪一步了、最近聊了什么」 */
    if (d.hot.length) {
      L.push('二、重点客户');
      d.hot.forEach(h => {
        let s = `· ${h.name}`;
        if (h.openAmount) s += `（在谈 ${S.moneyFull(h.openAmount)}${h.stageName ? '，' + h.stageName : ''}）`;
        s += `：本周跟进 ${h.times} 次`;
        if (h.lastText) s += `，最近一次：${h.lastText}`;
        L.push(s);
      });
      L.push('');
    }

    /* 三、下周计划：只列有日期的承诺，没日期的说了也是空话 */
    if (d.next.length) {
      L.push('三、下一步');
      d.next.slice(0, 10).forEach(n => {
        L.push(`· ${n.at} ${n.name}：${n.text}`);
      });
      L.push('');
    }

    /* 四、风险：这段才是周报里真正值钱的部分。
     * 前两段领导其实不怎么看，这段他自己会追问 */
    if (d.risks.length) {
      L.push('四、风险与需要关注');
      d.risks.forEach(r => {
        L.push(`· ${r.label}：` + r.items.map(it => {
          const nm = it.name ? it.name + ' ' : '';
          const amt = it.amount ? S.moneyFull(it.amount) : '';
          const why = it.days ? `${it.days} 天没动` : (it.reason || it.title || '');
          return `${nm}${amt}${why ? '（' + why + '）' : ''}`;
        }).join('；'));
      });
      L.push('');
    }

    return L.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  return { RANGES: RANGES, STALE_DAYS: STALE_DAYS, rangeOf: rangeOf, build: build, toText: toText,
    dayOf: dayOf, oneLine: oneLine, spanDays: spanDays };
})();
