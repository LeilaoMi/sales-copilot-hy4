/* ============================================================
 * 销冠助手 · 一句话录入
 *
 * 录入的真正瓶颈不是打字慢，是**流程长**：切页面 → 选客户 → 选类型
 * → 写内容 → 填日期 → 保存，七步。刚挂完电话站在客户公司楼下，
 * 七步就够让人想"等会儿再记"，然后就忘了。
 *
 * 所以这里做的事是：打开就有一个输入框 → 一句话说完 → 自动拆字段
 * → 你看着对就回车。七步变两步。
 *
 * 设计原则：
 *  1. **规则优先，AI 兜底**。录入发生在电梯口、地铁里、客户公司楼下，
 *     不能依赖网络。规则能覆盖大部分常见说法，剩下的让用户手动补。
 *  2. **先出结果，再确认**。不做「回车即写库」——误识别会写进脏数据，
 *     而脏数据会污染健康度判断和回款预测，比不记更糟。
 *  3. **内容保留原文**。用户写的话就是最真实的记录，硬删关键词反而丢信息。
 * ============================================================ */
window.QuickLog = (function () {

  /* ---------- 跟进类型关键词 ---------- */
  const TYPE_WORDS = [
    ['电话', ['打电话', '通话', '致电', '电话', '打给', '打了', '通过电话', '拨了']],
    ['拜访', ['拜访', '上门', '到访', '去了一趟', '去了', '见面', '面谈', '当面', '登门']],
    ['会议', ['开会', '会议', '参会', '评审', '汇报', '过会', '碰了个会']],
    ['微信', ['微信', '发消息', '发了条', 'vx', 'VX']],
    ['邮件', ['邮件', '发邮件', '邮箱', '发了封']]
  ];

  /* ---------- 明确的「下次跟进」意图词 ----------
   * 只有出现这些词才设置 nextAt。
   * 「他说下周三报价」是对方的时间点，不等于我下次要联系他——
   * 这种语义规则分不清，宁可不设，误设比不设更烦人。 */
  const NEXT_INTENT = /(下次|下回|回头|再联系|再聊|再跟进|跟进|再约|过几天|过段时间|下次见|改天|后续|到时候)/;

  /* 找「下次跟进」的时间。
   * 关键：只在意图词**附近**找，否则会张冠李戴——
   * 「他说下周三报价，下次周一再联系」里，下周三是对方的时间点，
   * 我的下次联系是周一。找错了就会把跟进日设成一个跟我无关的日子。
   * 意图词后面找不到时间，就看意图词前16字窗口（「3天后跟进」「下周三再联系」时间在前）。
   * 绝不直接回退整句：整句含「今天去了…下周三再联系」时，parseDate会先命中「今天」，
   * 把下次跟进记成今天（2026-09-03实测复现）。宁可空着，也不误设今天。 */
  function parseNextAt(raw, now) {
    const m = String(raw || '').match(NEXT_INTENT);
    if (!m) return '';
    const s = String(raw);
    const after = s.slice(m.index + m[0].length);
    /* 「下次周一再联系」里的「下次」既是意图词，又是时间前缀。
     * 早期一律从意图词**之后**截，剩下「周一再联系」——前缀没了，
     * 「下次周一」退化成「本周的周一」，周一当天说这句，跟进日＝今天，
     * 这次跟进等于没排期。
     * 所以「下次/下回」要连同自身一起带进去解析；带进去解不出，
     * 再退回原来的切法，不改变其他句子的既有行为。 */
    const withWord = /^(下次|下回)/.test(m[0]) ? s.slice(m.index) : '';
    const direct = parseDate(withWord, now) || parseDate(after, now);
    if (direct) return direct;
    // 意图词前16字窗口：覆盖时间在前的情况，挡住句首行动时间
    const start16 = Math.max(0, m.index - 16);
    const near16 = s.slice(start16, m.index + m[0].length);
    if (!near16) return '';
    const res16 = parseDate(near16, now);
    if (!res16) return '';
    // 窗口内有今天也有具体日期时，优先具体的
    const stripped = near16.replace(/\u5927\u540e\u5929|\u4eca\u5929|\u4eca\u65e5|\u5f53\u5929|\u660e\u5929|\u660e\u65e5|\u540e\u5929/g, '');
    const specific = parseDate(stripped, now);
    if (specific) return specific;
    const TODAY_WORDS = ['\u5927\u540e\u5929', '\u4eca\u5929', '\u4eca\u65e5', '\u5f53\u5929', '\u660e\u5929', '\u660e\u65e5', '\u540e\u5929'];
    let lastPos = -1, lastW = '';
    TODAY_WORDS.forEach(function (w) {
      const p = near16.lastIndexOf(w);
      if (p >= 0 && p > lastPos) { lastPos = p; lastW = w; }
    });
    if (lastPos >= 0) {
      const mStartInNear = m.index - start16;
      const dist = mStartInNear - (lastPos + lastW.length);
      if (dist > 6) return '';
    }
    return res16;
  }

  const WEEK_MAP = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };

  /* ============================================================
   * 时间解析：纯函数，便于测试
   * 返回 YYYY-MM-DD，识别不出返回 ''
   * ============================================================ */
  function parseDate(text, now) {
    const S = window.Store;
    const base = now ? new Date(now) : new Date();
    base.setHours(0, 0, 0, 0);
    const t = String(text || '').replace(/\s/g, '');
    if (!t) return '';

    if (/今天|今日|当天/.test(t)) return S.fmtDate(base);
    if (/明天|明日/.test(t)) return S.addDays(S.fmtDate(base), 1);
    if (/大后天/.test(t)) return S.addDays(S.fmtDate(base), 3);
    if (/后天/.test(t)) return S.addDays(S.fmtDate(base), 2);

    /* 下周三 / 本周三 / 周三 / 下下周三
     * 按中国人的习惯：周一是一周的第一天 */
    /* 前缀只吃「下下/下/本/这」，「周」字留给后面的组。
     * 早期写成 (下下?周|本周)?(?:星期|周)(…)，「下周」会把「周」吃掉，
     * 导致「下周日」匹配不到后面的「周日」，退化成「本周日」。 */
    /* 前缀要把「下周」「下次」也收进来。
     *
     * 早期只写了 (下下|下|本|这)，要求它**紧挨着**「周」字，于是：
     *   「下周周一」→ 在「下周周」处匹配不上，回溯到后半段的「周一」，
     *                 前缀被丢掉，退化成「本周的周一」
     *   「下次周一」→ 「下」后面是「次」不是「周」，前缀同样丢失
     * 后果很具体：周一早上说「下次周一再联系」，跟进日被记成**今天**，
     * 等于这次跟进压根没有排期。
     *
     * 注意「下周」要排在「下」前面，否则「下周一」会先吃掉「下」，
     * 剩下「周一」里的「周」没得匹配。 */
    const wk = t.match(/(下下|下周|下次|下|本|这)?(?:星期|周)([一二三四五六日天])/);
    if (wk) {
      const target = WEEK_MAP[wk[2]];
      const cur = base.getDay();
      const mondayOff = cur === 0 ? -6 : 1 - cur;      // 本周一相对今天差几天
      const thisMonday = S.addDays(S.fmtDate(base), mondayOff);
      const idx = target === 0 ? 6 : target - 1;        // 周一=0 … 周日=6
      if (wk[1] === '下下') return S.addDays(thisMonday, 14 + idx);
      /* 「下周」「下次」「下」都按下个自然周算，口径和「下周三」保持一致 */
      if (wk[1] === '下' || wk[1] === '下周' || wk[1] === '下次') {
        return S.addDays(thisMonday, 7 + idx);
      }
      if (wk[1]) return S.addDays(thisMonday, idx);     // 本周/这周
      // 没说哪一周：本周的还没过就用本周，过了就用下周
      const d = S.addDays(thisMonday, idx);
      const diff = S.diffDays(d);
      return (diff !== null && diff < 0) ? S.addDays(thisMonday, 7 + idx) : d;
    }

    let m = t.match(/(\d+)天[后内]/);
    if (m) return S.addDays(S.fmtDate(base), Number(m[1]));
    m = t.match(/(\d+)个?周[后内]/);
    if (m) return S.addDays(S.fmtDate(base), Number(m[1]) * 7);
    m = t.match(/(\d+)个?月[后内]/);
    if (m) { const d = new Date(base); d.setMonth(d.getMonth() + Number(m[1])); return S.fmtDate(d); }

    m = t.match(/(\d{1,2})月(\d{1,2})[日号]/);
    if (m) {
      const y = base.getFullYear();
      const mm = Number(m[1]), dd = Number(m[2]);
      if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
        // 如果算出来已经过去了，按明年算（比如 12 月说"1月5日"）
        const d = new Date(y, mm - 1, dd);
        if (d < base) d.setFullYear(y + 1);
        return S.fmtDate(d);
      }
    }
    return '';
  }

  /* ============================================================
   * 客户匹配：全名优先，其次逐级缩短做简称匹配
   * ============================================================ */
  const HONORIFICS = ['\u8463\u4e8b\u957f', '\u7ecf\u7406', '\u4e3b\u4efb', '\u5382\u957f', '\u5e97\u957f', '\u5148\u751f', '\u5973\u58eb', '\u5c0f\u59d0', '\u8001\u677f', '\u8001\u5e08', '\u603b', '\u59d0', '\u54e5', '\u8463', '\u5de5'];
  const COMPOUND_SURNAMES = ['\u6b27\u9633', '\u53f8\u9a6c', '\u4e0a\u5b98', '\u8bf8\u845b', '\u4e1c\u65b9', '\u7687\u752b', '\u5c09\u8fdf', '\u516c\u5b59', '\u8f69\u8f95', '\u4ee4\u72d0', '\u949f\u79bb', '\u5b87\u6587', '\u957f\u5b59', '\u6155\u5bb9', '\u53f8\u5f92', '\u53f8\u7a7a'];
  function surnameOf(contact) {
    const c = String(contact || '').trim();
    if (!c) return '';
    if (c.length >= 2 && COMPOUND_SURNAMES.indexOf(c.slice(0, 2)) >= 0) return c.slice(0, 2);
    return c.slice(0, 1);
  }
  function matchCustomer(text) {
    const S = window.Store;
    const t = String(text || '');
    const list = S.list('customers');
    if (!t || !list.length) return null;

    // 第一轮：全名 / 全名联系人，取最长命中（"恒力精工" 优先于 "恒力"）
    let best = null, bestLen = 0;
    list.forEach(c => {
      [c.name, c.contact].forEach(n => {
        if (n && t.includes(n) && n.length > bestLen) { best = c; bestLen = n.length; }
      });
    });
    if (best) return { customer: best, via: 'full', matched: true };

    // 第二轮：简称，从 4 字递减到 2 字
    for (let len = 4; len >= 2; len--) {
      const hits = [];
      list.forEach(c => {
        const s = (c.name || '').slice(0, len);
        if (s.length === len && t.includes(s)) hits.push({ c: c, s: s });
      });
      // 同一长度多个命中 = 有歧义（"恒力" 可能指两家公司），交给用户选
      if (hits.length === 1) return { customer: hits[0].c, via: 'short', matched: true };
      if (hits.length > 1) {
        return { customer: null, via: 'ambiguous', candidates: hits.map(h => h.c), matched: false };
      }
    }
    const honorHits = [];
    list.forEach(c => {
      const surname = surnameOf(c.contact);
      if (!surname) return;
      for (let hi = 0; hi < HONORIFICS.length; hi++) {
        if (t.indexOf(surname + HONORIFICS[hi]) >= 0) { honorHits.push({ c: c, key: surname + HONORIFICS[hi] }); break; }
      }
    });
    if (honorHits.length === 1) return { customer: honorHits[0].c, via: 'honor', matched: true };
    if (honorHits.length > 1) {
      const uniq = {};
      honorHits.forEach(h => { uniq[h.c.id] = h.c; });
      const uniqList = Object.keys(uniq).map(k => uniq[k]);
      const refined = uniqList.filter(c => {
        const nm = c.name || '';
        for (let L = 4; L >= 2; L--) {
          const s = nm.slice(0, L);
          if (s.length === L && t.indexOf(s) >= 0) return true;
        }
        return false;
      });
      if (refined.length === 1) return { customer: refined[0], via: 'honor+short', matched: true };
      return { customer: null, via: 'ambiguous', candidates: uniqList, matched: false };
    }
    return { customer: null, via: 'none', matched: false };
  }

  /* ============================================================
   * 主解析
   * ============================================================ */
  function parse(text, now) {
    const S = window.Store;
    const raw = String(text || '').trim();
    const out = {
      raw: raw,
      customerId: '', customerName: '', type: '', content: raw,
      nextAt: '', confidence: 'low', via: 'none',
      candidates: [], hasNextIntent: false
    };
    if (!raw) return out;

    /* 类型：取第一个命中的关键词（按数组顺序，电话>拜访>会议>微信>邮件） */
    for (let i = 0; i < TYPE_WORDS.length; i++) {
      const [name, words] = TYPE_WORDS[i];
      if (words.some(w => raw.includes(w))) { out.type = name; break; }
    }

    /* 客户 */
    const mc = matchCustomer(raw);
    out.via = mc.via;
    if (mc.customer) {
      out.customerId = mc.customer.id;
      out.customerName = mc.customer.name;
    }
    if (mc.candidates) out.candidates = mc.candidates;

    /* 下次跟进：先要有明确的跟进意图词，再去找时间 */
    out.hasNextIntent = NEXT_INTENT.test(raw);
    if (out.hasNextIntent) out.nextAt = parseNextAt(raw, now);

    /* 置信度：客户 + 类型 + 内容，三项齐全才算高 */
    let score = 0;
    if (out.customerId) score++;
    if (out.type) score++;
    if (raw.length >= 6) score++;
    out.confidence = score >= 3 ? 'high' : score === 2 ? 'medium' : 'low';

    return out;
  }

  /* ============================================================
   * 保存：写入跟进 + 顺延客户下次跟进日
   * ============================================================ */
  function save(p) {
    const S = window.Store;
    if (!p.customerId || !p.content) return null;
    const at = new Date();
    const f = S.insert('followups', {
      customerId: p.customerId, dealId: '', type: p.type || '其他',
      at: at.toISOString(), content: p.content, nextAt: p.nextAt || ''
    });
    // 顺延客户的下次跟进日（跟手动记跟进的行为保持一致）
    if (p.nextAt) S.update('customers', p.customerId, { nextFollowAt: p.nextAt });
    return f;
  }

  /* ---------- 输入框 HTML（放在战情台顶部） ---------- */
  function box() {
    return `
    <div class="card qlbox">
      <div class="ql-row">
        <input id="ql-input" class="ql-input" type="text"
          placeholder="一句话记一笔：今天跟恒力王总聊了排产，他说下周三报价，下次周一再联系"
          autocomplete="off">
        <button class="btn btn-primary" data-action="ql-parse">记下来</button>
      </div>
      <div class="ql-hint">
        说出客户、方式和下次联系时间就行，剩下我来拆。
        <span class="muted">例：「拜访了优鲜陈敏，方案过了，下周三再跟进」</span>
      </div>
    </div>`;
  }

  /* ---------- 确认弹窗的表单字段 ---------- */
  function confirmFields(p) {
    const S = window.Store;
    const E = S.escapeHtml;
    const opts = S.list('customers').map(c =>
      `<option value="${c.id}" ${c.id === p.customerId ? 'selected' : ''}>${E(c.name)}${c.contact ? ' · ' + E(c.contact) : ''}</option>`).join('');
    return [
      {
        name: 'customerId', label: '客户', type: 'select', half: true,
        options: [{ value: '', label: p.candidates.length ? '请选择（有歧义）' : '未识别，请选择' }].concat(
          S.list('customers').map(c => ({ value: c.id, label: c.name + (c.contact ? ' · ' + c.contact : '') })))
      },
      {
        name: 'type', label: '跟进方式', type: 'select', half: true,
        options: S.FOLLOW_TYPES.map(t => ({ value: t, label: t }))
      },
      { name: 'content', label: '跟进内容', type: 'textarea' },
      { name: 'nextAt', label: '下次跟进（留空则不顺延）', type: 'date', half: true }
    ];
  }

  const CONF_TEXT = {
    high: '已自动识别，确认一下就能存',
    medium: '有一部分没认出来，补一下',
    low: '没能自动识别，手动填一下'
  };

  return { parse, parseDate, matchCustomer, save, box, confirmFields, CONF_TEXT, TYPE_WORDS };
})();
