/* ============================================================
 * 销冠助手 · 视图渲染层
 * ============================================================ */
window.Views = (function () {
  const S = Store;
  const E = S.escapeHtml;
  const C = Charts;

  /* 公共演示后端的地址。留空则设置页不显示「填入公共演示后端地址」按钮。
   * 自己有服务器后，把它改成你自己的地址，或者干脆清空。 */
  const PUBLIC_ENDPOINT = 'https://ac8e1b422b928c3a8.app.workbuddy.link/api/sync';

  /* ---------- 小组件 ---------- */
  function stageBadge(id) {
    const s = S.stageOf(id);
    return `<span class="badge" style="background:${s.color}">${s.name}</span>`;
  }
  function levelTag(id) {
    const l = S.levelOf(id);
    return `<span class="tag ${l.cls}">${l.name}</span>`;
  }
  function nextFollowCell(v) {
    if (!v) return '<span class="muted small">—</span>';
    const d = S.diffDays(v);
    const cls = d < 0 ? 'overdue' : d === 0 ? 'soon' : '';
    const tip = d < 0 ? `（逾期 ${-d} 天）` : d === 0 ? '（今天）' : `（${d} 天后）`;
    return `<span class="${cls} small">${S.fmtDate(v)}<br>${tip}</span>`;
  }
  function kpi(label, value, foot, footCls) {
    return `<div class="kpi"><span class="k-label">${E(label)}</span>
      <span class="k-value">${value}</span>
      ${foot ? `<span class="k-foot ${footCls || ''}">${foot}</span>` : ''}</div>`;
  }
  function emptyBox(text, btn) {
    return `<div class="empty">${E(text)}${btn ? '<br><br>' + btn : ''}</div>`;
  }

  /* ============================================================
   * 1. 战情台（仪表盘）
   * ============================================================ */
  function dash() {
    const st = S.stats();
    const s = S.state.settings;
    const f = st.forecast;

    /* 待跟进提醒 */
    const remindList = st.pending.slice(0, 8).map(({ c, dd }) => {
      const od = dd < 0;
      return `<div class="remind ${od ? 'od' : ''}">
        <div class="r-main">
          <div class="r-name">${E(c.name)} <span class="muted small">· ${E(c.contact || '未填联系人')}</span></div>
          <div class="r-meta">${E(c.phone || '')} ${c.wechat ? '微信 ' + E(c.wechat) + ' · ' : ''}${od ? `<span class="overdue">逾期 ${-dd} 天</span>` : '今天该联系'}</div>
        </div>
        <div class="mobile-actions" style="gap:4px;margin:0">
          ${c.phone ? `<a class="btn btn-sm" href="tel:${E(c.phone)}">电话</a>` : ''}
          ${c.wechat ? `<button class="btn btn-sm" data-action="copy-wechat" data-id="${c.id}">微信</button>` : ''}
          <button class="btn btn-sm" data-action="log-followup" data-id="${c.id}">跟进</button>
        </div>
      </div>`;
    }).join('');

    /* 漏斗 */
    const funnelItems = st.funnel.map(f => ({ name: f.name, value: f.count, color: f.color, amount: f.amount }));
    const monthWonCount = S.state.deals.filter(d => d.stage === 'won' && S.monthKey(d.closedAt) === st.mk).length;

    /* 本月目标卡片 */
    const gaptxt = st.rate >= 1
      ? `已超额 ${S.moneyFull(st.revenue - st.target)}`
      : `还差 ${S.moneyFull(st.target - st.revenue)}，剩 ${daysLeftInMonth()} 天`;

    return `
    ${morningBrief()}

    ${window.QuickLog ? QuickLog.box() : ''}

    <div class="grid g4">
      <div class="card">
        <div class="card-head"><div class="card-title">本月目标<span class="card-sub">${E(S.monthFullLabel())}</span></div></div>
        <div style="display:flex;align-items:center;gap:16px">
          <div style="flex:0 0 auto">${C.ring(st.rate, { size: 118, sub: '完成率' })}</div>
          <div style="flex:1;min-width:0">
            <div class="kpi"><span class="k-label">已回款</span>
              <span class="k-value" style="font-size:20px">${S.moneyFull(st.revenue)}</span>
              <span class="k-foot">目标 ${S.moneyFull(st.target)}</span></div>
            <div class="small muted" style="margin-top:6px">${E(gaptxt)}</div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div class="card-title">待跟进<span class="card-sub">今天该打给谁</span></div></div>
        <div style="display:flex;gap:14px;margin-bottom:12px">
          <div><div class="k-value" style="font-size:22px;color:${st.overdue.length ? 'var(--red)' : 'inherit'}">${st.overdue.length}</div><div class="k-label">已逾期</div></div>
          <div><div class="k-value" style="font-size:22px">${st.todayDue.length}</div><div class="k-label">今天到期</div></div>
          <div><div class="k-value" style="font-size:22px">${st.pending.length}</div><div class="k-label">合计</div></div>
        </div>
        <button class="btn btn-sm btn-block" data-action="goto-followups">查看全部待跟进 →</button>
      </div>

      <div class="card">
        <div class="card-head"><div class="card-title">在谈商机<span class="card-sub">加权预测</span></div></div>
        ${kpi('在谈总额', S.moneyFull(st.openAmount), `${st.counts.open} 个未关闭商机`)}
        <div style="margin-top:10px"></div>
        ${kpi('加权预测', '¥' + S.money(st.weighted), '按各阶段赢率折算')}
      </div>

      <div class="card">
        <div class="card-head"><div class="card-title">核心指标</div></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          ${kpi('赢单率', Math.round(st.winRate * 100) + '%', `赢 ${st.counts.won} / 输 ${st.counts.lost}`)}
          ${kpi('客单价', '¥' + S.money(st.avgDeal), '成交订单平均')}
          ${kpi('成交周期', st.avgCycle + ' 天', '从建单到签单')}
          ${kpi('本季累计', '¥' + S.money(st.quarterRevenue), '季度回款')}
        </div>
      </div>
    </div>

    ${healthCard()}

    <div class="grid g21">
      <div class="card">
        <div class="card-head">
          <div class="card-title">近 6 个月业绩<span class="card-sub">按签单日期统计</span></div>
          <div class="small muted">本月已签 ${monthWonCount} 单</div>
        </div>
        <div class="chart-wrap">${C.line(st.months)}</div>
      </div>

      <div class="card">
        <div class="card-head"><div class="card-title">销售漏斗<span class="card-sub">各阶段商机数</span></div></div>
        <div class="chart-wrap">${C.hbar(funnelItems, { right: it => S.money(it.amount) })}</div>
        <div class="legend" style="margin-top:10px">
          <span><i style="background:#16a34a"></i>已赢单 ${S.money(st.wonFunnel.amount)}（${st.wonFunnel.count} 单）</span>
        </div>
      </div>
    </div>

    <div class="grid g21">
      <div class="card">
        <div class="card-head">
          <div class="card-title">今日作战清单<span class="card-sub">逾期优先</span></div>
          <span class="small muted">点击「记跟进」自动顺延下次联系</span>
        </div>
        ${remindList || emptyBox('太干净了，今天没有到期的跟进。要不要主动捞几个 A 级客户？', '<button class="btn btn-primary btn-sm" data-action="goto-customers">去客户库</button>')}
      </div>

      <div class="card">
        <div class="card-head"><div class="card-title">客户分级<span class="card-sub">A 级要重点盯</span></div></div>
        <div class="chart-wrap">${C.hbar(st.byLevel.map(l => ({ name: l.name, value: l.count, color: l.color })), { right: it => it.value + ' 家' })}</div>
        <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line)">
          <div class="small muted">本月新增客户</div>
          <div class="k-value" style="font-size:20px">${st.newCustomers} 家</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <div class="card-title">本月冲刺提示</div>
        <span class="small muted">数据来自你的商机看板</span>
      </div>
      <div class="grid g3">
        <div class="card" style="margin:0;background:${f.verdict === 'done' || f.verdict === 'on-track' ? '#f0fdf4' : '#fff8f1'};border-color:#f1f5f9">
          ${kpi('保守预计', S.moneyFull(f.conservative), '逐单按阶段赢率 × 本月内成交概率折算',
            f.verdict === 'done' || f.verdict === 'on-track' ? 'up' : '')}
        </div>
        <div class="card" style="margin:0;background:#f8fafc;border-color:#f1f5f9">
          ${kpi('乐观上限', S.moneyFull(f.optimistic), '本月内到期的金额，不打折')}
        </div>
        <div class="card" style="margin:0;background:#f8fafc;border-color:#f1f5f9">
          ${kpi('预计提成', '¥' + S.money(st.revenue * (Number(s.commissionRate) || 0) / 100), '按 ' + (s.commissionRate || 0) + '% 提成比例估算')}
        </div>
      </div>
      <div class="hint" style="margin-top:10px">
        ${E(f.learned > 0
          ? `阶段赢率是从你自己 ${f.learned} 个阶段的成交记录里学出来的，新数据进来会自动更新。`
          : '阶段赢率暂用通用档位（线索 10% / 接触 25% / 方案 45% / 报价 65% / 谈判 80%）。等你积累够「有输有赢」的成交记录，会自动换成你自己的真实赢率。')}
        给区间不给单点，是因为销售要的是「大概能拿多少」，不是一个假精确的数字。
        ${f.noDate ? `<br><span class="b-amber">有 ${f.noDate} 个在谈商机<b>没填预计成交日</b>，这部分只能按最低概率估算——补上日期，预测会准不少。</span>` : ''}
      </div>
    </div>`;
  }

  function daysLeftInMonth() {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() - d.getDate();
  }

  /* ============================================================
   * 0. 每日晨报
   * 定位是「导航」不是「又一张列表」：销售早上打开只需要三件事——
   * 今天有几件事、最紧急的是哪件、这个月还行不行。
   * 详情一律交给下面的卡片，这里不重复铺开，否则就是噪音。
   * ============================================================ */
  function morningBrief() {
    const st = S.stats();
    const H = window.Health;
    const att = H ? H.attention() : [];
    const f = st.forecast;
    const d = new Date();
    const wk = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    const dateLine = `${d.getMonth() + 1} 月 ${d.getDate()} 日 周${wk} · 本月剩 ${f.left} 天`;

    /* 计数摘要：只报数，不展开 */
    const bits = [];
    if (st.overdue.length) bits.push(`<b class="b-red">${st.overdue.length}</b> 个跟进逾期`);
    else if (st.todayDue.length) bits.push(`<b>${st.todayDue.length}</b> 个今天到期`);
    else bits.push('没有到期的跟进');
    if (att.length) bits.push(`<b class="${att.some(x => x.h.level === 'risk') ? 'b-red' : 'b-amber'}">${att.length}</b> 个商机要盯`);
    else bits.push('商机节奏都正常');

    const GOAL = {
      done: { cls: 'b-green', text: '本月目标已达成' },
      'on-track': { cls: 'b-green', text: `缺口 ${S.moneyFull(f.gap)}，现有弹药够` },
      tight: { cls: 'b-amber', text: `缺口 ${S.moneyFull(f.gap)}，有点悬` },
      unlikely: { cls: 'b-red', text: `缺口 ${S.moneyFull(f.gap)}，大概率来不及` }
    };
    const goal = GOAL[f.verdict] || GOAL['on-track'];

    /* 紧急度打分：光看逾期天数会排错顺序——
     * 逾期 1 天的 A 级客户（100 万在谈）比逾期 30 天的 C 级（5 万）急得多。 */
    const urgency = (c, dd) => {
      const meta = S.customerMeta(c);
      const lv = c.level === 'A' ? 10 : c.level === 'B' ? 4 : 0;
      const ov = Math.max(0, -dd);
      /* 逾期天数用分段而不是线性乘以天数：线性会让"拖了 25 天的 C 级小单"
       * 压过"刚逾期 1 天的 A 级大单"。而销售的真实判断是——
       * 刚逾期最该补，拖过一个月的基本已经凉了，优先级反而要降。 */
      const ovScore = ov === 0 ? 6 : ov <= 7 ? 8 : ov <= 14 ? 6 : ov <= 30 ? 4 : 2;
      const amt = Math.min((meta.openAmount || 0) / 100000, 6);        // 每 10 万 +1，封顶 6
      return lv + ovScore + amt;
    };
    const dealUrgency = h => {
      const c = S.get('customers', h.customerId);
      const lv = c && c.level === 'A' ? 6 : c && c.level === 'B' ? 2 : 0;
      const risk = (100 - h.score) / 10;                               // 越不健康越急
      const amt = Math.min(h.amount / 100000, 5);
      return lv + risk + amt;
    };

    /* 最紧急的一件事：逾期跟进优先于商机，因为前者是"已经答应过人家的" */
    let top = null;
    if (st.pending.length) {
      const ranked = st.pending.slice().sort((a, b) => urgency(b.c, b.dd) - urgency(a.c, a.dd));
      const { c, dd } = ranked[0];
      top = {
        label: dd < 0 ? `逾期 ${-dd} 天` : '今天到期',
        title: `${c.name} · ${c.contact || '未填联系人'}`,
        sub: c.phone || '',
        urgent: dd < 0,
        btns: (c.phone ? `<a class="btn btn-sm btn-primary" href="tel:${E(c.phone)}">打电话</a>` : '') +
          `<button class="btn btn-sm" data-action="log-followup" data-id="${c.id}">记跟进</button>`
      };
    } else if (att.length) {
      const rankedDeals = att.slice().sort((a, b) => dealUrgency(b.h) - dealUrgency(a.h));
      const { deal, h } = rankedDeals[0];
      const act = h.nextAction;
      top = {
        label: H.metaOf(h.level).name,
        title: `${h.customer} · ${h.title}`,
        sub: act ? act.action : '',
        urgent: h.level === 'risk',
        btns: act
          ? `<button class="btn btn-sm btn-primary" data-action="health-act" data-id="${deal.id}">${healthBtnText(act)}</button>`
          : `<button class="btn btn-sm" data-action="goto-deals">去看板</button>`
      };
    }

    return `
    <div class="card brief">
      <div class="brief-top">
        <div class="brief-date">${E(dateLine)}</div>
        <div class="brief-line">${bits.join(' · ')} <span class="b-sep">|</span> <span class="${goal.cls}">${E(goal.text)}</span></div>
        ${f.verdict !== 'done' && f.advice ? `<div class="brief-advice">${E(f.advice)}</div>` : ''}
      </div>
      ${top ? `<div class="brief-do">
        <div class="bd-label ${top.urgent ? 'b-red' : ''}">${E(top.label)}</div>
        <div class="bd-main">
          <div class="bd-title">${E(top.title)}</div>
          ${top.sub ? `<div class="bd-sub">${E(top.sub)}</div>` : ''}
        </div>
        <div class="bd-btns">${top.btns}</div>
      </div>` : `<div class="brief-do brief-clean">
        今天没有必须处理的事。<span class="muted">主动捞两个 A 级客户，比等电话强。</span>
      </div>`}
    </div>`;
  }

  /* ============================================================
   * 1.5 商机健康度
   * 语气刻意做成「提醒」而不是「警告」：销售最烦被工具当监工。
   * 每条都必须给一个今天就能做的动作，并且能一键忽略 —— 掌控感在销售手里。
   * ============================================================ */
  function healthCard(limit) {
    if (!window.Health) return '';
    const H = window.Health;
    const cfg = H.settings();
    if (!cfg.enabled) {
      return `<div class="card">
        <div class="card-head"><div class="card-title">商机健康度<span class="card-sub">已关闭</span></div>
        <button class="btn btn-sm" data-action="goto-settings">去设置开启</button></div>
        <div class="empty">健康度提醒已关闭。开启后，工具会根据你自己的成交节奏，标出可能凉掉的商机。</div>
      </div>`;
    }

    const att = H.attention();
    const n = limit || 4;
    const rows = att.slice(0, n).map(({ deal, h }) => {
      const meta = H.metaOf(h.level);
      // 只显示最主要的两条原因，写太多就没人读了
      const why = h.reasons.slice(0, 2).map(r => E(r.text)).join(' · ');
      const act = h.nextAction;
      const btnText = healthBtnText(act);
      return `<div class="hrow ${meta.cls}">
        <span class="hdot" style="background:${meta.dot}"></span>
        <div class="h-main">
          <div class="h-title">${E(h.customer)} <span class="muted">·</span> ${E(h.title)}
            <span class="h-amt">${S.moneyFull(h.amount)}</span></div>
          <div class="h-why">${why}</div>
          ${act ? `<div class="h-act">下一步：${E(act.action)}</div>` : ''}
        </div>
        <div class="h-btns">
          ${act ? `<button class="btn btn-sm btn-primary" data-action="health-act" data-id="${deal.id}">${btnText}</button>` : ''}
          <button class="btn btn-sm" data-action="health-snooze" data-id="${deal.id}" title="${cfg.snoozeDays} 天内不再提示">知道了</button>
        </div>
      </div>`;
    }).join('');

    /* 判断依据要说清楚：工具凭什么这么说。
     * 说不清依据的评分，销售看两次就不信了。 */
    const bl = H.baseline();
    const basisText = '判断依据：' + healthBasisText() +
      (bl.learned > 0 ? '新数据进来会自动更新。' : '积累 3 单以上带阶段变化的成交后，会自动换成你自己的节奏。');

    const ignored = H.all().filter(x => x.h.level === 'snoozed').length;

    return `
    <div class="card">
      <div class="card-head">
        <div class="card-title">该盯一盯的商机<span class="card-sub">${att.length ? att.length + ' 个需要动作' : '全部正常'}</span></div>
        <div class="row-actions">
          ${ignored ? `<span class="small muted">已忽略 ${ignored} 个</span>` : ''}
          <button class="link" data-action="goto-deals">去看板 →</button>
        </div>
      </div>
      ${rows || `<div class="empty">在谈的商机都在正常节奏上，没有需要盯的。<br><span class="small">A 级客户建议主动捞一捞，别等出了问题再看。</span></div>`}
      <div class="h-foot">
        <span class="small muted">${E(basisText)}</span>
        <button class="link small" data-action="health-tune">调整松紧</button>
      </div>
    </div>`;
  }

  /* 健康度判断依据的口径说明：跟用户说实话，别让人以为工具在拍脑袋 */
  function healthBasisText() {
    if (!window.Health) return '';
    const bl = window.Health.baseline();
    if (bl.learned > 0) {
      const detail = Object.keys(bl.stage).map(k =>
        `${S.stageOf(k).name} ${Math.round(bl.stage[k])} 天`).join('、');
      return `已按你的成交记录学到 ${bl.learned} 个阶段的基准（${detail}）。`;
    }
    return '目前成交样本还不够，暂按客户分级的通用节奏判断；';
  }

  /* 动作按钮的文案。区分终态是必要的：
   * 「推进一步」和「要签了」是两种心理预期，点错了会很恼火。 */
  function healthBtnText(act) {
    if (!act) return '去处理';
    if (act.actionType === 'stage') {
      if (act.nextStage === 'won') return '要签了';
      if (act.nextStage === 'lost') return '标记输单';
      return '推进一步';
    }
    if (act.actionType === 'follow') return '记跟进';
    return '改一下';
  }

  /* 商机卡片上的健康度小标记（看板用）：不占地方，但一眼能看出哪张牌有问题 */
  function healthDot(deal) {
    if (!window.Health) return '';
    const h = window.Health.of(deal);
    if (h.level === 'good' || h.level === 'closed' || h.level === 'off') return '';
    const meta = window.Health.metaOf(h.level);
    const tip = h.reasons.slice(0, 2).map(r => r.text).join('；') || meta.name;
    return `<span class="hmark ${meta.cls}" title="${E(tip)}" style="background:${meta.dot}">${meta.name}</span>`;
  }

  /* ============================================================
   * 2. 客户库
   * ============================================================ */
  function customers(ctx) {
    const q = (ctx.q || '').trim().toLowerCase();
    let rows = S.list('customers').slice();

    if (q) {
      rows = rows.filter(c =>
        [c.name, c.contact, c.phone, c.wechat, c.industry, c.note, c.tags]
          .join(' ').toLowerCase().includes(q));
    }
    if (ctx.level) rows = rows.filter(c => c.level === ctx.level);
    if (ctx.status) rows = rows.filter(c => c.status === ctx.status);

    const sort = ctx.sort || 'next';
    rows.sort((a, b) => {
      if (sort === 'level') return (a.level || 'Z').localeCompare(b.level || 'Z');
      if (sort === 'amount') return S.customerMeta(b).openAmount - S.customerMeta(a).openAmount;
      if (sort === 'recent') return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
      const av = a.nextFollowAt || '9999', bv = b.nextFollowAt || '9999';
      return av.localeCompare(bv);
    });

    const statusOptions = ['<option value="">全部状态</option>'].concat(
      S.CUSTOMER_STATUS.map(s => `<option value="${s}" ${ctx.status === s ? 'selected' : ''}>${s}</option>`)).join('');
    const levelOptions = ['<option value="">全部分级</option>'].concat(
      S.LEVELS.map(l => `<option value="${l.id}" ${ctx.level === l.id ? 'selected' : ''}>${l.name}</option>`)).join('');

    const mobileContact = c => `
      <div class="mobile-actions">
        ${c.phone ? `<a class="btn btn-sm" href="tel:${E(c.phone)}">打电话</a>` : ''}
        ${c.wechat ? `<button class="btn btn-sm" data-action="copy-wechat" data-id="${c.id}">复制微信号</button>` : ''}
      </div>`;

    const body = rows.map(c => {
      const m = S.customerMeta(c);
      return `<tr>
        <td data-label="客户">
          <div>
            <div style="display:flex;align-items:center;gap:8px">
              ${levelTag(c.level)}
              <a href="#" data-action="open-customer" data-id="${c.id}"><strong>${E(c.name)}</strong></a>
            </div>
            <span class="sub">${E(c.industry || '—')} · 来源：${E(c.source || '—')}</span>
          </div>
          ${mobileContact(c)}
        </td>
        <td data-label="联系人">${E(c.contact || '—')}<span class="sub">${E(c.title || '')}</span></td>
        <td data-label="联系方式">
          <div>
            ${E(c.phone || '—')}
            <span class="sub">${E(c.wechat ? '微信 ' + c.wechat : '')}</span>
          </div>
          ${mobileContact(c)}
        </td>
        <td data-label="下次跟进" class="nowrap">${nextFollowCell(c.nextFollowAt)}</td>
        <td data-label="在谈金额" class="right mono">${m.openAmount ? S.moneyFull(m.openAmount) : '<span class="muted">—</span>'}
          <span class="sub">${m.dealCount} 个商机</span></td>
        <td data-label="已成交" class="right mono">${m.wonAmount ? S.moneyFull(m.wonAmount) : '<span class="muted">—</span>'}</td>
        <td data-label="状态"><span class="tag">${E(c.status || '潜在')}</span></td>
        <td data-label="最近跟进" class="nowrap">${E(m.lastFollow ? S.fmtDate(m.lastFollow) : '未跟进')}
          <span class="sub">共 ${m.followCount} 次</span></td>
        <td data-label="操作" class="right nowrap">
          <div class="row-actions">
            <a class="btn btn-sm" href="tel:${E(c.phone || '')}" style="${c.phone ? '' : 'display:none'}">电话</a>
            <button class="btn btn-sm" data-action="log-followup" data-id="${c.id}">跟进</button>
            <button class="btn btn-sm" data-action="edit-customer" data-id="${c.id}">编辑</button>
            <button class="link danger" data-action="del-customer" data-id="${c.id}">删除</button>
          </div>
        </td>
      </tr>`;
    }).join('');

    return `
    <div class="card">
      <div class="card-head">
        <div class="card-title">客户库<span class="card-sub">共 ${rows.length} 家${q ? `（搜索「${E(q)}」）` : ''}</span></div>
        <div class="spacer"></div>
        <button class="btn btn-sm" data-action="export-csv">导出 CSV</button>
        <button class="btn btn-primary btn-sm" data-action="new-customer">+ 新增客户</button>
      </div>
      <div class="toolbar">
        <input id="c-search" placeholder="搜索客户/联系人/电话" value="${E(ctx.q || '')}">
        <select id="c-level">${levelOptions}</select>
        <select id="c-status">${statusOptions}</select>
        <select id="c-sort">
          <option value="next" ${sort === 'next' ? 'selected' : ''}>按跟进日期</option>
          <option value="level" ${sort === 'level' ? 'selected' : ''}>按分级（A→C）</option>
          <option value="amount" ${sort === 'amount' ? 'selected' : ''}>按在谈金额</option>
          <option value="recent" ${sort === 'recent' ? 'selected' : ''}>按建档时间</option>
        </select>
        ${q || ctx.level || ctx.status ? '<button class="btn btn-sm" data-action="clear-filter">清除筛选</button>' : ''}
      </div>
      <div style="overflow:auto">
        <table class="rtable">
          <thead><tr>
            <th style="min-width:200px">客户</th><th>联系人</th><th>联系方式</th><th>下次跟进</th>
            <th class="right">在谈金额</th><th class="right">已成交</th><th>状态</th><th>最近跟进</th><th></th>
          </tr></thead>
          <tbody>${body || `<tr><td colspan="9">${emptyBox('还没有客户，先建档或载入示例数据')}</td></tr>`}</tbody>
        </table>
      </div>
    </div>`;
  }

  /* 客户详情 */
  /* 「此刻该说什么」——把话术推到销售眼前，而不是等他来搜。
   *
   * 放在客户详情页最上面（紧跟在打电话/记跟进那排按钮之后）：
   * 客户来电话，销售点开详情是想**看一眼就走**，
   * 放在下面等于没有。他不会滚。
   *
   * 三条是硬上限。销售点开详情是想确认这人是谁，不是来读文章的，
   * 给十条等于一条都不给。
   *
   * 每条都带一句"为什么给你这条"。这条原则在健康度模块就定了：
   * 工具必须能解释自己，否则销售看两次就不信了。 */
  function coachBox(c) {
    if (!window.Coach) return '';
    let r;
    try { r = window.Coach.suggest(c.id); }
    catch (e) { return ''; }   // 推荐是锦上添花，绝不能因为它报错就让详情页打不开
    if (!r || !r.items || !r.items.length) return '';

    const rows = r.items.map((it, i) => {
      const s = it.s;
      return `<div class="coach-item">
        <div class="coach-top">
          <button class="coach-t" data-action="coach-toggle" data-idx="${i}">
            <span class="coach-cat">${E(s.category || '话术')}</span>
            <span class="coach-title">${E(s.title || '未命名')}</span>
            ${it.mine ? '<span class="coach-mine">你记的</span>' : ''}
          </button>
          <button class="btn btn-sm" data-action="copy-script" data-id="${E(s.id)}">复制</button>
        </div>
        ${it.why ? `<div class="coach-why">${E(it.why)}</div>` : ''}
        <div class="coach-body" id="coach-body-${i}" hidden>${E(s.content || '').replace(/\n/g, '<br>')}</div>
      </div>`;
    }).join('');

    return `<div class="coach">
      <div class="coach-head">
        <span class="coach-flag">此刻该说什么</span>
        <span class="coach-scene">${E(r.sceneText || '')}</span>
      </div>
      <div class="coach-list">${rows}</div>
    </div>`;
  }

  function customerDetail(c) {
    const m = S.customerMeta(c);
    const deals = S.list('deals').filter(d => d.customerId === c.id);
    const fus = S.list('followups').filter(f => f.customerId === c.id).sort((a, b) => String(b.at).localeCompare(String(a.at)));

    const quickActions = `
      <div class="mobile-actions" style="display:flex;margin-bottom:14px">
        ${c.phone ? `<a class="btn btn-sm" href="tel:${E(c.phone)}">打电话</a>` : ''}
        ${c.wechat ? `<button class="btn btn-sm" data-action="copy-wechat" data-id="${c.id}">复制微信号</button>` : ''}
        <button class="btn btn-sm" data-action="log-followup" data-id="${c.id}">记跟进</button>
        <button class="btn btn-sm" data-action="new-deal" data-id="${c.id}">建商机</button>
      </div>`;

    const stageSelect = d => `<select class="stage-sel" data-id="${d.id}">
      ${S.STAGES.map(s2 => `<option value="${s2.id}" ${d.stage === s2.id ? 'selected' : ''}>${s2.name}</option>`).join('')}
    </select>`;

    const dealRows = deals.map(d => `<tr>
      <td data-label="商机"><a href="#" data-action="edit-deal" data-id="${d.id}">${E(d.title)}</a>
        ${d.lostReason ? `<span class="sub" style="color:var(--red)">输单原因：${E(d.lostReason)}</span>` : ''}</td>
      <td data-label="阶段">${stageBadge(d.stage)}<br>${stageSelect(d)}</td>
      <td data-label="金额" class="right mono">${S.moneyFull(d.amount)}</td>
      <td data-label="预计成交" class="nowrap small">${E(d.expectedClose ? S.fmtDate(d.expectedClose) : '—')}</td>
      <td data-label="备注" class="small muted">${E(d.note || '')}</td>
    </tr>`).join('');

    const tl = fus.map(f => `<div class="tl-item">
      <div class="tl-head"><strong>${E(f.type)}</strong><span class="tl-time">${E(S.fmtDateTime(f.at))}</span></div>
      <div class="tl-body">${E(f.content)}</div>
    </div>`).join('');

    return `
    <div class="modal-head">
      <h3>${E(c.name)} ${levelTag(c.level)} <span class="tag">${E(c.status)}</span></h3>
      <button class="x-btn" data-action="close-modal">×</button>
    </div>
    <div class="modal-body">
      <div class="grid g2" style="gap:10px 16px;margin-bottom:14px">
        <div><span class="muted small">联系人</span><div>${E(c.contact || '—')} ${E(c.title || '')}</div></div>
        <div><span class="muted small">联系电话</span><div>${E(c.phone || '—')}</div></div>
        <div><span class="muted small">微信</span><div>${E(c.wechat || '—')}</div></div>
        <div><span class="muted small">行业 / 来源</span><div>${E(c.industry || '—')} / ${E(c.source || '—')}</div></div>
        <div><span class="muted small">下次跟进</span><div>${E(c.nextFollowAt ? S.fmtDate(c.nextFollowAt) : '未设置')}</div></div>
        <div><span class="muted small">建档时间</span><div>${E(S.fmtDate(c.createdAt))}</div></div>
      </div>
      ${quickActions}
      ${coachBox(c)}
      ${c.note ? `<div class="muted small">备注</div><div class="tl-body" style="margin-bottom:14px">${E(c.note)}</div>` : ''}

      <div class="section-title">商机（${deals.length}）</div>
      ${deals.length ? `<table class="rtable"><thead><tr><th>商机</th><th>阶段</th><th class="right">金额</th><th>预计成交</th><th>备注</th></tr></thead><tbody>${dealRows}</tbody></table>`
        : emptyBox('还没有关联商机')}
      <button class="btn btn-sm" data-action="new-deal" data-id="${c.id}" style="margin:10px 0 18px">+ 为这家客户建商机</button>

      <div class="section-title">跟进记录（${fus.length}）</div>
      <div class="timeline">${tl || emptyBox('一条记录都没有，赶紧打第一个电话')}</div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-danger" data-action="del-customer" data-id="${c.id}">删除客户</button>
      <div class="spacer"></div>
      <button class="btn" data-action="edit-customer" data-id="${c.id}">编辑</button>
      <button class="btn" data-action="digest" data-id="${c.id}">整理聊天记录</button>
      <button class="btn btn-primary" data-action="log-followup" data-id="${c.id}">记一笔跟进</button>
    </div>`;
  }

  /* ============================================================
   * 3. 商机看板
   * ============================================================ */
  function deals() {
    const all = S.list('deals');
    const stageSelect = (d, cls) => `<select class="${cls}" data-id="${d.id}">
      ${S.STAGES.map(s2 => `<option value="${s2.id}" ${d.stage === s2.id ? 'selected' : ''}>${s2.name}</option>`).join('')}
    </select>`;

    // 桌面拖拽看板
    const columns = S.STAGES.map(s => {
      const arr = all.filter(d => d.stage === s.id);
      const amount = S.sum(arr, d => d.amount);
      const cards = arr.map(d => {
        const c = S.get('customers', d.customerId);
        const dd = S.diffDays(d.expectedClose);
        const late = dd !== null && dd < 0 && d.stage !== 'won';
        return `<div class="deal" draggable="true" data-deal="${d.id}">
          <div class="d-title">${E(d.title)} ${healthDot(d)}</div>
          <div class="muted small">${E(c ? c.name : '未知客户')} · ${E(c && c.contact ? c.contact : '')}</div>
          <div class="d-amount">${S.moneyFull(d.amount)}</div>
          <div class="d-meta">
            <span class="${late ? 'overdue' : ''}">${E(d.expectedClose ? S.fmtDate(d.expectedClose) : '未定')}${late ? ' 已过期' : ''}</span>
            <span>赢率 ${s.prob}%</span>
          </div>
          <div class="d-meta" style="margin-top:8px">
            ${stageSelect(d, 'stage-sel')}
            <button class="link" data-action="edit-deal" data-id="${d.id}">编辑</button>
            <button class="link" data-action="log-followup" data-id="${d.customerId}">跟进</button>
          </div>
        </div>`;
      }).join('');

      return `<div class="col" data-stage="${s.id}">
        <div class="col-head">
          <span class="col-name"><span class="dot-ind" style="background:${s.color}"></span>${s.name}
            <span class="muted" style="margin-left:6px">${arr.length}</span></span>
          <span class="small muted">赢率 ${s.prob}%</span>
        </div>
        <div class="col-sum">${S.moneyFull(amount)}</div>
        ${cards || `<div class="col-empty">${s.id === 'won' ? '赢单拖到这里，自动计入业绩' : s.id === 'lost' ? '输单拖到这里，记得补原因' : '把商机拖到这里'}</div>`}
      </div>`;
    }).join('');

    // 移动端列表化看板（触屏不支持 HTML5 DnD）
    const mboard = `<div class="mboard">${S.STAGES.map(s => {
      const arr = all.filter(d => d.stage === s.id);
      if (!arr.length) return '';
      const amount = S.sum(arr, d => d.amount);
      return `<div class="mstage">
        <div class="mstage-head"><span><span class="dot-ind" style="background:${s.color}"></span>${s.name}</span>
          <span>${arr.length} 个 · ${S.moneyFull(amount)} · 赢率 ${s.prob}%</span></div>
        ${arr.map(d => {
          const c = S.get('customers', d.customerId);
          const dd = S.diffDays(d.expectedClose);
          const late = dd !== null && dd < 0 && d.stage !== 'won';
          return `<div class="mdeal">
            <div class="m-title">${E(d.title)} ${healthDot(d)}</div>
            <div class="muted small">${E(c ? c.name : '未知客户')} · ${E(c && c.contact ? c.contact : '')}</div>
            <div class="m-meta">
              <span class="d-amount">${S.moneyFull(d.amount)}</span>
              <span class="${late ? 'overdue' : ''}">${E(d.expectedClose ? S.fmtDate(d.expectedClose) : '未定')}${late ? ' 已过期' : ''}</span>
            </div>
            <div class="m-row">
              ${stageSelect(d, 'mstage-sel')}
              <div class="row-actions">
                <button class="link" data-action="edit-deal" data-id="${d.id}">编辑</button>
                <button class="link" data-action="log-followup" data-id="${d.customerId}">跟进</button>
              </div>
            </div>
          </div>`;
        }).join('')}
      </div>`;
    }).join('') || emptyBox('还没有商机')}</div>`;

    const wonAmount = S.sum(all.filter(d => d.stage === 'won'), d => d.amount);
    const lostAmount = S.sum(all.filter(d => d.stage === 'lost'), d => d.amount);

    return `
    <div class="card">
      <div class="card-head">
        <div class="card-title">商机看板<span class="card-sub">桌面拖拽，手机点选阶段</span></div>
        <div class="spacer"></div>
        <span class="small muted">已赢 ${S.moneyFull(wonAmount)} · 已输 ${S.moneyFull(lostAmount)}</span>
        <button class="btn btn-primary btn-sm" data-action="new-deal">+ 新商机</button>
      </div>
      <div class="board">${columns}</div>
      ${mboard}
    </div>

    <div class="card deal-table">
      <div class="card-head"><div class="card-title">商机明细</div></div>
      <div style="overflow:auto">
        <table>
          <thead><tr><th>商机</th><th>客户</th><th>阶段</th><th class="right">金额</th><th class="right">加权</th>
            <th>预计成交</th><th>成交/关闭</th><th></th></tr></thead>
          <tbody>${all.map(d => {
            const w = (Number(d.amount) || 0) * S.stageOf(d.stage).prob / 100;
            return `<tr>
              <td><a href="#" data-action="edit-deal" data-id="${d.id}">${E(d.title)}</a>
                ${d.lostReason ? `<span class="sub" style="color:var(--red)">输单原因：${E(d.lostReason)}</span>` : ''}</td>
              <td>${E(S.customerName(d.customerId))}</td>
              <td>${stageBadge(d.stage)}</td>
              <td class="right mono">${S.moneyFull(d.amount)}</td>
              <td class="right mono muted">${S.moneyFull(Math.round(w))}</td>
              <td class="nowrap small">${E(d.expectedClose ? S.fmtDate(d.expectedClose) : '—')}</td>
              <td class="nowrap small">${E(d.closedAt ? S.fmtDate(d.closedAt) : '—')}</td>
              <td class="right nowrap">
                <button class="link" data-action="edit-deal" data-id="${d.id}">编辑</button>
                <button class="link danger" data-action="del-deal" data-id="${d.id}">删除</button>
              </td>
            </tr>`;
          }).join('') || `<tr><td colspan="8">${emptyBox('还没有商机')}</td></tr>`}</tbody>
        </table>
      </div>
    </div>`;
  }

  /* ============================================================
   * 4. 跟进日志
   * ============================================================ */
  function followups(ctx) {
    let rows = S.list('followups').slice();
    if (ctx.customerId) rows = rows.filter(f => f.customerId === ctx.customerId);
    if (ctx.type) rows = rows.filter(f => f.type === ctx.type);
    rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));

    const pending = S.stats().pending;
    const pendingList = pending.map(({ c, dd }) => `
      <div class="remind ${dd < 0 ? 'od' : ''}" data-action="open-customer" data-id="${c.id}" style="cursor:pointer">
        <div class="r-main">
          <div class="r-name">${E(c.name)}</div>
          <div class="r-meta">${E(c.contact || '')} ${c.phone ? E(c.phone) : ''} · ${E(S.fmtDate(c.nextFollowAt))} · ${dd < 0 ? `<span class="overdue">逾期 ${-dd} 天</span>` : '今天'}</div>
        </div>
        <div class="mobile-actions" style="gap:4px;margin:0">
          ${c.phone ? `<a class="btn btn-sm" href="tel:${E(c.phone)}">电话</a>` : ''}
          ${c.wechat ? `<button class="btn btn-sm" data-action="copy-wechat" data-id="${c.id}">微信</button>` : ''}
          <button class="btn btn-sm" data-action="log-followup" data-id="${c.id}">完成</button>
        </div>
      </div>`).join('');

    const typeOptions = ['<option value="">全部方式</option>'].concat(
      S.FOLLOW_TYPES.map(t => `<option value="${t}" ${ctx.type === t ? 'selected' : ''}>${t}</option>`)).join('');
    const custOptions = ['<option value="">全部客户</option>'].concat(
      S.list('customers').map(c => `<option value="${c.id}" ${ctx.customerId === c.id ? 'selected' : ''}>${E(c.name)}</option>`)).join('');

    const timeline = rows.length ? `<div class="timeline">${rows.map(f => `
      <div class="tl-item">
        <div class="tl-head">
          <strong>${E(f.type)}</strong>
          <a href="#" data-action="open-customer" data-id="${f.customerId}">${E(S.customerName(f.customerId))}</a>
          <span class="tl-time">${E(S.fmtDateTime(f.at))}</span>
          <button class="link danger" data-action="del-followup" data-id="${f.id}">删除</button>
        </div>
        <div class="tl-body">${E(f.content)}</div>
      </div>`).join('')}</div>` : emptyBox('还没有跟进记录');

    return `
    <div class="grid g12">
      <div class="card">
        <div class="card-head"><div class="card-title">待跟进<span class="card-sub">${pending.length} 家</span></div></div>
        ${pendingList || emptyBox('全部跟进完毕，去开发新客户吧')}
      </div>
      <div class="card">
        <div class="card-head">
          <div class="card-title">跟进日志<span class="card-sub">${rows.length} 条</span></div>
          <div class="spacer"></div>
          <button class="btn btn-sm" data-action="digest" data-id="${ctx.customerId || ''}">整理聊天记录</button>
          <button class="btn btn-primary btn-sm" data-action="quick-followup">+ 记一笔</button>
        </div>
        <div class="toolbar">
          <select id="f-customer">${custOptions}</select>
          <select id="f-type">${typeOptions}</select>
        </div>
        ${timeline}
      </div>
    </div>`;
  }

  /* ============================================================
   * 5. 话术库
   * ============================================================ */
  /* 客户最常把销售顶住的几句话。放在这里是为了「不用想就能点」——
   * 真被顶住的时候，人是想不起关键词的。 */
  const QUICK_OBJECTION = ['客户嫌贵', '再考虑考虑', '已读不回', '要跟领导汇报',
    '没预算', '对比别家', '拖着不签', '要账期', '怕上线麻烦', '客户要自研'];

  function scriptCard(s, why) {
    return `
      <div class="script-card">
        <h4>${E(s.title)}${s.source === 'won' ? '<span class="tag win">赢过</span>' : ''}</h4>
        <pre>${E(s.content)}</pre>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <span class="tag">${E(s.category)}</span>
          ${why ? `<span class="tag sub">${E(why)}</span>` : ''}
          ${s.builtin ? '' : '<span class="tag mine">我的</span>'}
          <div class="spacer"></div>
          <button class="btn btn-sm btn-primary" data-action="copy-script" data-id="${s.id}">复制</button>
          <button class="link" data-action="edit-script" data-id="${s.id}">编辑</button>
          <button class="link danger" data-action="del-script" data-id="${s.id}">删除</button>
        </div>
      </div>`;
  }

  function scripts(ctx) {
    const all = S.list('scripts');
    const q = String(ctx.q || '').trim();
    const cat = ctx.cat || '';
    const mine = all.filter(s => !s.builtin);
    const cats = Array.from(new Set(all.map(s => s.category)));
    const PB = window.Playbook;

    /* 有搜索词就走检索引擎。
     * 销售的真实动作是「把客户刚说那句话贴进来」，不是按分类慢慢翻 ——
     * 所以搜索必须比分类更显眼。 */
    const hits = (q && PB) ? PB.search(all, q, { limit: 12 }) : [];
    const group = cat ? all.filter(s => s.category === cat) : all;

    let resultsHtml;
    if (q) {
      if (hits.length) {
        resultsHtml = `<div class="pb-why">找到 ${hits.length} 条 · 按匹配度排序</div>
          <div class="grid g3">${hits.map(h => scriptCard(h.s, h.why)).join('')}</div>`;
      } else {
        /* 搜不到的时候恰恰是最值钱的时刻 —— 说明你撞上了库里没有的新情况。
         * 这时候不应该是死胡同，而应该顺手把它变成自己的第一条。 */
        resultsHtml = `
          <div class="empty-box">
            <p><b>库里还没有这句。</b></p>
            <p class="muted">这说明你撞上了一种新情况。如果你等下想到了怎么接，
            回来把它记成一条 —— 下次再遇到，它就在了。</p>
            <button class="btn btn-primary btn-sm" data-action="new-script" data-prefill="${E(q)}">
              把「${E(q)}」记成话术
            </button>
          </div>`;
      }
    } else if (cat) {
      resultsHtml = `<div class="grid g3">${group.map(s => scriptCard(s, '')).join('') || emptyBox('这个分类还是空的')}</div>`;
    } else {
      resultsHtml = `<div class="grid g3">${group.map(s => scriptCard(s, '')).join('') || emptyBox('还没有话术')}</div>`;
    }

    return `
    <div class="card">
      <div class="card-head">
        <div class="card-title">话术军火库
          <span class="card-sub">${all.length} 条${mine.length ? ` · 其中 ${mine.length} 条是你自己攒的` : ''}</span>
        </div>
        <div class="spacer"></div>
        <button class="btn btn-primary btn-sm" data-action="new-script">+ 新增话术</button>
      </div>

      <div class="pb-search">
        <input id="pb-q" type="search" placeholder="客户刚说了什么？直接贴进来 —— 比如「太贵了」「再考虑考虑」「要招标」"
               value="${E(q)}" autocomplete="off">
        ${q ? '<button class="pb-clear" data-action="pb-clear" title="清空">×</button>' : ''}
      </div>

      <div class="pb-quick">
        <span class="pb-quick-label">被这几句顶住过？</span>
        ${QUICK_OBJECTION.map(t => `<button class="chip" data-action="pb-quick" data-q="${E(t)}">${E(t)}</button>`).join('')}
      </div>

      ${q ? '' : `
      <div class="toolbar">
        <button class="btn btn-sm ${!cat ? 'btn-primary' : ''}" data-action="filter-script-cat" data-cat="">全部 ${all.length}</button>
        ${cats.map(c => `<button class="btn btn-sm ${cat === c ? 'btn-primary' : ''}" data-action="filter-script-cat" data-cat="${E(c)}">${E(c)} ${all.filter(x => x.category === c).length}</button>`).join('')}
      </div>`}

      <div id="pb-results">${resultsHtml}</div>
    </div>`;
  }

  /* 只重绘结果区 —— 整页重绘会让搜索框失焦，输入一个字就跳一下，没法用 */
  function scriptResults(ctx) {
    const all = S.list('scripts');
    const q = String(ctx.q || '').trim();
    const cat = ctx.cat || '';
    const PB = window.Playbook;
    const hits = (q && PB) ? PB.search(all, q, { limit: 12 }) : [];
    const group = cat ? all.filter(s => s.category === cat) : all;

    if (q) {
      if (hits.length) {
        return `<div class="pb-why">找到 ${hits.length} 条 · 按匹配度排序</div>
          <div class="grid g3">${hits.map(h => scriptCard(h.s, h.why)).join('')}</div>`;
      }
      return `
        <div class="empty-box">
          <p><b>库里还没有这句。</b></p>
          <p class="muted">这说明你撞上了一种新情况。如果你等下想到了怎么接，
          回来把它记成一条 —— 下次再遇到，它就在了。</p>
          <button class="btn btn-primary btn-sm" data-action="new-script" data-prefill="${E(q)}">
            把「${E(q)}」记成话术
          </button>
        </div>`;
    }
    return `<div class="grid g3">${group.map(s => scriptCard(s, '')).join('') || emptyBox('还没有话术')}</div>`;
  }

  /* ---------- 服务商选择 ----------
   * 为什么不干脆让用户自己填地址：各家地址长得没规律，
   * 「https://dashscope.aliyuncs.com/compatible-mode/v1」这种让用户手打不现实。
   * 选中即预填地址和默认模型名，用户只需要填自己的 Key。 */
  function aiProviderPicker(ai) {
    const P = (window.AI && window.AI.PROVIDERS) || {};
    const cur = ai.provider || 'deepseek';
    const opts = Object.keys(P).map(k =>
      `<option value="${E(k)}"${cur === k ? ' selected' : ''}>${E(P[k].name)}${P[k].note ? '（' + E(P[k].note) + '）' : ''}</option>`
    ).join('');
    const hist = (S.state.settings.aiHistory || []);
    const histHtml = hist.length ? `
      <div class="field"><label>用过的配置</label>
        <div style="display:flex;flex-wrap:wrap;gap:6px">
          ${hist.map((h, i) => `<button class="btn btn-sm" data-action="ai-use-history" data-i="${i}"
            title="${E(P[h.provider] ? P[h.provider].name : h.provider)} · ${E(h.keyHint || '')}…">${E((P[h.provider] && P[h.provider].name) || h.provider)} · ${E(h.model || '未填模型')}</button>`).join('')}
        </div></div>` : '';
    return `
      <div class="field"><label>服务商</label>
        <select id="ai-provider" data-action="ai-provider-change">${opts}</select></div>
      ${histHtml}
      <div class="hint">国内主流模型商现在都兼容 OpenAI 那套协议，所以换模型只是换地址 + 模型名，不用改代码。</div>`;
  }

  /* ---------- 提醒设置 ----------
   * 权限被用户拒了要明确说出来，而不是默默什么都不做——
   * 销售会以为「我开了提醒但没提醒」，这是最糟的结果。 */
  function notifyCard() {
    const N = window.Notify;
    if (!N) return '';
    const c = N.cfg();
    const perm = N.permission;
    const on = c.enabled !== false;
    let stateHtml = '';
    if (!N.supported()) {
      stateHtml = '<span class="down">当前环境不支持系统通知（用 http 打开或浏览器不支持）</span>';
    } else if (perm === 'granted') {
      stateHtml = '<span class="up">系统通知已授权</span>';
    } else if (perm === 'denied') {
      stateHtml = '<span class="down">浏览器通知已被阻止，需在地址栏左侧的网站设置里重新允许</span>';
    } else {
      stateHtml = '<span class="muted">还没授权系统通知</span>';
    }
    const b = N.badge ? N.badge() : { count: 0, overdue: 0 };
    return `
      <div class="card">
        <div class="card-head">
          <div class="card-title">跟进提醒<span class="card-sub">到点了主动叫你，不用一直盯着</span></div>
          <span class="badge" style="background:${on ? '#16a34a' : '#94a3b8'}">${on ? '已开启' : '已关闭'}</span>
        </div>
        <p class="small muted" style="margin-top:0">
          只提醒两类：<b>已经过了跟进日还没跟的</b>，和<b>今明两天到期的</b>。
          一天只弹一次，不反复打扰 —— 提醒太密，人第一反应就是关掉权限。
        </p>
        <div class="field-row">
          <div class="field"><label>开关</label>
            <select id="notify-enabled">
              <option value="1"${on ? ' selected' : ''}>开启</option>
              <option value="0"${!on ? ' selected' : ''}>关闭</option>
            </select></div>
          <div class="field"><label>当前待办</label>
            <div style="padding-top:6px"><b>${b.count}</b> 家待跟进，其中 <b class="down">${b.overdue}</b> 家已逾期</div></div>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:8px">
          ${N.supported() && perm !== 'granted' && perm !== 'denied'
            ? '<button class="btn btn-primary btn-sm" data-action="notify-request">开启系统通知</button>' : ''}
          <button class="btn btn-sm" data-action="save-notify">保存</button>
        </div>
        <div class="hint">${stateHtml}</div>
      </div>`;
  }

  /* ---------- 云账号与团队 ----------
   * 一个人用的时候这整块都可以不理，工具照样是完整的。
   * 需要多人、需要数据各自独立时，才来这里开。
   * 这是刻意的：**账号不能成为使用的前提**。 */
  function accountCard() {
    const A = window.Auth;
    if (!A) return '';
    const c = A.cfg();
    const on = A.isOn();
    const configured = A.configured();
    const roleMap = { owner: '拥有者', admin: '管理员', member: '使用员' };
    const role = A.role();

    if (!configured) {
      return `
      <div class="card">
        <div class="card-head">
          <div class="card-title">账号与团队<span class="card-sub">一个人用不用管这页</span></div>
          <span class="badge" style="background:#94a3b8">未配置</span>
        </div>
        <p class="small muted" style="margin-top:0">
          这一块是给<b>多人共用</b>准备的：每个人一个账号，<b>各自的客户和商机互相看不见</b>，
          管理员能看到全队的进度。
          不配也能用 —— 工具本来就是一个人的本地作战台。
        </p>
        <div class="field"><label>Supabase Project URL</label>
          <input id="cloud-url" value="${E(c.url || '')}" placeholder="https://xxxx.supabase.co"></div>
        <div class="field"><label>anon key</label>
          <input id="cloud-key" type="password" value="${E(c.key || '')}" placeholder="eyJhbGci..."></div>
        <button class="btn btn-primary" data-action="save-cloud">保存并测试连接</button>
        <div class="hint" id="cloud-hint">没有 Supabase 项目？它是免费的，注册后建个项目，
          把项目根目录 <code>supabase.sql</code> 整段粘进 SQL Editor 执行一次就行，不用管服务器。</div>
      </div>`;
    }

    if (!on) {
      return `
      <div class="card">
        <div class="card-head">
          <div class="card-title">账号与团队<span class="card-sub">登录后可跨设备同步、可加入团队</span></div>
          <span class="badge" style="background:#94a3b8">未登录</span>
        </div>
        <div class="field-row">
          <div class="field"><label>邮箱</label>
            <input id="cloud-email" type="email" placeholder="you@example.com"></div>
          <div class="field"><label>密码</label>
            <input id="cloud-pwd" type="password" placeholder="至少 6 位"></div>
        </div>
        <div class="field"><label>显示名（注册时填，团队里区分是谁）</label>
          <input id="cloud-name" placeholder="张三"></div>
        <div style="display:flex;flex-wrap:wrap;gap:8px">
          <button class="btn btn-primary" data-action="cloud-login">登录</button>
          <button class="btn" data-action="cloud-signup">注册</button>
          <button class="btn btn-ghost btn-sm" data-action="cloud-reset">换一个 Supabase 项目</button>
        </div>
        <div class="hint" id="cloud-hint">第一个注册的人自动成为<b>拥有者</b>，之后注册的默认是<b>使用员</b>，
          需要你手动拉进团队。</div>
      </div>`;
    }

    /* 已登录：显示身份 + 团队管理（管理员才看到成员列表） */
    return `
      <div class="card">
        <div class="card-head">
          <div class="card-title">账号与团队</div>
          <span class="badge" style="background:#16a34a">${E(roleMap[role] || '已登录')}</span>
        </div>
        <p class="small" style="margin-top:0">
          ${E(A.displayName())}　·　${E(A.email())}
        </p>
        <div id="team-area">${teamArea()}</div>
        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:8px">
          <button class="btn btn-sm" data-action="cloud-refresh">刷新</button>
          <button class="btn btn-sm btn-danger" data-action="cloud-logout">退出登录</button>
        </div>
        <div class="hint" id="cloud-hint"></div>
      </div>`;
  }

  /* 团队区：管理员看得到成员表，普通成员只看到自己这一行。
   * 成员列表要异步拉，所以这里先给个占位，由 ui.js 拿到数据后填。 */
  function teamArea() {
    const A = window.Auth;
    if (!A || !A.isOn()) return '';
    if (!A.isAdmin()) {
      return `<div class="hint">你在这个团队里的角色是<b>使用员</b>：只能看到自己的客户和商机，
        看不到别人的。这是件好事 —— 你的客户就是你的。</div>`;
    }
    return `<div class="hint">你是<b>${A.role() === 'owner' ? '拥有者' : '管理员'}</b>：
      能看到全队的进度，但<b>改不动</b>别人的客户和报价。
      成员的 API Key 和私有设置你同样看不到。</div>
      <div id="team-members"><span class="muted small">正在读取成员…</span></div>`;
  }

  /* ============================================================
   * 6. 设置
   * ============================================================ */
  function settings() {
    const s = S.state.settings;
    const st = S.stats();
    const ai = s.ai || {};
    const sy = s.sync || {};
    const mode = sy.mode || 'off';
    const tombs = S.SYNC_KEYS.reduce((n, k) =>
      n + (S.state[k] || []).filter(r => r.deleted).length, 0);
    const hc = window.Health ? window.Health.settings() : { enabled: true, sensitivity: 1, snoozeDays: 7 };
    return `
    <div class="grid g2">
      <div class="card">
        <div class="card-head"><div class="card-title">个人与目标设置</div></div>
        <div class="field"><label>姓名（团队共用时区分归属）</label>
          <input id="set-owner" value="${E(s.owner)}"></div>
        <div class="field"><label>月度回款目标（元）</label>
          <input id="set-target" type="number" min="0" step="1000" value="${Number(s.monthlyTarget) || 0}"></div>
        <div class="field"><label>提成比例（%）</label>
          <input id="set-rate" type="number" min="0" max="100" step="0.1" value="${Number(s.commissionRate) || 0}"></div>
        <button class="btn btn-primary" data-action="save-settings">保存设置</button>
        <div class="hint">修改目标后，战情台的完成率与冲刺提示会立即更新。</div>
      </div>

      <div class="card">
        <div class="card-head"><div class="card-title">数据管理</div></div>
        <p class="small muted" style="margin-top:0">
          数据保存在本机浏览器（localStorage）：${S.isPersistent() ? '<span class="up">可持久化</span>' : '<span class="down">当前环境不可用，刷新会丢失，请及时导出备份</span>'}。
          换电脑/换浏览器请先导出 JSON 再导入。
        </p>
        <div style="display:flex;flex-wrap:wrap;gap:8px">
          <button class="btn" data-action="export-json">导出备份 JSON</button>
          <button class="btn" data-action="import-json">导入备份 JSON</button>
          <button class="btn" data-action="copy-datacode">复制数据码（换机/微信转发）</button>
          <button class="btn" data-action="paste-datacode">粘贴数据码导入</button>
          <button class="btn" data-action="export-csv">导出客户 CSV</button>
          <button class="btn" data-action="seed-demo">载入示例数据</button>
          <button class="btn btn-danger" data-action="clear-data">清空全部业务数据</button>
        </div>
        <div class="hint">「数据码」是把全部数据压缩成一段文本，微信发给自己即可跨设备迁移。导入会<b>覆盖</b>当前数据，操作前建议先导出一次。</div>
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <div class="card-title">商机健康度<span class="card-sub">哪些单子可能凉了，按你自己的节奏判断</span></div>
        <span class="badge" style="background:${hc.enabled ? '#16a34a' : '#94a3b8'}">${hc.enabled ? '已开启' : '已关闭'}</span>
      </div>
      <p class="small muted" style="margin-top:0">
        不是「多少天没跟进就报警」那种死规则。工具会从你<b>已成交的订单</b>里学出每个阶段的真实停留天数，
        再用你自己的节奏去量在谈的单子 —— 政企半年周期和快消三周周期，不会被同一把尺子误伤。
      </p>
      <div class="field-row">
        <div class="field"><label>提醒松紧</label>
          <select id="health-sensitivity">
            <option value="0.7"${hc.sensitivity === 0.7 ? ' selected' : ''}>严格 — 稍微拖延就提醒</option>
            <option value="1"${hc.sensitivity === 1 ? ' selected' : ''}>标准 — 按你的历史节奏</option>
            <option value="1.5"${hc.sensitivity === 1.5 ? ' selected' : ''}>宽松 — 只提醒明显不对劲的</option>
          </select></div>
        <div class="field"><label>点「知道了」后几天内不再提</label>
          <input id="health-snooze" type="number" min="1" value="${Number(hc.snoozeDays) || 7}"></div>
        <div class="field"><label>开关</label>
          <select id="health-enabled">
            <option value="1"${hc.enabled ? ' selected' : ''}>开启</option>
            <option value="0"${!hc.enabled ? ' selected' : ''}>关闭</option>
          </select></div>
      </div>
      <div class="hint">${E(healthBasisText())}把你最近成交的单子多记几次阶段变化，判断会越来越准。</div>
    </div>

    ${accountCard()}

    <div class="card">
      <div class="card-head">
        <div class="card-title">云同步<span class="card-sub">手机和电脑自动一致，断网照样用</span></div>
        <span id="sync-badge" class="badge" style="background:#94a3b8">未启用</span>
      </div>
      <p class="small muted" style="margin-top:0">
        <b>本地优先</b>：数据永远先写本机，联网时才与云端合并。服务器挂了、飞机上、地铁里，工具照常能用，联网后自动收敛。
        冲突按「最后修改者赢」，删除用墓碑标记，换设备也能同步「已删除」。
      </p>
      <details class="sync-guide">
        <summary>没有自己的服务器？三条零成本路线（点开看）</summary>
        <div class="small">
          <p><b>① 用公共演示后端 · 1 分钟</b><br>
            同步地址填 README 里给的那个，令牌<b>自己起一个长且别人猜不到的</b>
            （像 <code>zhangwei-7f3a9k2m-hz</code> 这种，别用 <code>123456</code>）。
            手机和电脑填<b>相同地址 + 相同令牌</b>就能互相同步；令牌不同则彼此看不到。
            <span class="down">注意：这是公共环境，令牌就是唯一的钥匙——别人猜到就能看到你的数据。只适合试用或放不敏感的内容。</span>
          </p>
          <p><b>② Supabase 免费版 · 3 分钟，长期用推荐这条</b><br>
            注册 supabase.com → 新建项目 → SQL Editor 里整段粘贴执行项目根目录的
            <code>supabase.sql</code> → 回来选「Supabase / 云开发 REST」，填 Project URL 和 anon key。
            数据落在<b>你自己的账号</b>里，谁都看不到，也不用你管服务器。
          </p>
          <p><b>③ 数据码手动同步 · 0 配置，30 秒一次</b><br>
            就在本页下方的「数据管理」卡片：复制数据码 → 微信发给自己 → 另一台设备粘贴导入。
            全程不联网，最私密，代价是要手动。
          </p>
          <p class="muted">共同前提：同步总得有个"存放数据的地方"。区别只是那个地方是你的服务器、别人的免费云服务，还是你自己的微信——没有哪条路能凭空同步。</p>
        </div>
      </details>

      <div class="field"><label>同步方式</label>
        <select id="sync-mode">
          <option value="off"${mode === 'off' ? ' selected' : ''}>关闭（仅存本机）</option>
          <option value="http"${mode === 'http' ? ' selected' : ''}>自建 / 兼容服务器（一个人多台设备）</option>
          <option value="supabase"${mode === 'supabase' ? ' selected' : ''}>Supabase 空间（一个人多台设备）</option>
          <option value="cloud"${mode === 'cloud' ? ' selected' : ''}>Supabase 账号（多人 / 团队，数据各自独立）</option>
        </select>
      </div>

      <div id="sync-cloud-fields" hidden>
        <div class="hint">
          账号模式按<b>记录</b>同步，而不是整份覆盖 —— 你和同事各改各的客户，互不影响。
          「谁能看见谁」由数据库的行级安全策略决定，跟前端无关：
          <b>使用员只见自己的，管理员可见全队但改不动</b>。
          ${window.Auth && window.Auth.isOn() ? '' : '<br><span class="down">先在上面的「账号与团队」里登录，这个模式才跑得起来。</span>'}
        </div>
      </div>

      <div id="sync-http-fields">
        <div class="field"><label>同步地址</label>
          <input id="sync-endpoint" value="${E(sy.endpoint || '')}" placeholder="https://your-server.com/api/sync"></div>
        <div class="field"><label>同步令牌</label>
          <input id="sync-token" type="password" value="${E(sy.token || '')}" placeholder="服务端生成的 token"></div>
        ${PUBLIC_ENDPOINT ? '<button class="btn btn-ghost btn-sm" data-action="fill-public-endpoint" style="margin-top:-2px">填入公共演示后端地址</button>' : ''}
        <div class="hint">
          自建：跑 <code>node server.js</code>，控制台会打印令牌，手机电脑填<b>同一地址+同一令牌</b>即可。
          不自建也行——只要对方提供 <code>GET</code> 拿快照、<code>PUT</code> 存快照这两个接口就能接。
        </div>
      </div>

      <div id="sync-sb-fields" hidden>
        <div class="field"><label>Project URL</label>
          <input id="sb-url" value="${E(sy.url || '')}" placeholder="https://xxxx.supabase.co"></div>
        <div class="field"><label>anon key</label>
          <input id="sb-key" type="password" value="${E(sy.key || '')}" placeholder="eyJhbGci..."></div>
        <div class="field-row">
          <div class="field"><label>表名</label>
            <input id="sb-table" value="${E(sy.table || 'sales_sync')}" placeholder="sales_sync"></div>
          <div class="field"><label>空间名</label>
            <input id="sb-space" value="${E(sy.space || 'default')}" placeholder="default"></div>
        </div>
        <div class="hint">建表 SQL 见 README。<b>空间名相同的设备之间互相同步</b>；想让多个账号各自独立，填不同的空间名即可。</div>
      </div>

      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:4px">
        <button class="btn btn-primary" data-action="save-sync">保存并连接</button>
        <button class="btn" data-action="sync-now">立即同步</button>
        <button class="btn" data-action="sync-stop">停止同步</button>
        <button class="btn" data-action="sync-purge">压缩本地墓碑</button>
      </div>
      <div class="hint" id="sync-status">当前未启用同步，数据仅保存在本机。</div>
      <div class="hint">
        本机标识 <code style="font-size:11px">${E(S.state.deviceId || '')}</code>　·
        墓碑记录 ${tombs} 条　·
        ${s.lastSyncAt ? '上次同步 ' + E(new Date(s.lastSyncAt).toLocaleString('zh-CN')) : '尚未同步过'}
      </div>
    </div>

    <div class="grid g2">
      <div class="card">
        <div class="card-head"><div class="card-title">AI 助手（可选增强）</div></div>
        <p class="small muted" style="margin-top:0">
          不配置也能用。配置后可在「AI 助手」页生成跟进话术、周报、输单复盘、客户作战建议<b>和作战简报</b>。
          API Key 只保存在本机浏览器，直连你填的服务商，不会经过任何第三方服务器。
        </p>
        <details ${ai.key ? '' : 'open'}>
          <summary style="cursor:pointer;color:var(--primary);font-weight:600;font-size:13px;margin-bottom:10px">展开 API 配置</summary>
          ${aiProviderPicker(ai)}
          <div class="field"><label>接口地址（OpenAI 兼容格式）</label>
            <input id="ai-base" value="${E(ai.base || 'https://api.deepseek.com/v1')}" placeholder="https://api.deepseek.com/v1"></div>
          <div class="field"><label>API Key</label>
            <input id="ai-key" type="password" value="${E(ai.key || '')}" placeholder="sk-..."></div>
          <div class="field"><label>模型名</label>
            <div style="display:flex;gap:6px">
              <input id="ai-model" value="${E(ai.model || 'deepseek-chat')}" placeholder="deepseek-chat" style="flex:1">
              <button class="btn btn-sm" data-action="ai-list-models" title="从服务商拉取可用模型">拉取</button>
            </div></div>
          <div style="display:flex;flex-wrap:wrap;gap:8px">
            <button class="btn btn-primary" data-action="save-ai">保存并测试连接</button>
            <button class="btn btn-sm" data-action="ai-test">只测连接</button>
          </div>
          <div class="hint" id="ai-hint">${ai.key ? '已配置。测试通过就能在「AI 助手」页用。' : '选一家服务商、填 Key，模型名会自动带上默认值。标了「免费」的适合先试试。'}</div>
        </details>
      </div>

      ${notifyCard()}

      <div class="card">
        <div class="card-head"><div class="card-title">安装到手机 / PWA</div></div>
        <p class="small muted" style="margin-top:0">
          本页面支持 PWA：用浏览器打开 → 点击菜单「添加到主屏幕」，即可像原生 App 一样全屏打开、离线使用。
        </p>
        <button class="btn" data-action="check-pwa">查看安装状态</button>
        <div class="hint">iOS 用户：Safari 打开 → 底部分享按钮 →「添加到主屏幕」。</div>
      </div>
    </div>

    <div class="card">
      <div class="card-head"><div class="card-title">当前数据概览</div></div>
      <div class="grid g4">
        ${kpi('客户', st.counts.customers + ' 家', 'A/B/C 分级管理')}
        ${kpi('商机', st.counts.deals + ' 个', '在谈 ' + st.counts.open + ' 个')}
        ${kpi('跟进记录', st.counts.followups + ' 条', '电话/微信/拜访/会议')}
        ${kpi('话术', S.list('scripts').length + ' 条', '可自由增删改')}
      </div>
    </div>

    <div class="card">
      <div class="card-head"><div class="card-title">使用建议</div></div>
      <ol class="small muted" style="line-height:2;padding-left:18px;margin:0">
        <li><b>每天上班第一件事</b>：看「战情台 → 今日作战清单」，逾期的先打电话，别让它继续躺着。</li>
        <li><b>A 级客户不超过 10 家</b>：分级是给自己排优先级用的，全是 A 等于没有 A。</li>
        <li><b>每周五更新商机阶段</b>：加权预测才准，月底才知道找谁催。</li>
        <li><b>输单一定填原因</b>：三个月后回看，你会发现输单原因高度重复，那才是你真正的短板。</li>
        <li><b>话术库要自己养</b>：把客户说过最让你卡壳的那句话记下来，写出你的答案，别让它第二次难住你。</li>
      </ol>
    </div>`;
  }

  /* ============================================================
   * 7. AI 助手
   * ============================================================ */
  function ai(ctx) {
    const customers = S.list('customers').slice().sort((a, b) => (a.nextFollowAt || '').localeCompare(b.nextFollowAt || ''));
    const custOptions = ['<option value="">选择客户（可选）</option>'].concat(
      customers.map(c => `<option value="${c.id}" ${ctx.customerId === c.id ? 'selected' : ''}>${E(c.name)} ${c.contact ? '（' + E(c.contact) + '）' : ''}</option>`)).join('');
    const hasKey = !!(S.state.settings.ai && S.state.settings.ai.key);
    return `
    <div class="card">
      <div class="card-head">
        <div class="card-title">AI 助手<span class="card-sub">让 AI 帮你写话术、写周报、做复盘</span></div>
        <div class="spacer"></div>
        <span class="small ${hasKey ? 'up' : 'muted'}">${hasKey ? '已配置 API' : '未配置 API（可在设置中配置）'}</span>
      </div>
      <div class="grid g2">
        <div class="card" style="margin:0">
          <div class="section-title">1. 选场景与客户</div>
          <div class="field">
            <label>场景</label>
            <select id="ai-scenario">
              <option value="followup" ${ctx.scenario === 'followup' ? 'selected' : ''}>写跟进话术（微信/电话）</option>
              <option value="weekly" ${ctx.scenario === 'weekly' ? 'selected' : ''}>生成本周周报</option>
              <option value="lost" ${ctx.scenario === 'lost' ? 'selected' : ''}>输单复盘与改进建议</option>
              <option value="battle" ${ctx.scenario === 'battle' ? 'selected' : ''}>客户作战建议</option>
              <option value="intel" ${ctx.scenario === 'intel' ? 'selected' : ''}>客户作战简报（六段式）</option>
              <option value="advise" ${ctx.scenario === 'advise' ? 'selected' : ''}>话术军火：客户这句话怎么接</option>
            </select>
          </div>
          <div class="field">
            <label>客户（非必填，选客户后 AI 会带入画像和最近跟进）</label>
            <select id="ai-customer">${custOptions}</select>
          </div>
          <div class="field">
            <label>补充要求</label>
            <textarea id="ai-extra" rows="2" placeholder="例：语气客气一点 / 突出 ROI / 催单但不显得急"></textarea>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="btn btn-primary" data-action="ai-generate">生成</button>
            <button class="btn" data-action="ai-copy-prompt">复制提示词（没配 API 时用这个）</button>
          </div>
        </div>
        <div class="card" style="margin:0;display:flex;flex-direction:column">
          <div class="section-title">2. 结果</div>
          <textarea id="ai-output" style="flex:1;min-height:180px" placeholder="点击「生成」后内容会出现在这里。你可以直接编辑，再复制或存入话术库。"></textarea>
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">
            <button class="btn" data-action="ai-copy-result">复制结果</button>
            <button class="btn" data-action="ai-save-script">存到话术库</button>
          </div>
        </div>
      </div>
      <div class="hint" style="margin-top:12px">AI 生成内容仅供参考，发出去前务必检查是否符合事实、不会得罪客户。</div>
    </div>

    <div class="card">
      <div class="card-head"><div class="card-title">各场景说明</div></div>
      <div class="grid g2">
        <div><b>写跟进话术</b><p class="small muted">根据客户分级、行业、当前阶段、最近跟进，生成一段可直接发微信或打电话说的话术。</p></div>
        <div><b>本周周报</b><p class="small muted">汇总本周新增客户、推进的商机、已成交金额、下周重点动作，可直接粘贴给老板。</p></div>
        <div><b>输单复盘</b><p class="small muted">读取所有输单记录，归纳输单原因分布，给出 3 条可执行的改进动作。</p></div>
        <div><b>客户作战建议</b><p class="small muted">基于客户画像和商机阶段，给出下一步该做什么、该找谁、该避开什么。</p></div>
        <div><b>客户作战简报</b><p class="small muted">见客户前的六段式准备：背景、行业痛点、决策人关心什么、中英文开场白、雷区。
          <b>没有联网</b>，凡是推测的地方会标注「待核实」——宁可说不确定，也不编得像亲眼见过。</p></div>
        <div><b>话术军火</b><p class="small muted">把客户那句让你卡壳的原话粘进去，先从<b>你自己的话术库</b>里找参考，
          再让 AI 改写成一段能直接发出去的话。检索在本地完成，断网也能找到素材。</p></div>
      </div>
    </div>`;
  }


  /* ============================================================
   * 8. 周报 / 复盘
   * 数据全部本地算（见 report.js），不联网不要 Key。
   * 这页要解决的是「周会前十分钟翻聊天记录」——把散落一周的动作自动归拢。
   * ============================================================ */
  function report(ctx) {
    const R = window.Report;
    const key = (ctx && ctx.range) || 'thisWeek';
    const d = R.build(key);
    const c = d.counts;

    /* 范围切换 */
    const chips = R.RANGES.map(r =>
      `<button class="chip ${r.key === key ? 'active' : ''}" data-action="rp-range" data-range="${r.key}">${r.name}</button>`
    ).join('');

    /* 数字：0 的不显示 —— 周报里出现「成交 0 单」是自曝其短，
     * 而且挤占了真正有信息的数字的位置 */
    const kpis = [
      c.newCustomers ? kpi('新增客户', c.newCustomers + ' 家', '') : '',
      c.followCount ? kpi('跟进', c.followCount + ' 次', c.covered ? '覆盖 ' + c.covered + ' 家' : '') : '',
      c.advanced ? kpi('推进商机', c.advanced + ' 个', '') : '',
      c.won ? kpi('成交', S.money(c.wonAmount), c.won + ' 单', 'ok') : '',
      c.lost ? kpi('丢单', S.money(c.lostAmount), c.lost + ' 单', 'danger') : '',
      c.scripts ? kpi('沉淀话术', c.scripts + ' 条', '经验攒下来了') : ''
    ].filter(Boolean).join('');

    /* 重点客户 */
    const hotHtml = d.hot.length ? d.hot.map(h => `
      <div class="rp-cust" data-action="open-customer" data-id="${h.id}" style="cursor:pointer">
        <div class="rp-c-top">
          <b>${E(h.name)}</b> ${levelTag(h.level)}
          ${h.stageName ? `<span class="badge" style="background:${S.stageOf(h.stage).color}">${E(h.stageName)}</span>` : ''}
          <span class="spacer"></span>
          <span class="muted small">本周 ${h.times} 次</span>
          <span class="rp-amt">${S.money(h.openAmount)}</span>
        </div>
        <div class="rp-c-body">${E(h.lastText)}</div>
      </div>`).join('') : emptyBox('这段时间没有跟进记录');

    /* 下一步 */
    const nextHtml = d.next.length ? d.next.slice(0, 12).map(n => `
      <div class="rp-row">
        <span class="rp-date">${E(n.at)}</span>
        <a href="#" data-action="open-customer" data-id="${n.id}">${E(n.name)}</a>
        <span class="rp-what">${E(n.text)}</span>
      </div>`).join('') : emptyBox('未来 7 天没有待兑现的承诺');

    /* 风险 */
    const riskHtml = d.risks.length ? d.risks.map(r => `
      <div class="rp-risk">
        <div class="rp-risk-t">${E(r.label)}</div>
        ${r.items.map(it => {
          const right = it.days ? `${it.days} 天没动` : (it.reason ? E(it.reason) : (it.title ? E(it.title) : ''));
          const amt = it.amount ? S.money(it.amount) : '';
          const nm = it.name ? E(it.name) : '';
          const label = nm || E(it.title || '');
          /* 一律跳客户详情，不跳商机：详情页里商机、跟进历史、记跟进按钮都在，
           * 这才是「看到风险之后要做的动作」的落点。
           * 「本月目标」这类统计项没有对应客户，硬塞 id 只会点出报错，
           * 那就干脆不做成链接。 */
          const custId = it.custId || (r.kind === 'owed' ? it.id : '');
          const nameHtml = custId
            ? `<a href="#" data-action="open-customer" data-id="${E(custId)}">${label}</a>`
            : `<span>${label}</span>`;
          return `<div class="rp-row ${r.kind === 'owed' ? 'od' : ''}">
            ${nameHtml}
            ${amt ? `<span class="rp-amt">${amt}</span>` : ''}
            <span class="rp-what muted">${right || (it.dd !== undefined ? '逾期 ' + (-it.dd) + ' 天' : '')}</span>
          </div>`;
        }).join('')}
      </div>`).join('') : emptyBox('这段时间没有需要亮红灯的事');

    const hasAI = !!(S.state.settings.ai && S.state.settings.ai.key);
    const text = R.toText(d);

    return `
    <div class="grid g12">
      <div class="card">
        <div class="card-head">
          <div class="card-title">周报 / 复盘
            <span class="card-sub">${E(d.from)} ~ ${E(d.to)} · ${d.span} 天</span>
          </div>
          <div class="spacer"></div>
          <button class="btn btn-sm" data-action="copy-report">复制文字版</button>
          ${hasAI ? '<button class="btn btn-sm" data-action="ai-polish">AI 润色</button>' : ''}
        </div>
        <div class="rp-ranges">${chips}</div>
        ${kpis ? `<div class="kpis" style="margin-top:12px">${kpis}</div>`
                : `<div class="empty" style="margin-top:12px">这段时间没有任何动作记录。<br>平时顺手记一条跟进，周会前就不用翻聊天记录了。</div>`}
      </div>

      <div class="grid g2">
        <div class="card">
          <div class="card-head"><div class="card-title">重点客户<span class="card-sub">${d.hot.length} 家</span></div></div>
          ${hotHtml}
        </div>
        <div class="card">
          <div class="card-head"><div class="card-title">接下来 7 天<span class="card-sub">${d.next.length} 件</span></div></div>
          ${nextHtml}
          ${d.owed.length ? `<div class="section-title" style="margin-top:14px">该跟没跟的<span class="card-sub">${d.owed.length} 家</span></div>
            ${d.owed.map(o => `<div class="rp-row od">
              <span class="rp-date">${E(o.at || '—')}</span>
              <a href="#" data-action="open-customer" data-id="${E(o.id)}">${E(o.name)}</a>
              <span class="rp-what overdue">逾期 ${-o.dd} 天</span>
            </div>`).join('')}` : ''}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div class="card-title">风险与需要关注</div></div>
        ${riskHtml}
        ${d.stale.length ? `<div class="hint" style="margin-top:10px">「冷住的商机」按 ${R.STALE_DAYS} 天没动过判定。它不一定真的丢了，但再不联系大概率要凉。</div>` : ''}
      </div>

      <div class="card">
        <div class="card-head">
          <div class="card-title">文字版<span class="card-sub">可直接发给领导</span></div>
          <div class="spacer"></div>
          <button class="btn btn-sm btn-primary" data-action="copy-report">复制</button>
        </div>
        <textarea id="rp-text" class="rp-text" rows="16" spellcheck="false">${E(text)}</textarea>
        <div class="hint">数字和结论都来自你自己的记录，不会瞎编。发出去前扫一眼有没有不想让领导看到的客户名。</div>
      </div>
    </div>`;
  }

  return { dash, customers, customerDetail, deals, followups, scripts, scriptResults, report, settings, ai,
    stageBadge, levelTag, morningBrief, healthCard, healthDot, PUBLIC_ENDPOINT };
})();
