/* ============================================================
 * 销冠助手 · AI 陪练
 *
 * 一句话定位：**价值不在陪聊，在点评。**
 *   让 AI 扮演客户陪你聊，聊完你还是不知道自己哪句话说错了、哪句说得好，
 *   那这场练习等于没练 —— 只是花时间打了个字。
 *   所以这个功能的设计重心不在「对话」，在「复盘」：
 *   每三轮自动点评一次，结束时给整场打分。
 *
 * 没配 AI Key 也不能白屏，这一点是硬要求。
 *   降级方案不是弹一句「请先配置」就完事，而是真的还能练：
 *   话术库里每一条的标题本身就是客户台词（「客户说『太贵了』」），
 *   内容就是标准应对 —— 这天然就是一套离线对练素材。
 *   离线时抽一条台词让你答，答完拿标准应对做对照，自己判分。
 *   在线是「自由对练」，离线是「背书练习」，各有各的用处。
 *
 * 练出来的好话术要能一键存进话术库。
 *   自己在对练里琢磨出来的说法，比抄来的 48 条值钱得多
 *   （这个判断和 playbook.js 里「战后沉淀」是同一个）。
 * ============================================================ */
window.Sparring = (function () {
  'use strict';
  const S = window.Store;

  /* ---------- 难度 ----------
   * 三档不是「简单/普通/困难」这种空泛标签，
   * 而是三种具体的客户性格——模型照着演才演得像，
   * 只说「请表现得难一点」，它只会多啰嗦几句。 */
  const LEVELS = {
    easy: {
      name: '客气',
      desc: '愿意听你说，会给你铺垫，说不到位也只是含糊过去',
      persona: '性格随和，不赶时间，愿意多听你说几句。就算没被说服，也会客气地说「我再想想」，偶尔还会主动透露一点内部情况给你。'
    },
    normal: {
      name: '正常',
      desc: '有戒心，说不到点上就不买账',
      persona: '见过不少供应商，有戒心但不刁难。你说到点上他会认真考虑，说不到点上就直接敷衍。不会主动给你信息，要你问。'
    },
    hard: {
      name: '刁钻',
      desc: '话少、爱打断、拿竞品压价',
      persona: '很忙，没耐心，回复极短（常常就几个字）。习惯拿竞品压价，你一空洞他就打断。只有你真正解决他的顾虑，他才会多说两句。'
    }
  };

  /* ---------- 场景 ----------
   * 不在这里另写一份场景清单，而是从话术库里挑。
   * 好处：话术库补了新场景，这里自动就有，不用两边维护。
   * 判断依据是「标题长得像客户说的话」，也就是「客户说/问/觉得/担心」开头。 */
  function toScene(cat, title, tags, content) {
    if (!title) return null;
    if (!/^(\u5ba2\u6237|\u5bf9\u65b9)/.test(String(title).trim())) return null;
    return {
      key: title,
      category: cat || '',
      line: String(title).replace(/^\u5ba2\u6237(\u8bf4|\u95ee|\u89c9\u5f97|\u62c5\u5fc3)?/, '').replace(/^[\u300c\u300e]|([\u300d\u300f]$)/g, '').trim(),
      reference: content || '',
      tags: tags || []
    };
  }
  function scenes() {
    try {
      if (window.Store && Store.list) {
        const all = Store.list('scripts') || [];
        const out = [];
        all.forEach(function (it) {
          if (!it || !it.title) return;
          const sc = toScene(it.category, it.title, it.tags, it.content);
          if (sc) out.push(sc);
        });
        if (out.length) return out;
      }
    } catch (e) {}
    const P = window.Playbook;
    if (!P || !Array.isArray(P.SEED)) return [];
    const out = [];
    P.SEED.forEach(function (item) {
      const sc0 = toScene(item[0], item[1], item[2], item[3]);
      if (sc0) out.push(sc0);
      const title = item[1], cat = item[0], content = item[3], tags = item[2];
      if (!/^(客户|对方)/.test(String(title).trim())) return;
      if (false) out.push({
        key: title,
        category: cat || '',
        line: title.replace(/^客户(说|问|觉得|担心)?/, '').replace(/^[「『]|([」』]$)/g, '').trim(),
        reference: content || '',
        tags: tags || []
      });
    });
    return out;
  }

  /* ---------- 会话 ---------- */
  let session = null;

  const onAir = () => !!(session && session.turns && session.turns.length);
  const current = () => session;

  function start(sceneKey, level) {
    const list = scenes();
    const sc = list.find(x => x.key === sceneKey) || list[0] || null;
    session = {
      scene: sc,
      level: LEVELS[level] ? level : 'normal',
      turns: [],          // { role: 'me' | 'customer', text }
      reviews: [],        // 每次点评的文本
      startedAt: Date.now(),
      offline: false      // 走了离线降级时为 true
    };
    return session;
  }

  function stop() { session = null; }

  /* 离线降级：抽一条客户台词。
   * 优先抽当前场景那条，没有就随机抽一条。 */
  function offlineLine() {
    const list = scenes();
    if (!list.length) return null;
    if (session && session.scene) return session.scene;
    return list[Math.floor(Math.random() * list.length)];
  }

  const canUseAI = () => !!(window.AI && AI.cfg && AI.cfg().key);

  /* ---------- 扮演客户的系统提示 ---------- */
  function customerSystem(sc, level) {
    const lv = LEVELS[level] || LEVELS.normal;
    return [
      '你现在是一个真实的 B2B 采购方，正在和一名销售对话。你要演的是客户，不是助手。',
      '',
      '你的处境：' + (sc ? sc.line : '对销售推的东西兴趣不大，但还没完全拒绝'),
      '你的性格：' + lv.persona,
      '',
      '【极其重要的对话规则】',
      '1. 说人话。像微信聊天那样，口语、短句。不要用书面语，不要排比句，不要感叹号。',
      '2. 你不是来配合销售的。你有自己的顾虑和立场，销售说不到点上你就不买账。',
      '3. 一次只回一句，控制在 60 字以内。真实客户不会一次发一大段。',
      '4. 不要把答案递给销售。他不问，你就不主动交代内部情况。',
      '5. 销售的回答空洞、全是套话时，你要敷衍（「嗯」「再说吧」「收到」）。',
      '6. 销售真的解决了你的顾虑时，你要松动（「这倒是……」），但会接着追问下一步。',
      '7. 全程只输出你自己这一句台词，不要加任何旁白、括号、表情说明。'
    ].join('\n');
  }

  /* 开场：客户先开口 */
  async function opening() {
    if (!session) throw new Error('还没开始一场对练');
    if (!canUseAI()) {
      session.offline = true;
      const sc = offlineLine();
      if (!sc) throw new Error('话术库是空的，没法离线对练');
      session.scene = sc;
      session.turns.push({ role: 'customer', text: sc.line });
      return sc.line;
    }
    const sc = session.scene;
    const lv = LEVELS[session.level];
    const sys = customerSystem(sc, session.level);
    const first = await AI.chat(
      [{ role: 'user', content: '（模拟开始）请用你作为客户的身份，对销售说出第一句话，把你的顾虑抛出来。' }],
      { system: sys, temperature: 0.9 }
    );
    const line = String(first || '').trim().slice(0, 200) || (sc ? sc.line : '你们这个大概多少钱？');
    session.turns.push({ role: 'customer', text: line });
    void lv;
    return line;
  }

  /* 我说一句，客户回一句 */
  async function say(text) {
    if (!session) throw new Error('还没开始一场对练');
    const mine = String(text || '').trim();
    if (!mine) throw new Error('先说点什么吧');

    session.turns.push({ role: 'me', text: mine });

    if (!canUseAI()) {
      session.offline = true;
      /* 离线时没有人接话，把标准应对直接亮出来做对照。
       * 这不是「假装对练」，是明说了：现在是背书模式。 */
      const ref = (session.scene && session.scene.reference) || '';
      session.turns.push({ role: 'coach', text: ref });
      return { reply: '', reference: ref, offline: true };
    }

    const msgs = session.turns
      .filter(t => t.role === 'me' || t.role === 'customer')
      .map(t => ({ role: t.role === 'me' ? 'user' : 'assistant', content: t.text }));

    const reply = await AI.chat(msgs, {
      system: customerSystem(session.scene, session.level),
      temperature: 0.9
    });
    const line = String(reply || '').trim().slice(0, 200);
    session.turns.push({ role: 'customer', text: line });
    return { reply: line, offline: false };
  }

  /* ---------- 点评 ----------
   * 这是整个功能的重心。
   * 刻意要求「引用原话」和「指出第几轮」，是为了逼模型别输出
   * 「要注意倾听、要多提问」这种放之四海皆准的废话。 */
  async function review() {
    if (!session) throw new Error('还没开始一场对练');
    if (!canUseAI()) throw new Error('离线模式没法点评，配好 API Key 才能复盘');

    const script = session.turns
      .filter(t => t.role === 'me' || t.role === 'customer')
      .map((t, i) => `${i + 1}. ${t.role === 'me' ? '销售' : '客户'}：${t.text}`).join('\n');

    const prompt = [
      '你是带过一线团队的销售教练。下面是销售和一段客户对练的完整对话，请给这个销售复盘。',
      '',
      script,
      '',
      '严格按这三段输出，每段一个小标题：',
      '① 说对了的地方：具体引用他说过的某一句，说明为什么这句有效。挑不出就直说「这场里没有」，不要硬夸。',
      '② 没接住的地方：指出第几轮、客户那句话的真实意思是什么、他为什么没听出来。',
      '③ 换种说法：针对上面最要紧的那一处，给一句可以直接发出去的替代说法，口语化，60 字以内。',
      '',
      '要求：只讲这场对话里真实发生过的事，不要写「要学会倾听」这类通用建议。不超过 250 字。'
    ].join('\n');

    const r = await AI.chat([{ role: 'user', content: prompt }], { temperature: 0.5 });
    const text = String(r || '').trim();
    if (text) session.reviews.push({ at: Date.now(), text: text });
    return text;
  }

  /* ---------- 结束复盘：整场打分 ---------- */
  async function finish() {
    if (!session) return null;
    const mine = session.turns.filter(t => t.role === 'me');
    const summary = {
      turns: mine.length,
      minutes: Math.max(1, Math.round((Date.now() - session.startedAt) / 60000)),
      reviews: session.reviews.slice(),
      offline: session.offline
    };
    if (!canUseAI() || !mine.length) return summary;

    const script = session.turns
      .filter(t => t.role === 'me' || t.role === 'customer')
      .map((t, i) => `${i + 1}. ${t.role === 'me' ? '销售' : '客户'}：${t.text}`).join('\n');

    const prompt = [
      '下面是销售和一段客户对练的完整对话，请做整场复盘。',
      '',
      script,
      '',
      '输出四段：',
      '① 总分：0-100 的一个整数，并说明扣分扣在哪',
      '② 三个亮点：每一条都要引用他说过的原话',
      '③ 三个要改的地方：每一条都要指出是第几轮、当时该怎么说',
      '④ 一句话建议：下一次对练他最该练的一件事',
      '',
      '不超过 300 字。不要写通用建议。'
    ].join('\n');

    try {
      summary.final = String(await AI.chat([{ role: 'user', content: prompt }], { temperature: 0.5 }) || '').trim();
    } catch (e) {
      summary.final = '';
      summary.error = e.message;
    }
    return summary;
  }

  /* ---------- 把这场练出来的话存进话术库 ----------
   * 存的是「我在这场里说过的最好的一句」，由用户自己挑。
   * 这比任何内置话术都值钱 —— 那是他自己琢磨出来的说法。 */
  function saveAsScript(title, content) {
    const t = String(title || '').trim();
    const c = String(content || '').trim();
    if (!c) throw new Error('内容不能为空');
    return S.insert('scripts', {
      title: t || ('对练心得 · ' + S.fmtDate(new Date())),
      category: '我的对练',
      tags: ['对练', (session && session.scene && session.scene.category) || ''].filter(Boolean),
      content: c,
      builtin: false,
      source: 'sparring'
    });
  }

  /* 挑出这场里我说过的话，方便用户挑一句存下来 */
  function myLines() {
    if (!session) return [];
    return session.turns
      .map((t, i) => Object.assign({}, t, { index: i }))
      .filter(t => t.role === 'me');
  }

  /* ============================================================
   * 下面这一段是陪练自己的界面。
   *
   * 为什么不把 HTML 写进 views.js：这个模块是后加的，
   * 而 views.js 那会儿正被另一处在改。把界面和逻辑放在同一个文件里，
   * 对 views.js 的改动就只有一行 <div id="spar-root"> ——
   * 合并的时候不容易打架。事件用委托绑在容器上，
   * 也不需要 ui.js 那边再认得这些动作。
   * ============================================================ */
  const E = s => S.escapeHtml(String(s == null ? '' : s));

  let uiState = { busy: false, err: '', draft: '', result: '' };

  function render() {
    const hasKey = canUseAI();
    const list = scenes();
    let totalScripts = list.length;
    try { if (window.Store && Store.list) totalScripts = Store.list('scripts').length || list.length; } catch (e) {}
    const cur = session;

    /* 没开始：选场景 + 难度 */
    if (!cur) {
      const opts = list.map(sc =>
        `<option value="${E(sc.key)}">${E(sc.category ? sc.category + ' · ' : '')}${E(sc.line)}</option>`
      ).join('');
      const lv = Object.keys(LEVELS).map(k =>
        `<option value="${k}" ${k === 'normal' ? 'selected' : ''}>${E(LEVELS[k].name)} — ${E(LEVELS[k].desc)}</option>`
      ).join('');
      return `
      <div class="card">
        <div class="card-head">
          <div class="card-title">AI 陪练<span class="card-sub">AI 扮演客户，练完帮你复盘</span></div>
          <span class="badge" style="background:${hasKey ? '#16a34a' : '#94a3b8'}">
            ${hasKey ? 'AI 对练' : '离线背书模式'}
          </span>
        </div>
        <p class="small muted" style="margin-top:0">
          练话术最缺的不是话术，是<b>一个会怼你的客户</b>。
          ${hasKey
          ? '选一个场景，AI 扮演客户跟你过招；每三轮自动点评，结束时给整场打分。'
          : '<b>没配 API Key 也能练</b>：抽一条客户台词让你答，答完拿话术库里的标准应对做对照。配了 Key 才能自动点评。'}
        </p>
        <div class="field-row">
          <div class="field"><label>场景（话术库${totalScripts}条，其中${list.length}个适合对练）</label>
            <select id="spar-scene">${opts || '<option value="">话术库是空的</option>'}</select><div class="hint">HINT</div></div>
          <div class="field"><label>客户性格</label>
            <select id="spar-level">${lv}</select></div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-primary" data-spar="start" ${list.length ? '' : 'disabled'}>开始对练</button>
        </div>
        ${uiState.err ? `<div class="hint down">${E(uiState.err)}</div>` : ''}
        <div class="hint">陪练内容只存在这一次会话里，关掉页面就没了。
          练出好句子记得点「存进话术库」——那是你自己琢磨出来的，比抄来的值钱。</div>
      </div>`;
    }

    /* 进行中 */
    const sc = cur.scene || {};
    const bubbles = cur.turns.map((t, i) => {
      if (t.role === 'customer') {
        return `<div class="spar-row left"><div class="spar-bub cust"><span class="spar-who">客户</span>${E(t.text)}</div></div>`;
      }
      if (t.role === 'me') {
        return `<div class="spar-row right"><div class="spar-bub me"><span class="spar-who">我</span>${E(t.text)}</div>
          <button class="btn btn-ghost btn-sm" data-spar="save-line" data-i="${i}" title="存进话术库">存</button></div>`;
      }
      /* coach = 离线模式亮出的标准应对 */
      return `<div class="spar-row"><div class="spar-bub coach"><span class="spar-who">话术库参考答案</span>${E(t.text)}</div></div>`;
    }).join('');

    const reviewHtml = cur.reviews.map((r, i) =>
      `<div class="spar-review"><div class="section-title">第 ${i + 1} 次点评</div>${E(r.text)}</div>`
    ).join('');

    const myCount = cur.turns.filter(t => t.role === 'me').length;

    return `
    <div class="card">
      <div class="card-head">
        <div class="card-title">AI 陪练<span class="card-sub">${E(sc.line || '')}</span></div>
        <span class="badge" style="background:${cur.offline ? '#94a3b8' : '#16a34a'}">
          ${cur.offline ? '离线背书模式' : E(LEVELS[cur.level].name) + '客户'}
        </span>
      </div>
      <div id="spar-log" style="max-height:340px;overflow-y:auto;padding:4px 2px">
        ${bubbles || '<div class="small muted">还没开始说话</div>'}
      </div>
      ${reviewHtml}
      ${uiState.result ? `<div class="spar-review"><div class="section-title">整场复盘</div>${E(uiState.result)}</div>` : ''}
      ${uiState.err ? `<div class="hint down">${E(uiState.err)}</div>` : ''}

      <div class="field" style="margin-top:10px">
        <label>我说（像发微信那样，别写作文）</label>
        <textarea id="spar-input" rows="2" placeholder="例：理解，价格确实要算清楚。要不先做一个部门的试点？">${E(uiState.draft)}</textarea>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-primary" data-spar="send" ${uiState.busy ? 'disabled' : ''}>
          ${uiState.busy ? '客户在打字…' : '发送'}
        </button>
        <button class="btn" data-spar="review" ${uiState.busy || !hasKey ? 'disabled' : ''}>点评一下</button>
        ${myCount >= 2 ? '<button class="btn" data-spar="finish"' + (uiState.busy ? ' disabled' : '') + '>结束并复盘</button>' : ''}
        <button class="btn btn-ghost" data-spar="stop">退出</button>
      </div>
      ${cur.offline ? '<div class="hint">现在是离线背书模式：客户不会真的接话，每次说完会把话术库里的标准应对亮出来给你对照。</div>'
        : '<div class="hint">客户每三轮会被自动点评一次。想提前看，点「点评一下」。</div>'}
    </div>`;
  }

  /* 重新渲染自己这一块。
   * 不能调 UI.render()：那会把整个页面重画一遍，
   * 用户在别的卡片上填了一半的东西会丢。 */
  function paint() {
    const root = document.getElementById('spar-root');
    if (root) root.innerHTML = render();
    const log = document.getElementById('spar-log');
    if (log) log.scrollTop = log.scrollHeight;
  }

  function setErr(e) {
    uiState.err = e && e.message ? e.message : String(e || '');
  }

  async function guard(fn) {
    uiState.busy = true;
    uiState.err = '';
    paint();
    try { await fn(); }
    catch (e) { setErr(e); }
    finally { uiState.busy = false; paint(); }
  }

  /* 事件委托：绑一次就够了，重绘也不会失效 */
  let bound = false;
  function bind() {
    if (bound) return;
    bound = true;
    document.addEventListener('click', async function (ev) {
      const el = ev.target && ev.target.closest ? ev.target.closest('[data-spar]') : null;
      if (!el) return;
      const act = el.getAttribute('data-spar');

      if (act === 'start') {
        const scene = (document.getElementById('spar-scene') || {}).value || '';
        const level = (document.getElementById('spar-level') || {}).value || 'normal';
        guard(async function () {
          start(scene, level);
          await opening();
        });
      }
      else if (act === 'send') {
        const box = document.getElementById('spar-input');
        const text = box ? box.value : '';
        if (!String(text).trim()) return;
        uiState.draft = '';
        await guard(async function () {
          await say(text);
          /* 每三轮自动点评一次：练完不点评等于没练 */
          const mine = session ? session.turns.filter(t => t.role === 'me').length : 0;
          if (mine > 0 && mine % 3 === 0 && !session.offline && canUseAI()) {
            await review();
          }
        });
      }
      else if (act === 'review') {
        guard(async function () { await review(); });
      }
      else if (act === 'finish') {
        guard(async function () {
          const sum = await finish();
          uiState.result = (sum && sum.final) || '这场没有调用 AI（离线模式），没法自动复盘。';
        });
      }
      else if (act === 'stop') {
        stop();
        uiState = { busy: false, err: '', draft: '', result: '' };
        paint();
      }
      else if (act === 'save-line') {
        const i = Number(el.getAttribute('data-i'));
        const t = session && session.turns[i];
        if (!t) return;
        try {
          saveAsScript((session.scene && session.scene.line) || '对练心得', t.text);
          uiState.err = '';
          if (window.UI && UI.toast) UI.toast('已存进话术库', 'ok');
        } catch (e) { if (window.UI && UI.toast) UI.toast('存失败：' + e.message, 'err'); }
      }
    });
  }

  return {
    LEVELS, scenes, start, stop, opening, say, review, finish,
    saveAsScript, myLines, canUseAI,
    render, paint, bind,
    get current() { return current(); },
    onAir
  };
})();

/* 自己把事件接上，不等外部调用。
 *
 * 这是踩过的坑：外面只调了 Sparring.render() 把界面画出来，
 * 没人调 bind()，于是整块陪练的按钮全是死的 ——
 * 点了没反应、不报错、控制台干净，是最难查的那一种坏法。
 *
 * 自包含模块不该指望别人记得帮你接线。事件是委托在 document 上的，
 * 跟画没画出来无关，所以这里立刻绑就行。 */
(function () {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { window.Sparring.bind(); });
  } else {
    window.Sparring.bind();
  }
})();
