/* ============================================================
 * 销冠助手 · 商机健康度引擎
 *
 * 设计原则（这三条写死，后面任何改动都不能破）：
 *  1. 纯规则、零网络、零 AI。断网、没 Key、刚装上，都得能算出来。
 *  2. 基准来自「你自己的历史节奏」，不是我拍的一个全局死数。
 *     政企客户 6 个月周期和快消 3 周周期，用同一把尺子量，
 *     结果就是长周期客户天天亮红灯 —— 亮几次就没人看了，这叫狼来了。
 *  3. 每条提示必须带一个动作，而且要能一键做到。
 *     只报问题不给出口，那就不是助手，是监工。
 * ============================================================ */
window.Health = (function () {

  const DAY = 86400000;

  /* ---------- 冷启动默认值 ----------
   * 只有当用户自己的历史样本不够时才用。按客户等级分档，
   * 因为 A 类客户的沟通密度本来就比 C 类高。 */
  const DEFAULT_STAGE_DAYS = {
    A: { lead: 10, contact: 14, solution: 21, quote: 14, negotiate: 12 },
    B: { lead: 14, contact: 21, solution: 30, quote: 21, negotiate: 18 },
    C: { lead: 21, contact: 30, solution: 45, quote: 30, negotiate: 25 }
  };
  /* 沉默阈值的兜底（天）：多久没动静算异常 */
  const DEFAULT_SILENCE_DAYS = { A: 12, B: 18, C: 30 };

  const STAGE_ORDER = ['lead', 'contact', 'solution', 'quote', 'negotiate', 'won'];

  /* ---------- 设置 ---------- */
  function settings() {
    const s = (window.Store.state.settings || {});
    return Object.assign({ sensitivity: 1, snoozeDays: 7, enabled: true }, s.health || {});
  }
  function setSettings(patch) {
    const st = window.Store.state.settings;
    st.health = Object.assign(settings(), patch);
    window.Store.save();
    cache.key = -1;
  }

  /* ---------- 缓存：以数据版本号为 key ---------- */
  const cache = { key: -1, baselines: null, cadence: null, fidx: null };
  function ensureCache() {
    const k = window.Store.revision();
    if (k === cache.key && cache.baselines) return;
    cache.key = k;
    cache.baselines = buildBaselines();
    cache.cadence = {};
    cache.fidx = null;
    cache.conv = null;
  }
  /* 外部数据变了要主动失效 */
  function invalidate() { cache.key = -1; cache.fidx = null; cache.conv = null; }

  /* 跟进记录按客户建索引：看板每次渲染都要算全量健康度，
   * 逐条扫全表会变成 O(商机 × 跟进)，几百条数据就卡了。 */
  function fOf(customerId) {
    ensureCache();
    if (!cache.fidx) {
      const m = {};
      window.Store.list('followups').forEach(f => {
        (m[f.customerId] = m[f.customerId] || []).push(f);
      });
      Object.keys(m).forEach(k =>
        m[k].sort((a, b) => Date.parse(a.at || 0) - Date.parse(b.at || 0)));
      cache.fidx = m;
    }
    return cache.fidx[customerId] || [];
  }

  /* 中位数：比平均数抗极值。一个拖了半年的怪单不该污染整条基准线 */
  const median = arr => {
    if (!arr.length) return 0;
    const a = arr.slice().sort((x, y) => x - y);
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /* ---------- 基准：从你自己的历史里学「这个阶段一般停多久」 ---------- */
  function buildBaselines() {
    const byStage = {};
    const deals = window.Store.list('deals');
    deals.forEach(d => {
      const h = (d.stageHistory || []).filter(x => x && x.at && !x.synth);
      if (h.length < 2 && !d.closedAt) return;         // 样本太薄，不参与统计
      for (let i = 1; i < h.length; i++) {
        const days = (h[i].at - h[i - 1].at) / DAY;
        if (days < 0 || days > 400) continue;          // 明显脏数据，丢掉
        (byStage[h[i - 1].stage] = byStage[h[i - 1].stage] || []).push(days);
      }
      // 已关闭的：最后一条轨迹到关闭日，也算这一段的停留
      if (d.closedAt && h.length) {
        const last = h[h.length - 1];
        const days = (Date.parse(d.closedAt) - last.at) / DAY;
        if (days >= 0 && days <= 400) (byStage[last.stage] = byStage[last.stage] || []).push(days);
      }
    });
    const out = { stage: {}, silence: null, sample: {} };
    Object.keys(byStage).forEach(k => {
      out.sample[k] = byStage[k].length;
      // 少于 3 个样本不采信：一两个样本的中位数就是随机数
      if (byStage[k].length >= 3) out.stage[k] = median(byStage[k]);
    });
    return out;
  }

  /* ---------- 各阶段的实际赢率：同样是学出来的 ----------
   * 口径：历史上「曾经到达过阶段 X」的已关闭订单里，最终赢单的比例。
   * 只统计已关闭订单 —— 在谈的还没结果，算进分母会系统性低估。
   * 默认赢率（10/25/45/65/80%）是行业通拍的数，跟你自己的实际水平未必一致。 */
  function conversion() {
    ensureCache();
    if (cache.conv) return cache.conv;
    const reached = {}, won = {};
    window.Store.list('deals')
      .filter(d => d.stage === 'won' || d.stage === 'lost')
      .forEach(d => {
        const seen = {};
        (d.stageHistory || []).forEach(x => { if (x && x.stage) seen[x.stage] = 1; });
        if (!Object.keys(seen).length && d.stage) seen[d.stage] = 1;
        // 赢单的订单一定走完了它当前所在的阶段
        if (d.stage === 'won') seen[d.stage] = 1;
        Object.keys(seen).forEach(s => {
          reached[s] = (reached[s] || 0) + 1;
          if (d.stage === 'won') won[s] = (won[s] || 0) + 1;
        });
      });
    const out = {};
    Object.keys(reached).forEach(s => {
      const n = reached[s], w = won[s] || 0;
      // 三条门槛，缺一条这个数就是废的：
      //   ① 样本 ≥3；② 既有赢的也有输的 ——
      //      只统计到赢单会得出 100%，比默认的 65% 还虚高，宁可不用。
      if (n >= 3 && w > 0 && w < n) out[s] = { p: w / n, n: n };
    });
    cache.conv = out;
    return out;
  }

  /* ---------- 基准：这个客户平时的联系间隔 ---------- */
  function cadenceOf(customerId) {
    ensureCache();
    if (cache.cadence[customerId] !== undefined) return cache.cadence[customerId];
    const ts = fOf(customerId)
      .map(f => Date.parse(f.at)).filter(Boolean)
      .sort((a, b) => a - b);
    let v = null;
    if (ts.length >= 3) {
      const gaps = [];
      for (let i = 1; i < ts.length; i++) gaps.push((ts[i] - ts[i - 1]) / DAY);
      v = clamp(median(gaps), 3, 90);
    }
    cache.cadence[customerId] = v;
    return v;
  }

  /* ---------- 取某阶段应停留天数 ---------- */
  function typicalStageDays(stageId, level) {
    ensureCache();
    const learned = cache.baselines.stage[stageId];
    if (learned) return learned;
    const def = DEFAULT_STAGE_DAYS[level] || DEFAULT_STAGE_DAYS.B;
    return def[stageId] != null ? def[stageId] : 21;
  }

  /* ---------- 最后接触时间：跟进优先，没有就用商机创建日 ---------- */
  function lastTouchOf(deal) {
    const fs = fOf(deal.customerId);
    let t = 0;
    fs.forEach(f => { const p = Date.parse(f.at || 0); if (p > t) t = p; });
    const c = Date.parse(deal.createdAt || 0);
    return { at: Math.max(t, c || 0), fromFollow: t > 0 };
  }

  /* ---------- 当前阶段起点 ---------- */
  function stageEnteredAt(deal) {
    const h = (deal.stageHistory || []).filter(x => x && x.at);
    if (h.length) {
      const last = h[h.length - 1];
      if (last.stage === deal.stage) return { at: last.at, real: !last.synth };
      // 轨迹最后一条和当前阶段不一致（直接改了库/老数据），退到创建日
    }
    return { at: Date.parse(deal.createdAt || 0) || Date.now(), real: false };
  }

  /* ---------- 最近是否有实质推进 ---------- */
  function hasMomentum(deal, windowDays) {
    const since = Date.now() - windowDays * DAY;
    const h = (deal.stageHistory || []).filter(x => x && x.at > since);
    if (h.length) return true;
    return fOf(deal.customerId).some(x => Date.parse(x.at || 0) > since);
  }

  const NEXT_OF = { lead: 'contact', contact: 'solution', solution: 'quote', quote: 'negotiate', negotiate: 'won' };

  /* 每个阶段「往前推一步」到底要交付什么。
   * 写这句话的原则：销售看完就知道今天要干什么，而不是「推进到下一阶段」这种正确的废话。 */
  const PUSH_TEXT = {
    lead: '约一次需求沟通，把「他到底要解决什么」问出来',
    contact: '出方案：把聊出来的需求落成他能看懂的东西',
    solution: '报价：先问清预算区间和决策流程，再报价',
    quote: '进谈判：确认价格、交付周期、付款方式三条能不能对上',
    negotiate: '把合同推到签字：问清还差哪一条没谈拢'
  };

  /* ============================================================
   * 核心：给一条商机打分
   * ============================================================ */
  function of(deal) {
    const st = settings();
    const now = Date.now();
    const base = {
      dealId: deal.id,
      customerId: deal.customerId,
      customer: window.Store.customerName(deal.customerId),
      title: deal.title,
      amount: Number(deal.amount) || 0,
      stage: deal.stage,
      stageName: window.Store.stageOf(deal.stage).name
    };

    // 已关闭的不评；功能关掉的不评
    if (deal.stage === 'won' || deal.stage === 'lost') {
      return Object.assign(base, { level: 'closed', score: 100, reasons: [], nextAction: null, closed: true });
    }
    if (!st.enabled) {
      return Object.assign(base, { level: 'off', score: 100, reasons: [], nextAction: null });
    }

    // 忽略期内：用户说过了「这条我知道」，就别再念。掌控感要还给销售。
    if (deal.healthSnooze && Number(deal.healthSnooze.until) > now) {
      return Object.assign(base, {
        level: 'snoozed', score: 100, reasons: [], nextAction: null,
        snoozedUntil: deal.healthSnooze.until
      });
    }

    // 新建宽限：刚录进去的单子没数据，硬算必然误伤。
    // 3 天内只认它是新的，不参与风险统计。
    const ageDays = (now - (Date.parse(deal.createdAt || 0) || now)) / DAY;
    if (ageDays < 3) {
      return Object.assign(base, { level: 'new', score: 100, reasons: [], nextAction: null, new: true });
    }

    const sens = clamp(Number(st.sensitivity) || 1, 0.4, 2.5);   // 越小越严格
    const c = window.Store.get('customers', deal.customerId);
    const level = (c && c.level) || 'B';
    const contact = (c && c.contact) || '联系人';
    const reasons = [];
    let score = 100;

    /* ---- 信号 1：沉默 ---- */
    const lt = lastTouchOf(deal);
    const silentDays = Math.max(0, (now - lt.at) / DAY);
    const learnedGap = cadenceOf(deal.customerId);
    // 应跟进间隔：有历史就用「客户平时节奏 ×1.6」；没有就按等级兜底
    let expectGap = learnedGap ? learnedGap * 1.6 : DEFAULT_SILENCE_DAYS[level];
    expectGap = clamp(expectGap * sens, 3, 180);
    const silenceRatio = silentDays / expectGap;
    if (silenceRatio > 1) {
      // 1 倍不扣分（刚到临界，只是提醒），2.5 倍及以上扣满
      const over = clamp((silenceRatio - 1) / 1.5, 0, 1);
      const pen = Math.round(over * 35);
      score -= pen;
      if (pen > 0 || silenceRatio > 1.2) {
        reasons.push({
          key: 'silence',
          weight: pen,
          text: `已 ${Math.round(silentDays)} 天没动静（你平时的节奏是约 ${Math.round(expectGap)} 天一次）`,
          action: `给${contact}打个电话，问一句「${base.stageName}这块卡在哪」`,
          actionType: 'follow'
        });
      }
    }

    /* ---- 信号 2：阶段停滞 ---- */
    const se = stageEnteredAt(deal);
    const stallDays = Math.max(0, (now - se.at) / DAY);
    const typical = typicalStageDays(deal.stage, level) * sens;
    const stallRatio = stallDays / typical;
    if (stallRatio > 1) {
      const over = clamp((stallRatio - 1) / 1.5, 0, 1);
      const pen = Math.round(over * 30);
      score -= pen;
      const nextStage = NEXT_OF[deal.stage];
      const nextName = nextStage ? window.Store.stageOf(nextStage).name : '赢单';
      if (pen > 0 || stallRatio > 1.2) {
        reasons.push({
          key: 'stall',
          weight: pen,
          text: `卡在「${base.stageName}」${Math.round(stallDays)} 天${se.real
            ? `（你通常 ${Math.round(typical)} 天）` : '（阶段起点是估算的，仅供参考）'}`,
          action: PUSH_TEXT[deal.stage] || (nextStage ? `推进到「${nextName}」` : '确认成交条件'),
          actionType: nextStage ? 'stage' : 'edit',
          nextStage: nextStage || ''
        });
      }
    }

    /* ---- 信号 3：临期 / 过期 ---- */
    let dd = window.Store.diffDays(deal.expectedClose);
    if (dd !== null && deal.expectedClose) {
      let pen = 0;
      let text = '';
      if (dd < 0) {
        pen = -dd > 14 ? 35 : 25;
        text = `预计成交日已过 ${-dd} 天，还挂在「${base.stageName}」`;
      } else if (dd <= 3) {
        pen = 12;
        text = `还剩 ${dd} 天到预计成交日，当前才在「${base.stageName}」`;
      } else if (dd <= 7) {
        pen = 6;
        text = `还有 ${dd} 天到预计成交日`;
      }
      if (pen) {
        score -= pen;
        reasons.push({
          key: 'deadline',
          weight: pen,
          text: text,
          action: dd < 0 ? '更新预计成交日，或老实标掉这单' : `确认${dd}天内能不能签，不能就改日期`,
          actionType: 'edit'
        });
      }
    }

    /* ---- 信号 4：无实质推进 ---- */
    if (!hasMomentum(deal, 30)) {
      score -= 10;
      reasons.push({
        key: 'momentum',
        weight: 10,
        text: '近 30 天没有实质推进（没换阶段、也没记跟进）',
        action: `约一次${contact}的拜访或演示，把节奏拉回来`,
        actionType: 'follow'
      });
    }

    score = clamp(Math.round(score), 0, 100);

    // 只保留真正扣了分的，避免「0 分提示」刷屏
    const shown = reasons.filter(r => r.text).sort((a, b) => b.weight - a.weight);

    let lvl = 'good';
    if (score < 50) lvl = 'risk';
    else if (score < 75) lvl = 'warn';

    return Object.assign(base, {
      level: lvl,
      score: score,
      reasons: shown,
      nextAction: shown[0] || null,
      signals: { silentDays: Math.round(silentDays), stallDays: Math.round(stallDays), expectGap: Math.round(expectGap), typical: Math.round(typical), dd: dd }
    });
  }

  /* ---------- 全量：在谈商机按风险排序 ---------- */
  function all() {
    return window.Store.list('deals')
      .filter(d => d.stage !== 'won' && d.stage !== 'lost')
      .map(d => ({ deal: d, h: of(d) }))
      .filter(x => x.h.level !== 'closed' && x.h.level !== 'off')
      .sort((a, b) => a.h.score - b.h.score);
  }

  /* ---------- 需要今天处理的（给看板 / 晨报用） ---------- */
  function attention() {
    return all().filter(x => x.h.level === 'risk' || x.h.level === 'warn');
  }

  /* ---------- 忽略 ---------- */
  function snooze(dealId, days) {
    const d = window.Store.get('deals', dealId);
    if (!d) return;
    const n = Number(days || settings().snoozeDays || 7);
    window.Store.update('deals', dealId, {
      healthSnooze: { until: Date.now() + n * DAY, days: n }
    });
    invalidate();
  }
  function unsnooze(dealId) {
    const d = window.Store.get('deals', dealId);
    if (!d) return;
    window.Store.update('deals', dealId, { healthSnooze: null });
    invalidate();
  }

  /* ---------- 基准快照：设置页展示「工具现在按什么节奏判断」 ---------- */
  function baseline() {
    ensureCache();
    const b = cache.baselines;
    return {
      stage: b.stage,
      sample: b.sample,
      learned: Object.keys(b.stage).length,
      total: Object.keys(DEFAULT_STAGE_DAYS.B).length
    };
  }

  /* ---------- 等级元信息 ---------- */
  const META = {
    risk: { name: '有风险', cls: 'hr-risk', dot: '#ef4444' },
    warn: { name: '需留意', cls: 'hr-warn', dot: '#f59e0b' },
    good: { name: '健康', cls: 'hr-good', dot: '#16a34a' },
    new: { name: '新建', cls: 'hr-new', dot: '#94a3b8' },
    snoozed: { name: '已忽略', cls: 'hr-new', dot: '#cbd5e1' },
    closed: { name: '已关闭', cls: 'hr-new', dot: '#cbd5e1' },
    off: { name: '未启用', cls: 'hr-new', dot: '#cbd5e1' }
  };
  const metaOf = id => META[id] || META.good;

  return {
    of, all, attention, snooze, unsnooze, settings, setSettings,
    baseline, invalidate, metaOf, META, cadenceOf, conversion, DEFAULT_STAGE_DAYS
  };
})();
