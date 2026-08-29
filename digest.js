/* =============================================================
 * digest.js —— 会话情报提取：把一段聊天记录变成结构化的东西
 *
 * 同类产品用大模型做这件事。这里用规则，理由和整个项目一致：
 * 销售谈完往往在电梯口、在车里，没网、没时间等一个 API 返回，
 * 而且规则提取的每一条都能说清「为什么抽出来」，错了用户一眼能看出来。
 *
 * 抽什么？按「忘了会出事」排序：
 *   ① 承诺 —— 我说过要发方案、他说过要回复。忘了就丢单，排第一
 *   ② 异议 —— 他当场提的顾虑，是这个单子真正的卡点
 *   ③ 下一步 + 时间 —— 没有时间的「后续再聊」等于没有
 *   ④ 金额/数量 —— 报价口径、采购量
 *   ⑤ 危险信号 —— 他在对比别家、他在犹豫、承诺悬空没日期
 *
 * 绝不自动入库。全部出草稿，勾选后由用户确认 ——
 * 一条误判的承诺写进跟进记录，比不记还糟。
 * ============================================================= */
window.Digest = (function () {
  'use strict';

  /* ---------- 分句与说话人 ---------- */

  /* 支持两种常见格式：
   *   1) 微信/QQ 手打：  王总：那个方案我们再看看
   *   2) 微信导出：      王总  10:23  ← 这一行只有名字和时间，内容在下一行 */
  const SPEAKER_COLON = /^([^\s:：]{1,16})\s*[:：]\s*(.*)$/;
  const SPEAKER_EXPORT = /^(.{1,20}?)\s+\d{1,2}:\d{2}$/;

  function splitLines(text) {
    const raw = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const out = [];
    let pending = null;
    raw.forEach(line => {
      let m = line.match(SPEAKER_COLON);
      if (m) {
        out.push({ who: m[1], text: m[2], raw: line });
        return;
      }
      m = line.match(SPEAKER_EXPORT);
      if (m) { pending = m[1]; return; }        // 内容在下一行
      if (pending) { out.push({ who: pending, text: line, raw: line }); pending = null; return; }
      out.push({ who: '', text: line, raw: line });   // 纯文本行，没有说话人
    });
    return out;
  }

  /* 一句话里常常塞着两个承诺 ——
   * 「下周给我吧，我下周要跟领导汇报」前一半是我的活，后一半是他的活。
   * 只取第一个代词会把后者算到我头上，所以必须先切碎再逐句判断。 */
  function splitClauses(t) {
    return String(t)
      .split(/[。！？；;!?\n]|,|，|、|\s{2,}/)
      .map(x => x.trim())
      .filter(x => x.length >= 4);
  }

  /* 判断一句话是谁说的。
   * 这个判断错了整个功能就废了 —— 「我下周发方案」和「您下周发方案」
   * 一个是我的承诺，一个是我对他的要求，写反了会害死人。 */
  function sideOf(name, ctx) {
    const n = String(name || '').trim();
    if (!n) return 'unknown';
    if (ctx.me.some(x => x && (n === x || n.indexOf(x) >= 0 || x.indexOf(n) >= 0))) return 'me';
    if (ctx.them.some(x => x && (n === x || n.indexOf(x) >= 0 || x.indexOf(n) >= 0))) return 'them';
    // 带敬称的一律算客户方：张总、李经理、王主任、陈董、刘老师
    if (/(总|经理|主任|董|老师|老板|哥|姐|工|医生|院长|部长|科长|主管)/.test(n)) return 'them';
    // 明确的自我指代
    if (/^(我|本人|咱们公司|我们)$/.test(n)) return 'me';
    return 'unknown';
  }

  /* ---------- 动作词 / 承诺 ---------- */
  const ACT = /(发|发给|给|寄|寄给|安排|对接|拉个|拉|整理|出|做|改|补|确认|提供|反馈|回复|回|签字|签|付款|打款|汇款|转账|下单|测试|试用|上线|培训|报价|评估|上会|汇报|推进|约|见|聊|沟通|看|核实|查|准备|写|拟|盖章|开票|发货|安装|部署|调试|验收)/;

  /* 「会/要/尽量/争取」这类是将来时；「已经/刚/昨天」是过去时，不该算待办。
   * 「先/吧/一下/麻烦/请/能否」是祈使语气 —— 客户一句「下周给我吧」「你先发来看看」
   * 就是实打实的要求，没有它们这类句子会被整个漏掉。 */
  const FUTURE = /(会|要|马上|尽快|回头|稍后|随后|接着|下一步|接下来|准备|打算|计划|争取|尽量|记得|别忘了|先|吧|一下|看看|可否|能否|能不能|麻烦|请|到时候|抽空|有空|下周|本周|明天|明日|后天|大后天|下个月|月底|月初|年中|年底|改天|过两天|过几天|这两天|到时候|择日)/;
  /* 注意别把「之前」放进来：「下周三之前发给你」指的是未来，
   * 一旦当成过去时，这类带期限的承诺会被整条漏掉 —— 恰恰是最不能漏的。 */
  const PAST = /(已经|已|刚|刚刚|昨天|前天|上周|上次|早就|早已|过了)/;

  const PROMISE_ME = /(我|我们|这边|本人|咱|俺)/;
  const PROMISE_YOU = /(您|你|贵司|贵公司|你们)/;

  /* 动作的流向：东西是给「我」还是给「您」。
   * 中文经常省略主语（「下周给我吧」没说是谁给），只能靠这个兜底。 */
  const TO_ME = /(给我|发我|给我发|给我看|给我一份|给我出|给我们|发给我|寄给我|转给我|打给我|回复我|反馈我|通知我|告诉我|告知我|发过来|寄过来)/;
  const TO_YOU = /(给您|给你|发您|发你|给您发|给你发|寄给您|转给您|回复您|反馈您|告诉您|告诉你|发过去|寄过去|贵司|贵公司)/;

  /* 找句子里的第一个人称代词，它就是动作的执行者。
   * 这一步是整个功能的成败关键 ——
   * 「我明天发您报价」主语是我 → 我的活；
   * 「您把预算发我」主语是您 → 对方的活。
   * 只看句子里有没有「您」是错的：「我发您」里您是接收者不是执行者。 */
  function subjectOf(t) {
    const P = /(我|我们|咱|俺|本人|您|你|你们|贵司|贵公司)/;
    // 句首代词优先 —— 中文主语绝大多数在句首
    const head = String(t).match(new RegExp('^(' + P.source + ')'));
    if (head) return head[1];
    /* 不能直接在全文里找代词：「下周给我吧」里的「给我」会被当成主语，
     * 结果客户对我的要求被记成了客户自己的承诺。
     * 先把「给/发/寄/告诉 + 我/您」这种接收者位置剔掉再找。 */
    const cleaned = String(t).replace(/(给|发|寄|转|告诉|告知|回复|反馈|通知|提交)(我|您|你|我们|你们|贵司)/g, '');
    const m = cleaned.match(P);
    return m ? m[1] : '';
  }

  /* 把一条承诺归到「我的活」还是「他的活」。
   * 依据：主语是谁 + 说话人是谁。句子里的「您」在客户口中指销售，反之亦然。 */
  function bucketOf(who, t) {
    const subj = subjectOf(t);
    const isMeSide = (p) => p === '我' || p === '我们' || p === '咱' || p === '俺' || p === '本人';
    const isYouSide = (p) => p === '您' || p === '你' || p === '你们' || p === '贵司' || p === '贵公司';

    if (isMeSide(subj)) return who === 'me' ? 'mine' : 'theirs';   // 自称＝说话人自己干
    if (isYouSide(subj)) return who === 'me' ? 'theirs' : 'mine';  // 称「您」＝对方干

    // 没主语，看东西流向谁
    if (TO_ME.test(t)) return who === 'me' ? 'theirs' : 'mine';
    if (TO_YOU.test(t)) return who === 'me' ? 'mine' : 'theirs';

    // 都没有，按说话人默认：自己说的默认自己干
    return who === 'them' ? 'theirs' : 'mine';
  }

  /* ---------- 金额与数量 ---------- */
  const MONEY = /(\d+(?:\.\d+)?)\s*(万|w|W|千万|百万|千|k|K|元|块|块钱|美金|美元| euro|欧元)/g;
  const COUNT = /(\d+(?:\.\d+)?)\s*(个|套|台|人|家|店|条|年|月|期|次|份|张|把|箱|吨|米|平)/g;

  /* ---------- 危险信号 ---------- */
  const RISK_WORDS = [
    { k: 'comparison', re: /(对比|比较|比价|别家|其他家|友商|竞品|另一家|货比三家)/, msg: '他在横向对比 —— 这单有竞争者，报价和差异化要提前备好' },
    { k: 'hesitate', re: /(再看看|再想想|考虑|商量|研究|不一定|再说吧|回头说|待定)/, msg: '他犹豫了 —— 别等，24 小时内补一次价值信息' },
    { k: 'budget', re: /(没预算|预算不够|超预算|没钱|资金紧|明年再说)/, msg: '预算有问题 —— 要么换时间轴，要么砍范围保住单子' },
    { k: 'boss', re: /(领导|老板|汇报|上会|审批|拍板|签字|决策)/, msg: '还没到决策人 —— 要一份能直接转给领导的一页纸材料' },
    { k: 'cold', re: /(不急|不着急|以后再说|慢慢来|暂缓|搁置|等等|等一等)/, msg: '他在拖 —— 拖单大多会黄，得给他一个「现在做」的理由' },
    { k: 'lost_signal', re: /(算了|不要了|不做了|先不|暂不需要|取消|放弃)/, msg: '出现退意信号 —— 这单可能正在流失，建议今天内确认真实原因' }
  ];

  /* =============================================================
   * 主函数
   *   text   粘贴的聊天记录
   *   ctx    { me: [我的名字/自称], them: [客户名/联系人], now: Date }
   * ============================================================= */
  function analyze(text, ctx) {
    ctx = ctx || {};
    const me = [].concat(ctx.me || []).filter(Boolean);
    const them = [].concat(ctx.them || []).filter(Boolean);
    const now = ctx.now || new Date();
    const side = { me: me, them: them };

    const lines = splitLines(text);

    const mine = [];        // 我承诺的（要兑现，忘了丢单）
    const asks = [];        // 我请客户做的（要盯）
    const theirs = [];      // 客户承诺的（要催）
    const objections = [];  // 异议
    const nextSteps = [];   // 下一步
    const money = [];
    const counts = [];
    const risks = [];
    const people = [];

    const PB = window.Playbook;
    const seen = {};

    lines.forEach(ln => {
      const who = sideOf(ln.who, side);
      if (!ln.text) return;

      /* 说话人名字里带敬称的，记下来 —— 可能是还没接触到的决策人 */
      if (who === 'them' && ln.who && people.indexOf(ln.who) < 0) people.push(ln.who);

      splitClauses(ln.text).forEach(t => {

      /* ---- 时间 ---- */
      /* 时间解析是「锦上添花」，不能因为它的异常把整段分析拖崩 ——
       * 承诺和异议才是主角，没日期顶多是悬空，没承诺可就全丢了。 */
      let when = '';
      try {
        if (window.QuickLog && window.QuickLog.parseDate) {
          when = window.QuickLog.parseDate(t, now) || '';
        }
      } catch (e) { when = ''; }

      /* ---- 承诺 ---- */
      if (ACT.test(t) && !PAST.test(t)) {
        const isFuture = FUTURE.test(t) || !!when;
        if (isFuture) {
          const hasMe = PROMISE_ME.test(t);
          const hasYou = PROMISE_YOU.test(t);
          const item = { text: t, at: when, who: who, raw: ln.raw };

          const b = bucketOf(who, t);
          if (b === 'mine') mine.push(item);
          else if (b === 'theirs') theirs.push(item);
          else asks.push(item);
        }
      }

      /* ---- 异议：复用话术库的意图词典，不另起炉灶 ---- */
      if (PB && PB.intentsOf) {
        const it = PB.intentsOf(t);
        const OBJ = ['price', 'hesitate', 'compare', 'boss', 'budget', 'urgenNow',
          'risk', 'deploy', 'trust', 'security', 'trial', 'contract', 'diy'];
        const hit = Object.keys(it).filter(k => OBJ.indexOf(k) >= 0);
        if (hit.length && who !== 'me') {
          objections.push({ text: t, kind: PB.intentLabel(hit.slice(0, 2)), keys: hit, at: when });
        }
      }

      /* ---- 下一步 ---- */
      if (when && (FUTURE.test(t) || ACT.test(t))) {
        nextSteps.push({ text: t, at: when, who: who });
      }

      /* ---- 金额 / 数量 ---- */
      let m;
      MONEY.lastIndex = 0;
      while ((m = MONEY.exec(t)) !== null) {
        money.push({ num: Number(m[1]), unit: m[2], text: t });
      }
      COUNT.lastIndex = 0;
      while ((m = COUNT.exec(t)) !== null) {
        counts.push({ num: Number(m[1]), unit: m[2], text: t });
      }

      /* ---- 危险信号（去重，同一类只报一次） ---- */
      RISK_WORDS.forEach(r => {
        if (!seen[r.k] && r.re.test(t)) {
          seen[r.k] = 1;
          risks.push({ k: r.k, msg: r.msg, text: t });
        }
      });
      });
    });

    /* ---- 悬空承诺：说了要干但没日期 ---- */
    const dangling = mine.concat(theirs).filter(x => !x.at);

    /* ---- 摘要 ---- */
    const summary = buildSummary({ mine, theirs, asks, objections, nextSteps, money, risks, lineCount: lines.length });

    return {
      lineCount: lines.length,
      summary: summary,
      mine: dedupe(mine),
      theirs: dedupe(theirs),
      asks: dedupe(asks),
      objections: dedupe(objections),
      nextSteps: dedupe(nextSteps),
      money: money,
      counts: counts,
      risks: risks,
      people: people,
      dangling: dangling.length
    };
  }

  function dedupe(arr) {
    const seen = {}, out = [];
    arr.forEach(x => {
      const k = String(x.text || '');
      if (seen[k]) return;
      seen[k] = 1;
      out.push(x);
    });
    return out;
  }

  /* 摘要不是流水账，是「下次打开时能一眼接上」的那几句话 */
  function buildSummary(r) {
    const parts = [];
    if (r.mine.length) parts.push('我答应了 ' + r.mine.length + ' 件事');
    if (r.theirs.length) parts.push('客户承诺 ' + r.theirs.length + ' 项');
    if (r.asks.length) parts.push('等客户反馈 ' + r.asks.length + ' 项');
    if (r.objections.length) {
      // 按意图槽去重，而不是按显示串 —— 否则会出现
      // 「价格异议、价格异议 / 预算问题」这种自己重复自己
      const ks = [];
      r.objections.forEach(o => (o.keys || []).forEach(k => { if (ks.indexOf(k) < 0) ks.push(k); }));
      const label = (window.Playbook && window.Playbook.intentLabel)
        ? window.Playbook.intentLabel(ks.slice(0, 3))
        : ks.slice(0, 3).join('、');
      if (label) parts.push('客户顾虑：' + label);
    }
    if (r.money.length) {
      const mx = r.money.reduce((a, b) => (b.num > a.num ? b : a), r.money[0]);
      parts.push('涉及金额 ' + mx.num + mx.unit);
    }
    if (r.nextSteps.length) {
      const soon = r.nextSteps.filter(x => x.at).sort((a, b) => (a.at < b.at ? -1 : 1))[0];
      if (soon) parts.push('下一步 ' + soon.at);
    }
    if (!parts.length) {
      return r.lineCount
        ? '这段对话没抽出明确的承诺或时间点，建议手动补一句「下次要做什么」。'
        : '';
    }
    return parts.join('；') + '。';
  }

  /* ---------- 生成可入库的跟进正文 ----------
   * 用户确认后，这段文本会作为跟进记录存下来。
   * 写得像人话，方便三个月后一眼看懂。 */
  function toNote(r, opts) {
    opts = opts || {};
    /* 防御：调用方漏传某个桶时不能让整个保存流程崩掉。
     * 这里曾经因为调用方少传 asks，r.asks.length 直接抛异常，
     * 用户点了「存入跟进记录」什么都没发生。缺桶按空处理。 */
    const B = k => (r && Array.isArray(r[k])) ? r[k] : [];
    const L = [];
    if (r && r.summary) L.push(r.summary);
    L.push('');

    if (B('mine').length) {
      L.push('【我承诺】');
      B('mine').forEach(x => L.push('· ' + x.text + (x.at ? '（' + x.at + '前）' : '（没定时间）')));
      L.push('');
    }
    if (B('theirs').length) {
      L.push('【客户承诺】');
      B('theirs').forEach(x => L.push('· ' + x.text + (x.at ? '（' + x.at + '前）' : '（没定时间）')));
      L.push('');
    }
    if (B('asks').length) {
      L.push('【等客户反馈】');
      B('asks').forEach(x => L.push('· ' + x.text));
      L.push('');
    }
    if (B('objections').length) {
      L.push('【客户顾虑】');
      B('objections').forEach(x => L.push('· [' + x.kind + '] ' + x.text));
      L.push('');
    }
    if (B('nextSteps').length) {
      L.push('【下一步】');
      B('nextSteps').forEach(x => L.push('· ' + (x.at ? x.at + ' ' : '') + x.text));
      L.push('');
    }
    if (B('money').length) {
      L.push('【金额】' + B('money').map(x => x.num + x.unit).join('、'));
    }
    return L.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  return { analyze: analyze, toNote: toNote, splitLines: splitLines, sideOf: sideOf };
})();
