/* coach.js —— 作战建议：此刻该说什么
 *
 * 为什么要有这个模块：
 * 话术库做得再聪明，也是**等人来搜**的。可销售真正被问住的那一刻，
 * 他在微信对话框里、在电话上，根本不会切到这个网页去搜。
 *
 * 于是 46 条话术就成了一本没人翻的字典。
 *
 * 换个思路：销售什么时候**一定会**打开这个工具？
 * 客户来电话前、打完电话后、准备联系一个客户之前 —— 他都会点开客户详情。
 * 那就把话术**推到他眼前**，而不是等他来搜。
 *
 * 这是从「检索工具」变成「作战助手」的关键一步。
 *
 * 依赖：Playbook（意图识别 + 检索）、Store（数据）
 * 无 IO、无 AI、无网络，纯本地计算。
 */
window.Coach = (function () {
  'use strict';

  const P = window.Playbook;
  const S = window.Store;

  /* 冷了多久算「该重新联系了」。
   * 优先复用周报里的口径 —— 同一个「冷」字在两个页面上要是两个标准，
   * 用户会觉得自己被两套数字糊弄。取不到就用 21 天兜底。 */
  const STALE_DAYS = (window.Report && window.Report.STALE_DAYS) || 21;

  /* 最多给几条。
   * 三条是上限，不是起点。销售点开客户详情是想看人，不是来读文章的 ——
   * 给十条等于一条都不给，他不会读。宁可只给最准的三条。 */
  const MAX_ITEMS = 3;

  /* 取最近几条跟进用来判断「客户现在在想什么」。
   * 只看最近三条：一个月前的异议早就不算数了，拿它推荐话术会驴唇不对马嘴。 */
  const RECENT_NOTES = 3;

  /* 阶段 → 这个阶段该说什么。
   * 用于「跟进记录里没挖出任何意图」时的兜底 ——
   * 没挖出意图不等于没事发生，很可能只是销售写得太简略。 */
  const STAGE_HINT = {
    lead: '第一次接触，先破冰、摸清是不是真需求',
    contact: '刚接触，挖痛点、找决策人',
    solution: '在做方案，讲清价值、别急着报价',
    quote: '报价中，锚定价值、别先让价',
    negotiate: '谈判中，守住底线、找交换条件',
    won: '已成交，做好回访、铺垫续约和转介绍',
    lost: '已输单，复盘一句话、留条后路'
  };

  /* 阶段 → 兜底检索词。STAGE_HINT 是给**人**看的，这个是给**检索**用的 */
  const STAGE_QUERY = {
    lead: '第一次联系 开场 破冰',
    contact: '挖掘需求 找到决策人',
    solution: '方案讲解 价值',
    quote: '报价 推进 临门一脚',
    negotiate: '谈判 让步 成交',
    won: '成交后回访 续约 转介绍',
    lost: '复盘'
  };

  function lastFollowAt(customerId) {
    const fus = S.list('followups').filter(f => f.customerId === customerId);
    if (!fus.length) return null;
    return fus.map(f => f.at).sort().pop();
  }

  /* 一个客户身上最靠前的那个商机阶段。
   * 一家客户可能同时有三四个商机，取最靠后的那个 ——
   * 都在谈了还给他推荐「开场破冰」，那是在侮辱他的智商。 */
  function frontStage(customerId) {
    const order = ['lead', 'contact', 'solution', 'quote', 'negotiate', 'won', 'lost'];
    const deals = S.list('deals').filter(d => d.customerId === customerId && d.stage !== 'lost');
    if (!deals.length) return null;
    let best = null, bestI = -1;
    deals.forEach(d => {
      const i = order.indexOf(d.stage);
      if (i > bestI) { bestI = i; best = d; }
    });
    return best ? best.stage : null;
  }

  /* 把识别出的意图按权重排序，取前几个。
   * intentsOf 返回的是 {意图: 权重}，权重按命中词的长度累加，
   * 所以「超预算」比「贵」权重高 —— 说得越具体，意图越明确。 */
  function topIntents(text, n) {
    const hit = P.intentsOf(text);
    return Object.keys(hit)
      .sort((a, b) => hit[b] - hit[a])
      .slice(0, n || 3);
  }

  function intentLabelText(keys) {
    return keys.map(k => P.intentLabel([k]) || k).filter(Boolean).join(' ');
  }

  /* 把多次检索的结果按得分合并去重。
   * 同一个场景会用不同的词检索好几次（意图标签、原文、阶段兜底），
   * 同一条话术被不同查询命中是好事 —— 说明它确实对口，得分累加。
   * 但只能出现一次，重复展示是在浪费那三条宝贵的名额。 */
  function mergeHits(buckets) {
    const map = new Map();
    buckets.forEach(list => {
      (list || []).forEach(h => {
        if (!h || !h.s || !h.s.id) return;
        const cur = map.get(h.s.id);
        if (cur) {
          cur.score += h.score || 0;
          if (h.why && cur.whys.indexOf(h.why) < 0) cur.whys.push(h.why);
        } else {
          map.set(h.s.id, { s: h.s, score: h.score || 0, whys: h.why ? [h.why] : [] });
        }
      });
    });
    return Array.from(map.values()).sort((a, b) => b.score - a.score);
  }

  /* 主函数：这个客户此刻该说什么
   * 返回 { scene, sceneText, items: [{s, why, mine}] }
   *   scene     场景代号，测试和展示都靠它
   *   sceneText 一句话说明「为什么给你这些」，给人看的
   *   items     话术列表，已去重排序
   */
  function suggest(customerId) {
    const c = S.get('customers', customerId);
    if (!c || !P) return { scene: 'none', sceneText: '', items: [] };

    const list = S.list('scripts');
    if (!list || !list.length) return { scene: 'none', sceneText: '', items: [] };

    const fus = S.list('followups')
      .filter(f => f.customerId === customerId)
      .sort((a, b) => String(b.at).localeCompare(String(a.at)));

    const recent = fus.slice(0, RECENT_NOTES);
    const recentText = recent.map(f => f.content || '').join(' ');
    const stage = frontStage(customerId);
    const buckets = [];

    /* ── 场景一：从没联系过 ─────────────────────────────
     * 这是最需要帮忙的时刻：刚建的客户，第一次电话该说什么？
     * 「没有数据就不说话」是最偷懒也最没用的设计 ——
     * 恰恰是这时候销售最虚。所以必须主动给开场白。 */
    if (!fus.length) {
      buckets.push(P.search(list, '第一次联系 开场 破冰 打招呼', { limit: 6 }));
      return finish('new', '刚建的客户，还没联系过 —— 先想好第一句话怎么说', buckets);
    }

    const lastAt = lastFollowAt(customerId);
    /* diffDays 的语义是「相对今天相差天数：负 = 已过期」——
     * 那是给「下次跟进日」用的（逾期为负）。这里要的是「上次跟进过去了多少天」，
     * 所以取个负号换成正数。
     *
     * 这个符号搞反不会报错，只是条件永远不成立，冷了三年的客户也永远
     * 走不到「该重新联系了」这个分支 —— 又是一个静默失效。
     * 所以别嫌啰嗦，把两条语义都写在注释里。 */
    const idle = lastAt === null ? null : -S.diffDays(lastAt);

    /* ── 场景二：冷了太久 ───────────────────────────────
     * 跟进记录里是有内容的，但都是一个月前的。
     * 这时候再推荐「应对价格异议」没意义 —— 客户早忘了报价多少了，
     * 现在要的是「怎么自然地重新搭上话」。 */
    if (idle !== null && idle > STALE_DAYS) {
      buckets.push(P.search(list, '很久没联系 激活 沉默老客户 重新搭话', { limit: 6 }));
      return finish('stale', '已经 ' + idle + ' 天没联系了 —— 先想好怎么自然地重新搭上话', buckets);
    }

    /* ── 场景三：最近跟进里有明确的客户意图 ───────────────
     * 最值钱的场景。客户说过「太贵了」「再考虑考虑」「跟领导汇报」，
     * 这些话里就藏着他卡在哪儿，直接针对它给话术。 */
    const intents = topIntents(recentText, 3);
    if (intents.length) {
      const labelText = intentLabelText(intents);
      /* 用「意图标签 + 最近那句话」两个角度各检索一次：
       * 光用标签会漏掉细节，光用原文会被无关词稀释。两个都查，得分合并。 */
      buckets.push(P.search(list, labelText, { limit: 6 }));
      buckets.push(P.search(list, recentText.slice(0, 120), { limit: 6 }));
      const why = '最近跟进里提到：' + labelText;
      return finish('intent', why, buckets);
    }

    /* ── 场景四：跟着商机阶段走 ─────────────────────────
     * 跟进写了，但没写出任何有效信息（「沟通顺利」这种）。
     * 这种情况很常见，不能因此就不给建议 —— 按阶段兜底。 */
    if (stage) {
      buckets.push(P.search(list, STAGE_QUERY[stage] || '', { limit: 6 }));
      return finish('stage', '在「' + S.stageOf(stage).name + '」阶段：' + (STAGE_HINT[stage] || ''), buckets);
    }

    /* ── 场景五：什么都没有 ─────────────────────────────
     * 有跟进、没商机、也没挖出意图。给最通用的开场。 */
    buckets.push(P.search(list, '第一次联系 开场', { limit: 6 }));
    return finish('plain', '还没挖出明确的顾虑，先把关系建立起来', buckets);
  }

  function finish(scene, sceneText, buckets) {
    const all = mergeHits(buckets);
    const items = all.slice(0, MAX_ITEMS).map(h => ({
      s: h.s,
      why: h.whys[0] || '',
      /* 标注「这是你自己记的」。
       * 用户自己攒下来的话术是他真踩过的坑，可信度和内置的不一样，
       * 让他一眼能认出来。 */
      mine: !h.s.builtin
    }));
    return { scene: scene, sceneText: sceneText, items: items };
  }

  return { suggest: suggest, STALE_DAYS: STALE_DAYS, MAX_ITEMS: MAX_ITEMS, STAGE_HINT: STAGE_HINT };
})();
