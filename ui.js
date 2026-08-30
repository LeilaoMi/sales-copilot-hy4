/* ============================================================
 * 销冠助手 · 交互层
 * ============================================================ */
(function () {
  const S = Store, V = Views, E = S.escapeHtml;
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));

  let view = 'dash';
  const filters = {
    customers: { q: '', level: '', status: '', sort: 'next' },
    followups: { customerId: '', type: '' },
    scripts: { cat: '', q: '' },
    report: { range: 'thisWeek' },
    ai: { scenario: 'followup', customerId: '' }
  };
  let formSubmit = null;
  /* 从商机表单里直接选了赢/输时，先记下来，等表单关掉、页面重绘完再弹。
   * 当场弹的话，紧接着的 closeModal() 会把它一起收走。
   * 声明放在顶部而不是用到的地方：onSubmit 是回调，
   * 放在下面虽然运行时侥幸不出错，但读代码的人会以为它是个新变量。 */
  let pendingDebrief = null;

  /* ---------- Toast ---------- */
  function toast(msg, type) {
    const el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 2400);
  }

  /* ---------- 模态 ---------- */
  function openModal(html) {
    const bd = $('#modal-backdrop');
    $('#modal').innerHTML = html;
    bd.hidden = false;          // 双保险：不依赖 CSS 的 [hidden] 规则
    bd.style.display = 'flex';
    document.body.classList.add('modal-open');   // 让 Toast 移到顶部，别压住底部按钮
    const first = $('#modal input,#modal select,#modal textarea');
    if (first && !first.type.includes('hidden')) first.focus();
  }
  function closeModal() {
    const bd = $('#modal-backdrop');
    bd.hidden = true;
    bd.style.display = 'none';  // 关键：display:none，确保遮罩不再拦截任何点击
    document.body.classList.remove('modal-open');
    $('#modal').innerHTML = '';
    formSubmit = null;
  }

  function confirmBox(title, text, onOk, okText) {
    openModal(`
      <div class="modal-head"><h3>${E(title)}</h3><button class="x-btn" data-action="close-modal">×</button></div>
      <div class="modal-body"><div>${text}</div></div>
      <div class="modal-foot">
        <button class="btn" data-action="close-modal">取消</button>
        <button class="btn ${okText ? 'btn-danger' : 'btn-primary'}" data-action="confirm-ok">${E(okText || '确定')}</button>
      </div>`);
    formSubmit = onOk;
  }

  /* ---------- 通用表单 ---------- */
  function fieldHtml(f, val) {
    const v = val == null ? '' : val;
    const req = f.required ? ' required' : '';
    let inner = '';
    if (f.type === 'select') {
      inner = `<select name="${f.name}"${req}>` +
        (f.placeholder ? `<option value="">${E(f.placeholder)}</option>` : '') +
        (f.options || []).map(o => {
          const value = typeof o === 'object' ? o.value : o;
          const label = typeof o === 'object' ? o.label : o;
          return `<option value="${E(value)}" ${String(v) === String(value) ? 'selected' : ''}>${E(label)}</option>`;
        }).join('') + '</select>';
    } else if (f.type === 'textarea') {
      inner = `<textarea name="${f.name}" placeholder="${E(f.placeholder || '')}"${req}>${E(v)}</textarea>`;
    } else {
      inner = `<input type="${f.type || 'text'}" name="${f.name}" value="${E(v)}"
        placeholder="${E(f.placeholder || '')}"${req}${f.min != null ? ' min=' + f.min : ''}${f.step ? ' step=' + f.step : ''}>`;
    }
    return `<div class="field"><label>${E(f.label)}</label>${inner}${f.hint ? `<div class="hint">${E(f.hint)}</div>` : ''}</div>`;
  }

  function openForm(opts) {
    let body = '', buf = [];
    const flush = () => { if (buf.length) { body += buf.length > 1 ? `<div class="field-row">${buf.join('')}</div>` : buf[0]; buf = []; } };
    (opts.fields || []).forEach(f => {
      if (f.half) { buf.push(fieldHtml(f, (opts.values || {})[f.name])); if (buf.length === 2) flush(); }
      else { flush(); body += fieldHtml(f, (opts.values || {})[f.name]); }
    });
    flush();

    openModal(`
      <div class="modal-head"><h3>${E(opts.title)}</h3><button class="x-btn" data-action="close-modal">×</button></div>
      <form id="mform" autocomplete="off">
        <div class="modal-body">${body}${opts.note ? `<div class="hint">${opts.note}</div>` : ''}</div>
        <div class="modal-foot">
          <button type="button" class="btn" data-action="close-modal">取消</button>
          <button type="submit" class="btn btn-primary">${E(opts.submitText || '保存')}</button>
        </div>
      </form>`);
    formSubmit = opts.onSubmit;
    const form = $('#mform');
    form.addEventListener('submit', ev => {
      ev.preventDefault();
      const data = {};
      new FormData(form).forEach((v, k) => { data[k] = typeof v === 'string' ? v.trim() : v; });
      const cb = formSubmit;
      if (cb) cb(data);
    });
  }

  function readVal(name) { const el = $('#' + name); return el ? el.value.trim() : ''; }

  function toLocalInput(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return `${S.fmtDate(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  /* ---------- 一句话录入 ---------- */
  function qlParse() {
    if (!window.QuickLog) return;
    const el = $('#ql-input');
    const text = (el && el.value || '').trim();
    if (!text) {
      toast('先说点什么，比如「拜访了恒力王总，下周再跟进」', 'err');
      if (el) el.focus();
      return;
    }
    const p = QuickLog.parse(text);
    openForm({
      title: '确认这一笔',
      submitText: '保存',
      values: { customerId: p.customerId, type: p.type || '电话', content: p.content, nextAt: p.nextAt },
      fields: QuickLog.confirmFields(p),
      note: QuickLog.CONF_TEXT[p.confidence] +
        (p.via === 'ambiguous' ? '（客户名有歧义，已列出候选，请确认选对）' : ''),
      onSubmit: v => {
        if (!v.customerId) { toast('得先选一个客户', 'err'); return; }
        if (!v.content) { toast('内容不能为空', 'err'); return; }
        QuickLog.save(v);
        if (window.Health) Health.invalidate();
        closeModal();
        render();
        toast('已记下 · ' + S.customerName(v.customerId), 'ok');
      }
    });
  }

  /* ============================================================
   * 表单定义
   * ============================================================ */
  function customerForm(c) {
    const isNew = !c;
    c = c || { level: 'B', status: '潜在', industry: '', source: '', nextFollowAt: S.addDays(S.todayStr(), 3) };
    openForm({
      title: isNew ? '新增客户' : '编辑客户 · ' + c.name,
      values: c,
      fields: [
        { name: 'name', label: '客户名称（公司）', required: true, placeholder: '例：恒力精工制造' },
        { name: 'contact', label: '联系人', half: true, placeholder: '例：王建国' },
        { name: 'title', label: '职务', half: true, placeholder: '例：生产副总' },
        { name: 'phone', label: '电话', half: true, placeholder: '手机号' },
        { name: 'wechat', label: '微信', half: true },
        {
          name: 'level', label: '分级', half: true, type: 'select',
          options: S.LEVELS.map(l => ({ value: l.id, label: l.name }))
        },
        {
          name: 'status', label: '状态', half: true, type: 'select',
          options: S.CUSTOMER_STATUS
        },
        { name: 'industry', label: '行业', half: true, type: 'select', placeholder: '未分类', options: S.INDUSTRIES },
        { name: 'source', label: '来源', half: true, type: 'select', placeholder: '未知', options: S.SOURCES },
        { name: 'nextFollowAt', label: '下次跟进日期', type: 'date', hint: '留空则不提醒；到期会出现在「今日作战清单」' },
        { name: 'tags', label: '标签（逗号分隔）', placeholder: '例：决策人已见,预算充足,需招标' },
        { name: 'note', label: '备注 / 客户画像', type: 'textarea', placeholder: '组织关系、决策链、竞品、禁忌话题……' }
      ],
      onSubmit: d => {
        if (!d.name) { toast('客户名称必填', 'err'); return; }
        d.createdAt = c.createdAt || new Date().toISOString();
        if (isNew) { S.insert('customers', d); toast('客户已建档', 'ok'); }
        else { S.update('customers', c.id, d); toast('已保存', 'ok'); }
        closeModal(); render();
      }
    });
  }

  function dealForm(d, presetCustomerId) {
    const isNew = !d;
    d = d || {
      customerId: presetCustomerId || '', stage: 'lead',
      expectedClose: S.addDays(S.todayStr(), 30), amount: ''
    };
    const customers = S.list('customers');
    if (!customers.length) { toast('先建档客户，再建商机', 'err'); return; }
    openForm({
      title: isNew ? '新建商机' : '编辑商机 · ' + d.title,
      values: d,
      fields: [
        { name: 'title', label: '商机名称', required: true, placeholder: '例：智能排产系统（2条产线）' },
        {
          name: 'customerId', label: '所属客户', type: 'select', required: true,
          placeholder: '请选择', options: customers.map(c => ({ value: c.id, label: c.name }))
        },
        { name: 'amount', label: '金额（元）', type: 'number', min: 0, step: 1000, required: true, half: true },
        {
          name: 'stage', label: '阶段', type: 'select', half: true,
          options: S.STAGES.map(s => ({ value: s.id, label: `${s.name}（赢率 ${s.prob}%）` }))
        },
        { name: 'expectedClose', label: '预计成交日', type: 'date' },
        { name: 'lostReason', label: '输单原因（选「输单」时填写）', placeholder: '例：价格高出竞品 30%' },
        { name: 'note', label: '备注', type: 'textarea', placeholder: '关键人态度、卡点、下一步动作……' }
      ],
      onSubmit: v => {
        if (!v.title || !v.customerId) { toast('名称和客户必填', 'err'); return; }
        v.amount = Number(v.amount) || 0;
        v.updatedAt = new Date().toISOString();
        if (isNew) {
          v.createdAt = new Date().toISOString();
          const nd = S.insert('deals', v);
          S.setStage(nd.id, v.stage, true);   // 触发赢单/输单联动
          if (v.stage === 'won' || v.stage === 'lost') pendingDebrief = nd.id;
          toast('商机已创建', 'ok');
        } else {
          S.update('deals', d.id, v);
          S.setStage(d.id, v.stage);
          if (v.stage === 'won' || v.stage === 'lost') pendingDebrief = d.id;
          toast('已保存', 'ok');
        }
        closeModal(); render();
        if (pendingDebrief) {
          const pid = pendingDebrief;
          pendingDebrief = null;
          maybeDebrief(S.get('deals', pid));
        }
      }
    });
  }

  function followupForm(customerId) {
    const customers = S.list('customers');
    if (!customers.length) { toast('先建档客户', 'err'); return; }
    const now = new Date();
    const values = {
      customerId: customerId || customers[0].id,
      dealId: '', type: '电话', at: toLocalInput(now.toISOString()),
      content: '', nextAt: S.addDays(S.todayStr(), 7)
    };
    const deals = S.list('deals').filter(x => x.customerId === values.customerId);
    openForm({
      title: '记一笔跟进',
      values,
      fields: [
        {
          name: 'customerId', label: '客户', type: 'select', required: true, half: true,
          options: customers.map(c => ({ value: c.id, label: c.name + (c.contact ? '（' + c.contact + '）' : '') }))
        },
        { name: 'type', label: '方式', type: 'select', half: true, options: S.FOLLOW_TYPES },
        { name: 'at', label: '沟通时间', type: 'datetime-local', half: true, required: true },
        { name: 'nextAt', label: '顺延下次跟进到', type: 'date', half: true, hint: '留空表示不再提醒' },
        { name: 'content', label: '沟通内容', type: 'textarea', required: true, placeholder: '客户说了什么、答应了什么、你的下一步动作' }
      ],
      note: '保存后，客户的「下次跟进日期」会自动更新为上面设置的日期。',
      onSubmit: d => {
        if (!d.content) { toast('写点内容再保存', 'err'); return; }
        d.at = d.at ? new Date(d.at).toISOString() : new Date().toISOString();
        S.insert('followups', { customerId: d.customerId, dealId: d.dealId || '', type: d.type, at: d.at, content: d.content, nextAt: '' });
        S.update('customers', d.customerId, { nextFollowAt: d.nextAt || '' });
        closeModal(); toast('跟进已记录', 'ok'); render();
      }
    });
  }

  /* ============================================================
   * 聊天记录整理
   * 谈完客户，把聊天记录整段粘进来，自动揪出：谁答应了什么（忘了会丢单）、
   * 客户在顾虑什么、下一步什么时候做。
   *
   * 全程不自动入库 —— 一条误判的承诺被写进跟进记录，比不记还糟。
   * ============================================================ */
  let dgResult = null;
  let dgCustomerId = '';

  function digestBox(customerId) {
    dgCustomerId = customerId || '';
    dgResult = null;
    const c = customerId ? S.get('customers', customerId) : null;
    const sel = `
      <select id="dg-cust" class="dg-sel">
        <option value="">— 选择客户 —</option>
        ${S.list('customers').map(x => `<option value="${x.id}" ${c && c.id === x.id ? 'selected' : ''}>${E(x.name)}${x.contact ? ' · ' + E(x.contact) : ''}</option>`).join('')}
      </select>`;

    openModal(`
      <div class="modal-head">
        <h3>整理聊天记录</h3>
        <button class="x-btn" data-action="close-modal">×</button>
      </div>
      <div class="modal-body">
        <div class="dg-for">${c ? '归属客户：<b>' + E(c.name) + '</b>' + (c.contact ? ' · ' + E(c.contact) : '') : '归属客户：' + sel}</div>
        <textarea id="dg-input" placeholder="把微信 / QQ 的聊天记录整段粘进来。&#10;我会揪出：谁答应了什么、客户在顾虑什么、下一步什么时候做。"></textarea>
        <div class="dg-tip">支持「王总：内容」和微信导出的「王总 10:23 / 内容换行」两种格式</div>
        <div id="dg-out"></div>
      </div>
      <div class="modal-foot">
        <button class="btn" data-action="close-modal">取消</button>
        <button class="btn btn-primary" data-action="dg-analyze">整理</button>
      </div>`);
  }

  function dgAnalyze() {
    const input = $('#dg-input');
    const text = input ? input.value.trim() : '';
    if (!text) { toast('先粘贴一段聊天记录', 'err'); return; }
    if (!window.Digest) { toast('分析模块未加载', 'err'); return; }

    const selEl = $('#dg-cust');
    const custId = selEl ? selEl.value : dgCustomerId;
    const c = custId ? S.get('customers', custId) : null;

    const r = window.Digest.analyze(text, {
      me: [S.state.settings.owner, '我'].filter(Boolean),
      them: c ? [c.name, c.contact].filter(Boolean) : []
    });
    dgResult = r;
    dgCustomerId = custId;

    const out = $('#dg-out');
    if (out) out.innerHTML = dgRender(r);

    /* 底部按钮换成「存入跟进」—— 分析完才允许落库 */
    const foot = $('#modal .modal-foot');
    if (foot) {
      foot.innerHTML = `
        <button class="btn" data-action="dg-back">重新粘贴</button>
        <div class="spacer"></div>
        <button class="btn" data-action="close-modal">取消</button>
        <button class="btn btn-primary" data-action="dg-save">存入跟进记录</button>`;
    }
  }

  function dgRender(r) {
    const sec = (title, sub, arr, key) => !arr.length ? '' : `
      <div class="dg-sec">
        <div class="dg-h">${E(title)}<span class="dg-n">${arr.length}</span><span class="dg-sub">${E(sub)}</span></div>
        ${arr.map((x, i) => `
          <label class="dg-item">
            <input type="checkbox" checked data-k="${key}" data-i="${i}">
            <span class="dg-t">${E(x.text)}</span>
            ${x.at ? `<em class="dg-at">${E(x.at)}</em>` : '<em class="dg-at none">没定时间</em>'}
          </label>`).join('')}
      </div>`;

    const risks = !r.risks.length ? '' : `
      <div class="dg-sec dg-risk">
        <div class="dg-h">危险信号<span class="dg-n">${r.risks.length}</span></div>
        ${r.risks.map(x => `<div class="dg-warn"><b>!</b> ${E(x.msg)}<span class="dg-src">来自：${E(x.text)}</span></div>`).join('')}
      </div>`;

    const dangling = r.dangling > 0
      ? `<div class="dg-hint warn">有 ${r.dangling} 条承诺没写时间 —— 没日期的承诺基本等于没承诺，建议补上。</div>` : '';

    return `
      <div class="dg-sum">${E(r.summary || '')}</div>
      ${risks}
      ${sec('我要做的', '忘了会丢单', r.mine, 'mine')}
      ${sec('客户要做的', '到时候记得催', r.theirs, 'theirs')}
      ${sec('客户顾虑', '这是单子真正的卡点', r.objections, 'objections')}
      ${sec('下一步', '', r.nextSteps, 'nextSteps')}
      ${dangling}
      <div class="dg-hint">勾选要保留的，再存入跟进记录。</div>`;
  }

  function dgSave() {
    if (!dgResult) { toast('没有可保存的内容', 'err'); return; }
    const selEl = $('#dg-cust');
    const custId = selEl ? selEl.value : dgCustomerId;
    if (!custId) { toast('先选择这条记录属于哪个客户', 'err'); return; }

    /* 只保留勾选的项 */
    const picked = {
      mine: [], theirs: [], asks: [], objections: [], nextSteps: [],
      money: dgResult.money, risks: dgResult.risks, summary: dgResult.summary
    };
    $$('#dg-out input[type="checkbox"]').forEach(cb => {
      if (!cb.checked) return;
      const k = cb.dataset.k, i = Number(cb.dataset.i);
      if (dgResult[k] && dgResult[k][i]) picked[k].push(dgResult[k][i]);
    });

    const any = picked.mine.length + picked.theirs.length + picked.asks.length
      + picked.objections.length + picked.nextSteps.length;
    if (!any) { toast('至少勾选一条', 'err'); return; }

    /* 下一步时间取最早的那条，并顺延客户的下次跟进日 */
    let nextAt = '';
    picked.nextSteps.concat(picked.mine, picked.theirs).forEach(x => {
      if (x.at && (!nextAt || x.at < nextAt)) nextAt = x.at;
    });

    S.insert('followups', {
      customerId: custId, dealId: '', type: '微信',
      at: new Date().toISOString(),
      content: window.Digest.toNote(picked),
      nextAt: nextAt
    });
    if (nextAt) S.update('customers', custId, { nextFollowAt: nextAt });

    closeModal();
    toast(nextAt ? `已存入，下次跟进日设为 ${nextAt}` : '已存入跟进记录', 'ok');
    render();
  }


  /* ============================================================
   * 战后沉淀：赢了或黄了的单子，趁记得住把经验存成话术
   *
   * 时机是这个功能的全部。刚签完单那两分钟，是销售最愿意说、
   * 也说得最清楚的时候 —— 隔一周再问，只剩「客户还行吧」。
   * 所以选在阶段变成赢/输的当下弹出来。
   *
   * 但有两个前提，缺一个就不弹：
   *   1. 真能从跟进记录里挖出东西（没料还弹，是纯骚扰）
   *   2. 这一单没沉淀过（同一个人同一个单子反复弹，会让人关掉再也不看）
   * ============================================================ */
  let dbDeal = null;

  function maybeDebrief(deal) {
    if (!deal || !window.Playbook || !window.Playbook.extractFromDeal) return false;
    if (deal.stage !== 'won' && deal.stage !== 'lost') return false;
    const done = S.list('scripts').some(x => x.fromDealId === deal.id);
    if (done) return false;
    const cust = S.get('customers', deal.customerId);
    const draft = window.Playbook.extractFromDeal(deal, cust, S.list('followups'));
    if (!draft) return false;
    dbDeal = deal;
    debriefBox(deal, draft);
    return true;
  }

  function debriefBox(deal, draft) {
    const won = deal.stage === 'won';
    const cands = String(draft.content || '').split('\n').map(x => x.trim()).filter(Boolean);
    const cust = S.get('customers', deal.customerId);
    const amt = S.moneyFull(deal.amount);

    openModal(`
      <div class="modal-head">
        <h3>${won ? '🎉 这单拿下了，存两句经验' : '这单黄了，记下卡在哪'}</h3>
        <button class="x-btn" data-action="close-modal">×</button>
      </div>
      <div class="modal-body">
        <div class="db-for">
          ${E(cust ? cust.name : '')} · ${E(deal.title)} · ${E(amt)}
        </div>
        <div class="db-tip">
          ${won ? '这几句是从你之前的跟进记录里挑出来的，客户当时是这么说的。勾上你觉得有用的，下次遇到同类客户就能搜到。'
                : '这单没成，但客户说的这些话是真的。记下来，下次遇到同样的坑就绕得过去。'}
        </div>
        <div id="db-list" class="db-list">
          ${cands.length ? cands.map((t, i) => `
            <label class="db-item">
              <input type="checkbox" data-k="cand" data-i="${i}" checked>
              <span>${E(t)}</span>
            </label>`).join('') : '<div class="empty" style="padding:12px 0">这段时间的跟进记录里没挑出可用的句子</div>'}
        </div>
        <div class="field" style="margin-top:12px">
          <label>再补一句（可选）</label>
          <textarea id="db-extra" rows="2" placeholder="${won ? '客户最后为什么选了我们？' : '下次再遇到，我会怎么做？'}"></textarea>
        </div>
        <div class="field">
          <label>关键词</label>
          <input id="db-tags" value="${E((draft.tags || []).join('，'))}">
          <div class="hint">写客户会说的各种说法，决定以后能不能搜到它</div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn" data-action="close-modal">这次先不</button>
        <button class="btn btn-primary" data-action="db-save">存进话术库</button>
      </div>`);
  }

  function dbSave() {
    if (!dbDeal) { toast('没有待保存的复盘', 'err'); return; }
    const deal = dbDeal;
    const cust = S.get('customers', deal.customerId);
    const won = deal.stage === 'won';

    const picked = [];
    $$('#db-list input[type="checkbox"]').forEach(cb => {
      if (cb.checked) {
        const span = cb.parentNode.querySelector('span');
        if (span) picked.push(span.textContent);
      }
    });
    const extraEl = $('#db-extra');
    const extra = extraEl ? extraEl.value.trim() : '';
    if (extra) picked.push(extra);
    if (!picked.length) { toast('至少留一句，不然存进去也是空的', 'err'); return; }

    const tagsEl = $('#db-tags');
    const tags = tagsEl ? tagsEl.value.trim() : '';

    S.insert('scripts', {
      category: won ? '赢单复盘' : '输单复盘',
      title: (cust ? cust.name : '某客户') + (won ? ' · 为什么赢' : ' · 为什么输'),
      content: picked.join('\n'),
      tags: tags,
      source: won ? 'won' : 'lost',
      builtin: false,
      fromDealId: deal.id,
      fromCustomer: cust ? cust.name : ''
    });

    dbDeal = null;
    closeModal();
    toast(picked.length + ' 句经验已存入话术库', 'ok');
    render();
  }

  function scriptForm(s, prefill) {
    const isNew = !s;
    s = s || { category: '我的实战', title: prefill || '', content: '', tags: '' };
    const cats = Array.from(new Set(S.list('scripts').map(x => x.category)));
    const tagStr = Array.isArray(s.tags) ? s.tags.join('，') : (s.tags || '');
    openForm({
      title: isNew ? '新增话术' : '编辑话术',
      values: Object.assign({}, s, { tags: tagStr }),
      fields: [
        {
          name: 'category', label: '分类', half: true, placeholder: '可填新分类',
          hint: cats.length ? '已有分类：' + cats.join(' / ') : ''
        },
        { name: 'title', label: '标题 / 触发场景', half: true, required: true, placeholder: '例：客户说「太贵了」' },
        {
          name: 'tags', label: '关键词（逗号分隔）',
          hint: '写客户会说的各种说法，比如：太贵，嫌贵，价格高，超预算。这决定了以后能不能搜到它 —— 写得越口语越好找'
        },
        { name: 'content', label: '话术内容', type: 'textarea', required: true }
      ],
      onSubmit: d => {
        if (!d.title || !d.content) { toast('标题和内容都要填', 'err'); return; }
        d.tags = String(d.tags || '').split(/[,，、\s]+/).map(x => x.trim()).filter(Boolean);
        if (isNew) {
          d.source = 'user';
          S.insert('scripts', d);
        } else S.update('scripts', s.id, d);
        closeModal(); toast('已保存', 'ok'); render();
      }
    });
  }

  /* ============================================================
   * 渲染
   * ============================================================ */
  /* 「团队」页签只对管理员露面。普通成员点了也是一片空白，徒增困惑。
   * 单独抽成一个函数，是因为登录态是**异步**恢复的：
   * 页面打开时先渲染一次，那时还没拿到角色；等 profile 回来，
   * 如果没人通知界面，这个页签就永远不会出现。
   * 这里刻意只改页签这一个元素，不整页重绘——
   * 用户可能正填着半个表单，一次 render 就把输入清空了。 */
  function refreshTeamTab() {
    const t = $('#tab-team');
    if (!t) return;
    const show = !!(window.Auth && Auth.isOn() && Auth.isAdmin() && Auth.teamId());
    if (t.hidden === !show) return;
    t.hidden = !show;
    /* 停在团队页时权限被撤了（比如被降成使用员），要跳走，
     * 否则用户盯着一个自己没权限的页面发呆 */
    if (view === 'team' && !show) switchView('dash');
  }

  function render() {
    $$('.view').forEach(v => { v.hidden = true; });
    const sec = $('#view-' + view);
    sec.hidden = false;
    if (view === 'dash') sec.innerHTML = V.dash();
    else if (view === 'customers') sec.innerHTML = V.customers(filters.customers);
    else if (view === 'deals') sec.innerHTML = V.deals();
    else if (view === 'followups') sec.innerHTML = V.followups(filters.followups);
    else if (view === 'scripts') sec.innerHTML = V.scripts(filters.scripts);
    else if (view === 'report') sec.innerHTML = V.report(filters.report);
    else if (view === 'ai') sec.innerHTML = V.ai(filters.ai);
    else if (view === 'settings') sec.innerHTML = V.settings();
    else if (view === 'team') {
      sec.innerHTML = V.team(boardData);
      if (!boardData) loadBoard();      // 第一次进来才拉，拉完只刷这一屏
    }

    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));

    refreshTeamTab();

    /* 手机上页签排不下，靠横向滚动。不把当前页签滚进视野的话，
     * 用户从别的页切回来，看到的是前几个页签，会以为这个功能是丢了的。
     * block:'nearest' 是必须的——页签栏是 sticky 的，
     * 默认值会连带把整页纵向滚一下，看起来像页面自己在跳。 */
    const curTab = $$('.tab').find(t => t.dataset.view === view);
    if (curTab && curTab.scrollIntoView) {
      try { curTab.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* 老浏览器不认对象参数 */ }
    }
    refreshTop();
    updateBadge();
    if (view === 'scripts') bindScriptSearch();
    if (window.Sync) renderSyncStatus();

    /* 成员列表要发请求，不能每次 render 都拉一遍。
     * 只在「刚进入设置页」时拉一次，离开后再进来才重新拉。 */
    if (view === 'settings') {
      if (lastTeamView !== 'settings') { lastTeamView = 'settings'; loadTeam(); }
    } else {
      lastTeamView = view;
    }
  }
  let lastTeamView = '';

  /* 话术搜索：防抖 + 只重绘结果区。
   * 整页重绘会让输入框失焦 —— 打一个字光标就跳走，这功能等于没法用。 */
  let pbTimer = null;
  let pbFocus = false;
  function runScriptSearch(value) {
    filters.scripts.q = value || '';
    const box = $('#pb-results');
    if (box) box.innerHTML = V.scriptResults(filters.scripts);
  }
  function bindScriptSearch() {
    const input = $('#pb-q');
    if (!input) return;
    if (pbFocus) {
      pbFocus = false;
      input.focus();
      try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) { /* 部分浏览器不支持 */ }
    }
    input.addEventListener('input', () => {
      clearTimeout(pbTimer);
      pbTimer = setTimeout(() => runScriptSearch(input.value), 180);
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); clearTimeout(pbTimer); runScriptSearch(input.value); }
    });
  }

  function refreshTop() {
    const st = S.stats();
    $('#tm-revenue').textContent = S.moneyFull(st.revenue);
    $('#tm-rate').textContent = Math.round(st.rate * 100) + '%';
    $('#tm-todo-value').textContent = st.pending.length;
    $('#owner-line').textContent = (S.state.settings.owner || '我') + ' 的个人销售作战台';

    const tabFollow = $$('.tab').find(t => t.dataset.view === 'followups');
    if (tabFollow) {
      const old = tabFollow.querySelector('.dot');
      if (old) old.remove();
      if (st.pending.length) {
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.textContent = st.pending.length;
        tabFollow.appendChild(dot);
      }
    }
  }

  function switchView(v) {
    view = v;
    /* 每次进团队看板都重新拉一次：这本来就是个看实时进度的页面，
     * 盯着一份几分钟前的旧数字没意义。 */
    if (v === 'team') boardData = null;
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ============================================================
   * 云同步状态
   * ============================================================ */
  const SYNC_TEXT = { off: '未同步', idle: '已同步', syncing: '同步中', error: '同步异常' };

  function renderSyncStatus() {
    const st = Sync.getStatus();
    const pill = $('#sync-pill');
    if (pill) {
      pill.className = 'sync-pill' +
        (st.status === 'idle' ? ' is-on' : st.status === 'syncing' ? ' is-syncing' : st.status === 'error' ? ' is-error' : '');
      const t = $('#sync-pill-text');
      if (t) t.textContent = st.mode === 'off' ? '未启用同步' : (SYNC_TEXT[st.status] || st.status);
      pill.title = st.mode === 'off'
        ? '点击前往设置开启云同步'
        : (st.message ? st.message + ' · 点击立即同步' : '点击立即同步');
    }
    // 设置页内的徽标与说明
    const badge = $('#sync-badge');
    if (badge) {
      const map = {
        off: ['#94a3b8', '未启用'],
        idle: ['#16a34a', '已连接'],
        syncing: ['#2563eb', '同步中'],
        error: ['#dc2626', '连接异常']
      };
      const m = map[st.status] || map.off;
      badge.style.background = m[0];
      badge.textContent = st.mode === 'off' ? '未启用' : m[1];
    }
    const hint = $('#sync-status');
    if (hint) {
      if (st.mode === 'off') hint.innerHTML = '当前未启用同步，数据仅保存在本机。想让手机和电脑自动一致，选一种方式保存即可。';
      else if (st.status === 'error') hint.innerHTML = `<span class="down">${E(st.message || '同步失败')}</span> —— 本地数据完全不受影响，联网后会自动重试。`;
      else hint.innerHTML = `${E(st.message || '待同步')}　·　本地改动 4 秒后自动上传，每 60 秒自动检查一次云端更新。`;
    }
    // 字段显隐随模式切换
    const hf = $('#sync-http-fields'), sf = $('#sync-sb-fields'), cf = $('#sync-cloud-fields');
    const sel = $('#sync-mode');
    if (hf && sf && sel) {
      hf.hidden = sel.value !== 'http';
      sf.hidden = sel.value !== 'supabase';
      if (cf) cf.hidden = sel.value !== 'cloud';
    }
  }

  /* ============================================================
   * 动作分发
   * ============================================================ */
  const actions = {
    'close-modal': closeModal,
    'confirm-ok': () => { const cb = formSubmit; closeModal(); if (cb) cb(); },

    'goto-customers': () => switchView('customers'),
    'goto-followups': () => switchView('followups'),
    'goto-deals': () => switchView('deals'),
    'goto-settings': () => switchView('settings'),

    /* ---- 一句话录入：解析 → 确认 → 写入 ---- */
    'ql-parse': () => qlParse(),

    /* ---- 商机健康度：从「提示」到「行动」必须一步到位 ---- */
    'health-act': el => {
      const d = S.get('deals', el.dataset.id);
      if (!d || !window.Health) return;
      const act = Health.of(d).nextAction;
      if (!act) return;
      if (act.actionType === 'follow') {
        closeModal(); followupForm(d.customerId);
      } else if (act.actionType === 'stage') {
        const next = act.nextStage;
        if (!next) return;
        /* 终态（赢单/输单）会直接改写业绩、提成、业绩曲线，
         * 一键点错代价太大 —— 这里必须二次确认。中间阶段直接推进，不用烦人。 */
        if (next === 'won' || next === 'lost') {
          confirmBox(
            next === 'won' ? '确认签下来了？' : '确认这单黄了？',
            `「${E(d.title)}」${S.moneyFull(d.amount)}${next === 'won'
              ? ' 将立即计入业绩与提成统计' : ' 将标记为输单'}。这一步会改动你的业绩数字，所以再确认一次。`,
            () => {
              S.setStage(d.id, next);
              Health.invalidate();
              render();
              if (next === 'won') toast(`🎉 ${S.customerName(d.customerId)} 赢单 ${S.moneyFull(d.amount)}`, 'ok');
              else toast('已标记输单，记得补上原因', 'err');
              maybeDebrief(S.get('deals', d.id));
            },
            next === 'won' ? '签下来了' : '确认输单');
          return;
        }
        S.setStage(d.id, next);
        Health.invalidate();
        render();
        toast(`已推进到「${S.stageOf(next).name}」，节奏回来了`, 'ok');
      } else {
        closeModal(); dealForm(d);
      }
    },
    'health-snooze': el => {
      if (!window.Health) return;
      const n = Health.settings().snoozeDays || 7;
      Health.snooze(el.dataset.id, n);
      Health.invalidate();
      render();
      toast(`好，${n} 天内不再提这个商机`, 'ok');
    },
    'health-tune': () => {
      if (!window.Health) return;
      const cfg = Health.settings();
      const bl = Health.baseline();
      openForm({
        title: '健康度提醒的松紧',
        submitText: '保存',
        values: {
          sensitivity: String(cfg.sensitivity || 1),
          snoozeDays: String(cfg.snoozeDays || 7),
          enabled: cfg.enabled ? '1' : '0'
        },
        fields: [
          {
            name: 'sensitivity', label: '提醒松紧', type: 'select', options: [
              { value: '0.7', label: '严格 — 稍微拖延就提醒' },
              { value: '1', label: '标准 — 按你自己的历史节奏' },
              { value: '1.5', label: '宽松 — 只提醒明显不对劲的' }
            ],
            hint: '周期长的生意（政企、大项目）建议选宽松，避免天天飘红'
          },
          { name: 'snoozeDays', label: '点「知道了」后几天内不再提', type: 'number', min: 1, half: true },
          {
            name: 'enabled', label: '开关', type: 'select', half: true,
            options: [{ value: '1', label: '开启' }, { value: '0', label: '关闭' }]
          }
        ],
        note: bl.learned > 0
          ? `当前已根据你的成交记录学到 ${bl.learned} 个阶段的基准天数，会随新数据自动更新。`
          : '目前还没有足够的成交样本，暂按客户分级的通用节奏判断。积累 3 单以上带阶段变化的成交后，会自动换成你自己的节奏。',
        onSubmit: v => {
          Health.setSettings({
            sensitivity: Number(v.sensitivity) || 1,
            snoozeDays: Math.max(1, Number(v.snoozeDays) || 7),
            enabled: v.enabled === '1'
          });
          Health.invalidate();
          closeModal();
          render();
          toast('已保存，判断标准已更新', 'ok');
        }
      });
    },

    'new-customer': () => customerForm(null),
    'edit-customer': el => { closeModal(); customerForm(S.get('customers', el.dataset.id)); },
    'del-customer': el => {
      const c = S.get('customers', el.dataset.id);
      closeModal();
      confirmBox('删除客户', `确定删除「${E(c.name)}」？其名下商机与跟进记录会一并删除，且无法恢复。`,
        () => { S.removeCustomer(c.id); toast('已删除', 'ok'); render(); }, '删除');
    },
    'open-customer': el => { closeModal(); openCustomerDetail(el.dataset.id); },

    'new-deal': el => dealForm(null, el.dataset.id),
    'edit-deal': el => { closeModal(); dealForm(S.get('deals', el.dataset.id)); },
    'del-deal': el => {
      const d = S.get('deals', el.dataset.id);
      confirmBox('删除商机', `确定删除「${E(d.title)}」？`, () => { S.remove('deals', d.id); toast('已删除', 'ok'); render(); }, '删除');
    },

    'quick-followup': () => followupForm(null),
    'log-followup': el => { closeModal(); followupForm(el.dataset.id); },
    'del-followup': el => { S.remove('followups', el.dataset.id); toast('已删除', 'ok'); render(); },

    'digest': el => digestBox(el.dataset.id),
    'dg-analyze': () => dgAnalyze(),
    'dg-save': () => dgSave(),
    'dg-back': () => { const c = dgCustomerId; digestBox(c); const t = $('#dg-input'); if (t) t.focus(); },

    'new-script': el => scriptForm(null, el && el.dataset.prefill),
    'edit-script': el => scriptForm(S.get('scripts', el.dataset.id)),
    'del-script': el => { S.remove('scripts', el.dataset.id); toast('已删除', 'ok'); render(); },
    'filter-script-cat': el => { filters.scripts.cat = el.dataset.cat || ''; render(); },
    'pb-quick': el => {
      filters.scripts.q = el.dataset.q || '';
      filters.scripts.cat = '';
      pbFocus = false;
      render();
      const box = $('#pb-results');
      if (box) box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    },
    'pb-clear': () => { filters.scripts.q = ''; filters.scripts.cat = ''; pbFocus = true; render(); },
    'copy-script': el => {
      const s = S.get('scripts', el.dataset.id);
      /* 防御：话术可能刚被删掉，而详情页还开着。
       * 不判空的话 s.content 直接抛异常，用户点了「复制」什么都没发生，
       * 只会觉得这软件又坏了。 */
      if (!s) { toast('这条话术已经不在了', 'err'); return; }
      copyText(s.content).then(ok => toast(ok ? '话术已复制，去粘贴吧' : '复制失败，请手动选中', ok ? 'ok' : 'err'));
    },
    /* 展开/收起某条推荐话术的正文。
     * 默认只显示标题和理由 —— 三条都把全文铺开会挤掉下面的商机和时间线，
     * 而销售点开客户详情最想看的是「这人是谁、上次聊了啥」。
     * 想看全文再点标题，两全。 */
    'coach-toggle': el => {
      const box = document.getElementById('coach-body-' + el.dataset.idx);
      if (!box) return;
      box.hidden = !box.hidden;
      el.classList.toggle('is-open', !box.hidden);
    },
    'copy-wechat': el => {
      const c = S.get('customers', el.dataset.id);
      copyText(c.wechat).then(ok => toast(ok ? '微信号已复制，去微信粘贴搜索' : '复制失败', ok ? 'ok' : 'err'));
    },

    'clear-filter': () => { filters.customers = { q: '', level: '', status: '', sort: 'next' }; render(); },
    'export-csv': () => download(S.customersToCSV(), `客户清单_${S.todayStr()}.csv`, 'text/csv;charset=utf-8'),
    'export-json': () => download(S.exportJSON(), `销冠助手备份_${S.todayStr()}.json`, 'application/json'),
    'import-json': () => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = '.json,application/json';
      inp.onchange = () => {
        const f = inp.files[0]; if (!f) return;
        const r = new FileReader();
        r.onload = () => {
          try { S.importJSON(r.result); toast('导入成功', 'ok'); render(); }
          catch (err) { toast('导入失败：' + err.message, 'err'); }
        };
        r.readAsText(f);
      };
      inp.click();
    },
    'seed-demo': () => confirmBox('载入示例数据', '这会<b>覆盖</b>当前全部客户、商机与跟进记录（话术库保留），确定继续？',
      () => { S.seed(true); toast('示例数据已载入', 'ok'); render(); }, '覆盖并载入'),
    'clear-data': () => confirmBox('清空业务数据', '将删除全部客户、商机、跟进记录（话术库保留）。建议先导出备份。',
      () => { S.reset(true); toast('已清空', 'ok'); render(); }, '确认清空'),

    'save-settings': () => {
      const s = S.state.settings;
      s.owner = readVal('set-owner') || '我';
      s.monthlyTarget = Number(readVal('set-target')) || 0;
      s.commissionRate = Number(readVal('set-rate')) || 0;
      S.save(); toast('设置已保存', 'ok'); render();
    },

    'save-ai': async () => {
      const s = S.state.settings;
      const prev = s.ai || {};
      s.ai = {
        provider: (prev.provider === undefined ? 'deepseek' : prev.provider),
        base: readVal('ai-base') || 'https://api.deepseek.com/v1',
        key: $('#ai-key').value || '',
        model: readVal('ai-model') || 'deepseek-chat'
      };
      s.ai.enabled = !!s.ai.key;
      s.updatedAt = Date.now();
      S.save();
      if (!s.ai.key) { toast('已清空 API 配置', 'ok'); render(); return; }
      AI.pushHistory(s.ai);
      toast('正在测试连接…', 'ok');
      try { await AI.testConnection(); toast('连接成功，AI 助手已可用', 'ok'); }
      catch (e) { toast('连接失败：' + e.message, 'err'); }
      render();
    },

    /* ---------- AI 服务商 ---------- */
    /* 换了服务商就预填那家的地址和默认模型名。
     * 但 Key 不预填——不同家的 Key 不通用，留着旧的只会让人以为配好了。 */
    'ai-provider-change': () => {
      const sel = $('#ai-provider');
      if (!sel) return;
      const p = (AI.PROVIDERS || {})[sel.value];
      if (!p) return;
      const s = S.state.settings;
      s.ai = Object.assign({}, s.ai, { provider: sel.value });
      if (p.base) {
        const base = $('#ai-base'); if (base) base.value = p.base;
      }
      if (p.model) {
        const m = $('#ai-model'); if (m) m.value = p.model;
      }
      const hint = $('#ai-hint');
      if (hint) {
        hint.innerHTML = p.note
          ? `已切到 <b>${E(p.name)}</b>：${E(p.note)}。填 Key 就能用。`
          : `已切到 <b>${E(p.name)}</b>，填 Key 就能用。`;
      }
      if (!p.base) {
        const base = $('#ai-base');
        if (base) { base.value = ''; base.placeholder = 'https://your-api.com/v1'; base.focus(); }
      }
    },
    'ai-use-history': (el) => {
      const i = Number((el && el.dataset && el.dataset.i) || -1);
      const h = (S.state.settings.aiHistory || [])[i];
      if (!h) return;
      const s = S.state.settings;
      /* 只换地址和模型名，Key 沿用当前在用的那个——
       * 历史里不存明文 Key（存了也不安全），所以没法自动填回去。 */
      s.ai = Object.assign({}, s.ai, { provider: h.provider, base: h.base, model: h.model });
      S.save();
      render();
      toast('已切回这套配置，Key 用的是当前这个（' + (h.keyHint || '') + '…）', 'ok');
    },
    'ai-list-models': async () => {
      toast('正在拉取模型列表…', 'ok');
      try {
        const list = await AI.listModels();
        openModal('选择模型', `
          <div class="field"><label>这家有 ${list.length} 个模型，点一个直接用</label></div>
          <div style="max-height:320px;overflow:auto;display:flex;flex-direction:column;gap:4px">
            ${list.map(m => `<button class="btn btn-sm" data-action="ai-pick-model" data-m="${E(m)}"
              style="text-align:left;justify-content:flex-start">${E(m)}</button>`).join('')}
          </div>`,
          () => {});
      } catch (e) { toast('拉取失败：' + e.message + '（也可以手填模型名）', 'err'); }
    },
    'ai-pick-model': (el) => {
      const m = (el && el.dataset && el.dataset.m) || '';
      if (!m) return;
      const s = S.state.settings;
      s.ai = Object.assign({}, s.ai, { model: m });
      S.save();
      closeModal();
      render();
      toast('已选择模型 ' + m, 'ok');
    },
    'ai-test': async () => {
      if (!$('#ai-key').value) { toast('先填 Key 再测', 'err'); return; }
      const s = S.state.settings;
      s.ai = Object.assign({}, s.ai, {
        provider: $('#ai-provider') ? $('#ai-provider').value : (s.ai || {}).provider,
        base: readVal('ai-base'), key: $('#ai-key').value, model: readVal('ai-model')
      });
      S.save();
      toast('正在测试…', 'ok');
      try { await AI.testConnection(); toast('连接成功', 'ok'); }
      catch (e) { toast('连接失败：' + e.message, 'err'); }
    },

    /* ---------- 跟进提醒 ---------- */
    'notify-request': async () => {
      const r = await Notify.request();
      if (r === 'granted') { toast('已开启系统通知，到点会提醒你', 'ok'); Notify.check(true); }
      else if (r === 'denied') toast('浏览器已阻止通知。点地址栏左侧的图标 → 网站设置 → 允许通知', 'err');
      else toast('这个环境不支持系统通知，页面内的角标提醒仍然有效', 'err');
      render();
    },
    'save-notify': () => {
      const on = readVal('notify-enabled') === '1';
      Notify.saveCfg({ enabled: on });
      if (on) {
        Notify.request().then(r => {
          if (r === 'granted') Notify.check(true);
          render();
        });
        toast('已开启。若要系统弹窗，浏览器会问你一次权限', 'ok');
      } else {
        toast('已关闭提醒', 'ok');
        render();
      }
    },

    /* ---------- 云账号与团队 ---------- */
    'save-cloud': async () => {
      const url = readVal('cloud-url'), key = $('#cloud-key') ? $('#cloud-key').value.trim() : '';
      if (!url || !key) { toast('地址和 anon key 都要填', 'err'); return; }
      Auth.saveCfg({ url: url, key: key });
      toast('正在连接…', 'ok');
      try {
        await Auth.testConn();
        toast('连接正常，可以注册或登录了', 'ok');
      } catch (e) {
        toast('连接失败：' + e.message, 'err');
      }
      render();
    },
    'cloud-signup': async () => {
      const mail = readVal('cloud-email'), pwd = $('#cloud-pwd') ? $('#cloud-pwd').value : '';
      const name = readVal('cloud-name');
      if (!mail || !pwd) { toast('邮箱和密码都要填', 'err'); return; }
      if (pwd.length < 6) { toast('密码至少 6 位', 'err'); return; }
      toast('正在注册…', 'ok');
      try {
        const r = await Auth.signUp(mail, pwd, name);
        if (r.needConfirm) {
          toast('注册成功，请先去邮箱点确认链接再登录', 'ok');
        } else {
          toast('注册成功，已自动登录', 'ok');
          afterLogin();
        }
      } catch (e) { toast('注册失败：' + e.message, 'err'); }
      render();
    },
    'cloud-login': async () => {
      const mail = readVal('cloud-email'), pwd = $('#cloud-pwd') ? $('#cloud-pwd').value : '';
      if (!mail || !pwd) { toast('邮箱和密码都要填', 'err'); return; }
      toast('正在登录…', 'ok');
      try {
        await Auth.signIn(mail, pwd);
        toast('登录成功', 'ok');
        afterLogin();
      } catch (e) { toast('登录失败：' + e.message, 'err'); }
      render();
    },
    'cloud-logout': async () => {
      await Auth.signOut();
      toast('已退出，本地数据原封不动', 'ok');
      render();
    },
    'cloud-reset': () => {
      Auth.saveCfg({ url: '', key: '' });
      toast('已清空，可以换一个 Supabase 项目', 'ok');
      render();
    },
    'cloud-refresh': async () => {
      await Auth.loadProfile(true);
      render();
      toast('已刷新', 'ok');
    },
    'team-set-role': async (el) => {
      const uid = (el && el.dataset && el.dataset.uid) || '';
      const role = el ? el.value : '';
      if (!uid || !role) return;
      try {
        await Auth.setRole(uid, role);
        toast('角色已更新', 'ok');
      } catch (e) { toast('改不了：' + e.message, 'err'); }
      render();
      loadTeam();
    },
    'team-remove': async (el) => {
      const uid = (el && el.dataset && el.dataset.uid) || '';
      if (!uid) return;
      const name = (el.dataset.name || '这位成员');
      openModal('把 ' + name + ' 移出团队',
        `<p class="small">移出后他就<b>看不到团队共享话术</b>了，但他的客户数据本来就是他自己的，
         不会跟着消失。</p><p class="small muted">确定吗？</p>`,
        async () => {
          try { await Auth.removeFromTeam(uid); toast('已移出团队', 'ok'); }
          catch (e) { toast('操作失败：' + e.message, 'err'); }
          render(); loadTeam();
        });
    },
    'join-team': async () => {
      const input = $('#invite-input');
      const code = input ? input.value.trim() : '';
      if (!code) { toast('先填邀请码', 'err'); return; }
      try {
        await Auth.joinTeam(code);
        boardData = null;
        toast('已加入团队', 'ok');
        /* 入了队，数据要重新推一次，好让管理员那边看得到 */
        if ((Sync.cfg().mode || 'off') === 'cloud') {
          Sync.saveCfg({ pushCursor: 0 });
          Promise.resolve(Sync.sync(true)).catch(() => null);
        }
      } catch (e) { toast('加入失败：' + e.message, 'err'); }
      render();
    },
    'leave-team': async () => {
      openModal('退出团队',
        `<p class="small">退出后你会<b>看不到团队共享话术</b>，管理员也看不到你的进度。</p>
         <p class="small muted">你自己的客户、商机、跟进<b>一条都不会少</b>，它们本来就只属于你。</p>`,
        async () => {
          try { await Auth.leaveTeam(); boardData = null; toast('已退出团队', 'ok'); }
          catch (e) { toast('退出失败：' + e.message, 'err'); }
          render();
        });
    },
    'reset-invite': async () => {
      try {
        const c = await Auth.resetInviteCode();
        toast('新邀请码：' + c, 'ok');
        render();
        loadTeam();
      } catch (e) { toast('重置失败：' + e.message, 'err'); }
    },
    'team-rename': async () => {
      const input = $('#team-name-input');
      if (!input || !input.value.trim()) return;
      try { await Auth.renameTeam(input.value.trim()); toast('团队名已更新', 'ok'); }
      catch (e) { toast('改名失败：' + e.message, 'err'); }
      render();
    },

    /* ---------- 云同步 ---------- */
    'sync-pill': async () => {
      if ((Sync.cfg().mode || 'off') === 'off') {
        switchView('settings');
        toast('在「云同步」卡片里选一种方式即可开启，数据仍优先存本机', 'ok');
        return;
      }
      toast('正在同步…', 'ok');
      const r = await Sync.sync(true);
      toast(r.ok ? '同步完成' : '同步失败：' + (r.msg || '未知错误'), r.ok ? 'ok' : 'err');
      if (r.ok) render(); else renderSyncStatus();
    },
    'save-sync': async () => {
      const mode = $('#sync-mode') ? $('#sync-mode').value : 'off';
      const patch = { mode: mode };
      if (mode === 'http') {
        patch.endpoint = readVal('sync-endpoint');
        patch.token = $('#sync-token') ? $('#sync-token').value.trim() : '';
        if (!patch.endpoint) { toast('请填写同步地址', 'err'); return; }
      } else if (mode === 'supabase') {
        patch.url = readVal('sb-url');
        patch.key = $('#sb-key') ? $('#sb-key').value.trim() : '';
        patch.table = readVal('sb-table') || 'sales_sync';
        patch.space = readVal('sb-space') || 'default';
        if (!patch.url || !patch.key) { toast('请填写 Project URL 和 anon key', 'err'); return; }
      }
      Sync.saveCfg(patch);
      if (mode === 'off') {
        Sync.stop();
        toast('已关闭云同步，数据仅存本机', 'ok');
        renderSyncStatus();
        return;
      }
      toast('正在连接…', 'ok');
      const r = await Sync.sync(true);
      if (r.ok) { toast('连接成功，多设备填相同配置即可自动同步', 'ok'); Sync.start(); }
      else toast('连接失败：' + (r.msg || '未知错误') + '（本地数据不受影响）', 'err');
      renderSyncStatus();
    },
    'sync-now': async () => {
      if ((Sync.cfg().mode || 'off') === 'off') { toast('请先在上方选择同步方式并保存', 'err'); return; }
      toast('正在同步…', 'ok');
      const r = await Sync.sync(true);
      toast(r.ok ? '同步完成' : '同步失败：' + (r.msg || '未知错误') + '（本地数据不受影响）', r.ok ? 'ok' : 'err');
      renderSyncStatus();
      if (r.ok) render();
    },
    'sync-stop': () => {
      Sync.stop();
      toast('已停止自动同步（配置保留）', 'ok');
      renderSyncStatus();
    },
    'sync-purge': () => {
      const n = S.purge();
      toast(n ? `已清理 ${n} 条墓碑记录` : '没有可清理的墓碑记录', 'ok');
      render();
    },
    'fill-public-endpoint': () => {
      const url = V.PUBLIC_ENDPOINT;
      if (!url) { toast('未配置公共演示后端', 'err'); return; }
      const el = $('#sync-endpoint');
      if (el) el.value = url;
      const tk = $('#sync-token');
      if (tk && !tk.value) {
        // 给一个够长的随机默认令牌，用户可以直接用，也可以改成自己好记的
        tk.value = 'sc-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
        tk.type = 'text';
      }
      toast('已填入公共演示后端。令牌请改成你自己记得住的、够长的一串', 'ok');
    },

    'db-save': () => dbSave(),

    /* ---------- 周报 ---------- */
    'rp-range': el => {
      filters.report.range = el.dataset.range;
      render();
    },
    'copy-report': () => {
      /* 取文本框里的，不是重新生成一份：
       * 用户可能刚手动改过几个字，覆盖掉等于白改 */
      const ta = $('#rp-text');
      const v = ta ? ta.value : window.Report.toText(window.Report.build(filters.report.range));
      if (!v.trim()) { toast('这段时间没有可汇报的内容', 'err'); return; }
      copyText(v).then(ok => toast(ok ? '周报已复制，去微信/邮件粘贴即可' : '复制失败，请手动选中文本框内容', ok ? 'ok' : 'err'));
    },
    'ai-polish': async () => {
      const ta = $('#rp-text');
      if (!ta || !ta.value.trim()) { toast('还没有内容可润色', 'err'); return; }
      if (!AI) { toast('AI 模块未加载', 'err'); return; }
      if (!S.state.settings.ai || !S.state.settings.ai.key) {
        toast('请先在「设置 → AI 助手」里配好 API Key', 'err'); return;
      }
      const btn = document.querySelector('[data-action="ai-polish"]');
      const oldText = btn ? btn.textContent : '';
      if (btn) { btn.disabled = true; btn.textContent = '润色中…'; }
      try {
        /* 给 AI 的是本地已经算好的事实，不是让它从原始数据里自由发挥。
         * 自由发挥的周报会编数字——领导追问一句就穿帮了。
         * 所以提示词里明确要求：数字和事实一个都不许改。 */
        const prompt = '你是销售周报润色助手。下面是一份已经核对过事实的周报初稿，'
          + '请帮我把语言改得更专业、更有条理，适合直接发给直属领导。\n\n'
          + '严格要求：\n'
          + '1. 所有数字、金额、客户名、日期必须原样保留，一个都不能改，也不能新增；\n'
          + '2. 不要编造任何初稿里没有的事情；\n'
          + '3. 保持简洁，不超过 500 字；\n'
          + '4. 直接输出润色后的周报，不要解释你改了什么。\n\n'
          + '【初稿】\n' + ta.value;
        const out = await AI.ask(prompt);
        ta.value = out;
        toast('已润色，发出去前请再核对一遍数字', 'ok');
      } catch (e) {
        toast('润色失败：' + e.message, 'err');
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = oldText; }
      }
    },

    'ai-generate': async () => {
      const scenario = $('#ai-scenario').value;
      const customerId = $('#ai-customer').value;
      const extra = $('#ai-extra').value.trim();
      filters.ai = { scenario, customerId };
      const out = $('#ai-output');
      out.value = '正在生成，请稍候…';
      try {
        const prompt = AI.buildPrompt(scenario, customerId, extra);
        window._lastPrompt = prompt;
        const text = await AI.ask(prompt);
        out.value = text;
      } catch (e) {
        out.value = '';
        toast('生成失败：' + e.message + '（可点击「复制提示词」手动到 AI 工具生成）', 'err');
      }
    },
    'ai-copy-prompt': () => {
      const scenario = $('#ai-scenario').value;
      const customerId = $('#ai-customer').value;
      const extra = $('#ai-extra').value.trim();
      const prompt = AI.buildPrompt(scenario, customerId, extra);
      copyText(prompt).then(ok => toast(ok ? '提示词已复制，去你的 AI 工具粘贴即可' : '复制失败', ok ? 'ok' : 'err'));
    },
    'ai-copy-result': () => {
      const v = $('#ai-output').value;
      if (!v) { toast('还没有内容', 'err'); return; }
      copyText(v).then(ok => toast(ok ? '已复制结果' : '复制失败', ok ? 'ok' : 'err'));
    },
    'ai-save-script': () => {
      const v = $('#ai-output').value;
      if (!v) { toast('还没有内容', 'err'); return; }
      const scenario = $('#ai-scenario').value;
      scriptForm({ category: 'AI生成', title: 'AI-' + ({ followup: '跟进话术', weekly: '周报', lost: '复盘', battle: '作战建议' }[scenario] || '生成'), content: v });
    },
    'copy-datacode': () => {
      const code = btoa(unescape(encodeURIComponent(S.exportJSON())));
      copyText(code).then(ok => toast(ok ? '数据码已复制（微信发给自己即可跨设备迁移）' : '复制失败', ok ? 'ok' : 'err'));
    },
    'paste-datacode': () => {
      openForm({
        title: '粘贴数据码导入',
        fields: [{ name: 'code', label: '数据码', type: 'textarea', required: true, placeholder: '把之前复制的数据码粘到这里' }],
        submitText: '导入（会覆盖当前数据）',
        onSubmit: d => {
          try {
            const json = decodeURIComponent(escape(atob(d.code.trim())));
            S.importJSON(json);
            closeModal(); toast('导入成功', 'ok'); render();
          } catch (e) { toast('导入失败：' + e.message, 'err'); }
        }
      });
    },
    'check-pwa': () => {
      const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
      const sw = !!navigator.serviceWorker?.controller;
      toast(standalone ? '已以独立 App 模式运行' : sw ? 'Service Worker 已就绪，可添加到主屏幕' : '当前未安装，请点击浏览器菜单「添加到主屏幕」', 'ok');
    }
  };

  function openCustomerDetail(id) {
    const c = S.get('customers', id);
    if (!c) return;
    openModal(V.customerDetail(c));
  }

  /* ---------- 工具 ---------- */
  function download(text, filename, type) {
    const blob = new Blob([text], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    toast('已导出：' + filename, 'ok');
  }
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(() => true).catch(() => fallbackCopy(text));
    }
    return Promise.resolve(fallbackCopy(text));
  }
  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    return ok;
  }

  /* ============================================================
   * 事件绑定
   * ============================================================ */
  function bind() {
    // 全局点击（事件委托）
    document.addEventListener('click', e => {
      const el = e.target.closest('[data-action]');
      if (!el) {
        // 点击遮罩关闭
        if (e.target.id === 'modal-backdrop') closeModal();
        return;
      }
      e.preventDefault();
      const fn = actions[el.dataset.action];
      if (fn) fn(el);
    });

    // 标签页
    $('#tabs').addEventListener('click', e => {
      const t = e.target.closest('.tab');
      if (t) switchView(t.dataset.view);
    });

    // 全局搜索
    const gs = $('#global-search');
    gs.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        filters.customers.q = gs.value;
        switchView('customers');
      }
    });

    // 筛选器（动态元素，事件委托）
    document.addEventListener('change', e => {
      const id = e.target.id;
      const cl = e.target.classList;
      if (id === 'c-level') { filters.customers.level = e.target.value; render(); }
      else if (id === 'c-status') { filters.customers.status = e.target.value; render(); }
      else if (id === 'c-sort') { filters.customers.sort = e.target.value; render(); }
      else if (id === 'f-customer') { filters.followups.customerId = e.target.value; render(); }
      else if (id === 'f-type') { filters.followups.type = e.target.value; render(); }
      /* 下拉框走的是 change，不是 click ——
       * 早先把它当 click 处理，结果用户切了服务商界面一点反应都没有。 */
      else if (id === 'ai-provider') { if (actions['ai-provider-change']) actions['ai-provider-change'](e.target); }
      else if (id === 'team-role-sel') { /* 成员角色由它自己的 data-action 处理 */ }
      /* 「补充要求」这个框在不同场景下要填的东西不一样：
       * 话术军火里它是**客户原话**（核心输入，不是可选的补充），
       * 提示词写错用户就会留空，生成出来一堆废话。 */
      else if (id === 'ai-scenario') {
        const ta = $('#ai-extra');
        const lab = ta && ta.closest('.field') ? ta.closest('.field').querySelector('label') : null;
        if (e.target.value === 'advise') {
          if (ta) ta.placeholder = '把客户的原话粘在这里，例：「你们比别家贵 20%」';
          if (lab) lab.textContent = '客户原话（必填）';
        } else {
          if (ta) ta.placeholder = '例：语气客气一点 / 突出 ROI / 催单但不显得急';
          if (lab) lab.textContent = '补充要求';
        }
      }
      else if (cl.contains('stage-sel') || cl.contains('mstage-sel')) {
        S.setStage(e.target.dataset.id, e.target.value, true);
        toast('阶段已更新为「' + S.stageOf(e.target.value).name + '」', 'ok');
        render();
        /* 赢/输的三个入口（看板下拉、拖拽、健康度一键推进）都要接上沉淀，
         * 漏一个就会出现「明明签了单却没让我记经验」的困惑 */
        maybeDebrief(S.get('deals', e.target.dataset.id));
      }
      else if (id === 'ai-scenario') { filters.ai.scenario = e.target.value; }
      else if (id === 'ai-customer') { filters.ai.customerId = e.target.value; }
      else if (id === 'sync-mode') { renderSyncStatus(); }
      else if (id === 'health-sensitivity') {
        Health.setSettings({ sensitivity: Number(e.target.value) || 1 });
        Health.invalidate(); render(); toast('提醒松紧已更新', 'ok');
      }
      else if (id === 'health-snooze') {
        Health.setSettings({ snoozeDays: Math.max(1, Number(e.target.value) || 7) });
        Health.invalidate(); render();
      }
      else if (id === 'health-enabled') {
        Health.setSettings({ enabled: e.target.value === '1' });
        Health.invalidate(); render();
        toast(e.target.value === '1' ? '健康度提醒已开启' : '健康度提醒已关闭', 'ok');
      }
    });
    document.addEventListener('input', e => {
      if (e.target.id === 'c-search') {
        filters.customers.q = e.target.value;
        const pos = e.target.selectionStart;
        render();
        const el = $('#c-search');
        if (el) { el.focus(); el.setSelectionRange(pos, pos); }
      }
    });

    // Esc 关闭弹窗；录入框里按回车直接解析（省一次点击）
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeModal();
      if (e.key === 'Enter' && e.target && e.target.id === 'ql-input') {
        e.preventDefault();
        qlParse();
      }
    });

    // 看板拖拽
    const main = $('#main');
    main.addEventListener('dragstart', e => {
      const card = e.target.closest('.deal');
      if (!card) return;
      e.dataTransfer.setData('text/plain', card.dataset.deal);
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
    });
    main.addEventListener('dragend', e => {
      const card = e.target.closest('.deal');
      if (card) card.classList.remove('dragging');
      $$('.col').forEach(c => c.classList.remove('drag-over'));
    });
    main.addEventListener('dragover', e => {
      const col = e.target.closest('.col');
      if (!col) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });
    main.addEventListener('dragenter', e => {
      const col = e.target.closest('.col');
      if (col) col.classList.add('drag-over');
    });
    main.addEventListener('dragleave', e => {
      const col = e.target.closest('.col');
      if (col && !col.contains(e.relatedTarget)) col.classList.remove('drag-over');
    });
    main.addEventListener('drop', e => {
      const col = e.target.closest('.col');
      if (!col) return;
      e.preventDefault();
      col.classList.remove('drag-over');
      const id = e.dataTransfer.getData('text/plain');
      if (!id) return;
      const before = S.get('deals', id);
      S.setStage(id, col.dataset.stage);
      const after = S.get('deals', id);
      render();
      if (after.stage === 'won') toast(`🎉 ${S.customerName(after.customerId)} 赢单 ${S.moneyFull(after.amount)}`, 'ok');
      else if (after.stage === 'lost') toast(`已标记为输单，记得补上输单原因`, 'err');
      else if (before.stage !== after.stage) toast(`已推进到「${S.stageOf(after.stage).name}」`, 'ok');
      /* 赢/输的当下是最适合沉淀的时刻，弹一次复盘框。
       * 弹不弹由它自己判断（有没有料、沉没沉淀过），这里不用管 */
      maybeDebrief(after);
    });
  }

  /* 页签栏是 sticky 的，必须时刻贴在顶栏正下方。
   * 顶栏的高度不是写死的：手机上项目会换行，从一行 55px 变成三行 187px；
   * 放大字体、切横竖屏、地址栏收起，都会让它变。
   * 所以这里实测一次，写进 --topbar-h，之后交给 ResizeObserver 一直盯着。
   *
   * 修的是一个真实故障：CSS 里原来写死 top:55px，
   * 手机上顶栏实际 187px，页签往上跑进顶栏里，被 z-index 更高的顶栏整条盖住 ——
   * 页面往下一滚，八个页签一个都点不动，滚回顶部又好了。
   * 这种时好时坏的毛病最难自查，只能从「别猜，去量」上根治。 */
  function keepTabsUnderTopbar() {
    const bar = document.querySelector('.topbar');
    if (!bar) return;
    const sync = () => {
      const h = Math.round(bar.getBoundingClientRect().height);
      if (h > 0) document.documentElement.style.setProperty('--topbar-h', h + 'px');
    };
    sync();
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(sync).observe(bar);
    else window.addEventListener('resize', sync);
    /* 字体、图标加载完之后高度还会再变一次，兜一个延迟。
     * 中文字体比英文晚到，第一行往往是被它撑高的。 */
    setTimeout(sync, 300);
    window.addEventListener('orientationchange', () => setTimeout(sync, 200));
  }

  /* ============================================================
   * 标签页徽章：不打开也能看见还有多少事没办
   *
   * 这是整个工具唯一一处「主动」的地方。
   *
   * 想清楚一件事再做：纯前端、无服务器的网页，**没法**在没打开时弹窗提醒，
   * 浏览器不允许。硬做推送是做不到的，别自欺欺人。
   *
   * 但销售很可能把这个页面**一直开着**——当成工作面板之一，
   * 旁边是邮箱、Excel、客户微信群。这时候浏览器标签栏上那个「(3)」，
   * 就是唯一还在持续提醒他的东西：不弹窗、不打断、不吵，
   * 但他在别的标签页干活时，眼角余光一直能看到还有几件事没办。
   *
   * 成本几乎为零，曝光次数一天几十次。这买卖划算。
   * ============================================================ */
  const BASE_TITLE = '销冠助手 · 个人销售作战台';
  /* 原图标（蓝底「销」字）留着，数量为 0 时还回去。
   * 换成数字图标后要能换回来，不能一去不回。 */
  const BASE_ICON = (document.querySelector("link[rel~='icon']") || {}).href || '';

  function badgeIcon(n) {
    /* 有数字时画一张「蓝底 + 白色数字」的图。
     * 刻意不画「销」字：canvas 里的中文字体不可控，
     * 系统没装中文字体就画成一坨豆腐块，而阿拉伯数字到哪都有。
     * 这是拿可靠性换美观 —— favicon 只有 16×16，认得清数字就够了。 */
    const size = 64;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const x = c.getContext('2d');
    if (!x) return '';
    const g = x.createLinearGradient(0, 0, size, size);
    g.addColorStop(0, '#2563eb');
    g.addColorStop(1, '#7c3aed');
    x.fillStyle = g;
    /* 圆角，跟原图标一个形状，别让人以为是换了应用 */
    const r = 14;
    x.beginPath();
    x.moveTo(r, 0); x.lineTo(size - r, 0); x.quadraticCurveTo(size, 0, size, r);
    x.lineTo(size, size - r); x.quadraticCurveTo(size, size, size - r, size);
    x.lineTo(r, size); x.quadraticCurveTo(0, size, 0, size - r);
    x.lineTo(0, r); x.quadraticCurveTo(0, 0, r, 0);
    x.closePath(); x.fill();

    const txt = n > 99 ? '99+' : String(n);
    x.fillStyle = '#fff';
    x.font = 'bold ' + (txt.length > 2 ? 24 : txt.length > 1 ? 34 : 42) + 'px sans-serif';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillText(txt, size / 2, size / 2 + 2);
    return c.toDataURL('image/png');
  }

  function updateBadge() {
    /* 徽章算的是「今天到期 + 已逾期」的客户数，和首页待跟进清单同源。
     * 用 stats().pending 而不是自己再算一遍 ——
     * 两处算法一旦不一致，用户会发现「标题说 3 件，点进去是 5 件」，
     * 然后就再也不信这个数字了。 */
    let n = 0;
    try { n = (S.stats().pending || []).length; } catch (e) { return; }

    document.title = n > 0 ? '(' + n + ') ' + BASE_TITLE : BASE_TITLE;

    let link = document.querySelector("link[rel~='icon']");
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    if (n > 0) {
      const icon = badgeIcon(n);
      /* toDataURL 在某些受限环境（file:// + 严格隐私设置）会返回空，
       * 那就保留原图标，标题上的数字还在，不影响使用 */
      if (icon) link.href = icon;
    } else if (BASE_ICON) {
      link.href = BASE_ICON;
    }
  }

  /* ============================================================
   * 启动
   * ============================================================ */
  /* 给新用户灌一套示例数据。
   *
   * 判定的三条铁律写在 store.js 的 shouldSeedDemo() 里，这里只负责一件
   * 容易被忽略的事：**调用的时机**。
   *
   * 必须在「云端到底有没有数据」这个答案落定之后再判。判早了会出这种事：
   * 老用户换台新设备打开 → 本地是空的 → 兴冲冲灌一套示例 →
   * 同步才把真实客户拉下来 → 假客户和真客户混在一起，比重生还难收拾
   * （他得一条条认哪些是假的）。所以下面把它排在首次同步之后。 */
  function maybeSeedDemo() {
    if (!S.shouldSeedDemo()) return false;
    S.seed(true);
    render();
    setTimeout(() => toast('已为你载入一套示例数据，可在「设置」中清空', 'ok'), 400);
    return true;
  }

  /* 登录后要做的事：如果同步方式已经是「账号」，立刻跑一次把云端数据拉下来。
   * 刻意不自动把 mode 改成 cloud —— 用户可能只是登个号，还想继续用自建后端。 */
  function afterLogin() {
    if ((Sync.cfg().mode || 'off') === 'cloud') {
      Promise.resolve(Sync.start()).catch(() => null).then(() => { renderSyncStatus(); render(); });
    }
    loadTeam();
  }

  /* 团队看板的数据是异步拉的。刻意只重刷这一屏而不调 render()——
   * render 里又会根据「没数据」触发一次加载，那就是死循环了。 */
  let boardData = null;
  let boardLoading = false;
  async function loadBoard() {
    if (boardLoading || !window.Team) return;
    boardLoading = true;
    try { boardData = await Team.load(); }
    catch (e) { boardData = { rows: [], total: Team.emptyTotal(), error: e.message }; }
    boardLoading = false;
    if (view === 'team') {
      const sec = $('#view-team');
      if (sec) sec.innerHTML = V.team(boardData);
    }
  }

  /* 管理员的成员列表是异步拉的，渲染时拿不到，只能事后填。
   * 普通成员调 teamMembers() 会拿到空数组（RLS 拦的），这里也就没什么可显示。 */
  async function loadTeam() {
    const box = $('#team-members');
    if (!box || !window.Auth || !Auth.isOn() || !Auth.isAdmin()) return;
    box.innerHTML = '<span class="muted small">正在读取成员…</span>';

    /* 邀请码：这是把人加进团队的唯一入口，管理员必须看得见 */
    const ia = $('#invite-area');
    if (ia) {
      ia.innerHTML = '<span class="muted small">正在读取邀请码…</span>';
      try {
        let code = await Auth.inviteCode();
        if (!code) code = await Auth.resetInviteCode();   // 老团队可能没生成过
        ia.innerHTML = `
          <div class="field"><label>团队邀请码</label>
            <div style="display:flex;gap:6px;align-items:center">
              <code id="invite-code" style="font-size:18px;letter-spacing:2px;font-weight:700">${E(String(code))}</code>
              <button class="btn btn-sm" data-action="reset-invite">重置</button>
            </div></div>
          <div class="hint">让同事注册后填这个码加入。
            他加入之后<b>仍然只有自己能看自己的客户</b>，你只是能看到全队进度。</div>`;
      } catch (e) {
        ia.innerHTML = `<span class="down small">邀请码读取失败：${E(e.message)}</span>`;
      }
    }

    let members = [];
    try { members = await Auth.teamMembers(); } catch (e) {
      box.innerHTML = `<span class="down small">读取失败：${E(e.message)}</span>`;
      return;
    }
    if (!members.length) {
      box.innerHTML = '<span class="muted small">团队里还没有其他人。让他们自己注册，你再在这里把角色改过来。</span>';
      return;
    }
    const roleName = { owner: '拥有者', admin: '管理员', member: '使用员' };
    box.innerHTML = `
      <table class="tbl" style="margin-top:8px">
        <thead><tr><th>成员</th><th>角色</th><th>操作</th></tr></thead>
        <tbody>
        ${members.map(m => `
          <tr>
            <td>${E(m.display_name || String(m.id).slice(0, 8))}${m.id === Auth.userId() ? ' <span class="muted small">（我）</span>' : ''}</td>
            <td>
              <select data-action="team-set-role" data-uid="${E(m.id)}"
                ${(m.id === Auth.userId() && m.role === 'owner') ? 'disabled' : ''}>
                ${['owner', 'admin', 'member'].map(r =>
                  `<option value="${r}"${m.role === r ? ' selected' : ''}>${roleName[r]}</option>`).join('')}
              </select>
            </td>
            <td>
              ${m.id === Auth.userId() ? '<span class="muted small">—</span>'
                : `<button class="btn btn-sm btn-danger" data-action="team-remove"
                    data-uid="${E(m.id)}" data-name="${E(m.display_name || '这位成员')}">移出团队</button>`}
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
      <div class="hint">角色说明：<b>使用员</b>只见自己的客户；<b>管理员</b>能看到全队进度，但改不动别人的数据；
        <b>拥有者</b>权限同管理员，另外能改团队名。把 owner 转给别人之前，你不能把自己降下来。</div>`;
  }

  function init() {
    keepTabsUnderTopbar();
    S.load();
    /* 账号初始化必须在 render 之前：登录态决定设置页显示哪一块。
     * 没登录时这里全是空操作，不会发任何请求，也不会弹出任何东西。 */
    if (window.Auth) {
      Auth.init();
      Auth.on(refreshTeamTab);      // profile 异步回来后，把页签补上
    }
    bind();
    render();

    // 云同步：状态订阅 + 启动（未配置时是空操作，不会发任何请求）
    const cloudOn = !!(window.Sync && (Sync.cfg().mode || 'off') !== 'off');
    if (window.Sync) {
      Sync.on(renderSyncStatus);
      renderSyncStatus();
    }
    if (cloudOn) {
      /* 账号模式要先确认登录态：没登录就别白跑一趟同步，
       * 但也不能因此卡住启动——就跟断网一样，跳过就是了。 */
      if ((Sync.cfg().mode || '') === 'cloud' && window.Auth && !Auth.isOn()) {
        const hint = $('#sync-status');
        if (hint) hint.innerHTML = '<span class="down">账号模式需要登录，本次已跳过</span> —— 本地数据不受影响，登录后去设置页点一次「保存并连接」。';
        maybeSeedDemo();
      } else {
        /* start() 返回首次同步的 Promise。等它落定再判示例 ——
         * 网络不通时 sync 会 reject，catch 掉即可：拉不到就当云端是空的，
         * 该给新用户的体验照样给，不能因为断网就卡住整个启动流程。 */
        Promise.resolve(Sync.start())
          .catch(() => null)
          .then(() => { maybeSeedDemo(); renderSyncStatus(); });
      }
    } else {
      maybeSeedDemo();
    }

    /* 跟进提醒。未授权、不支持、没数据都不会有任何动静，
     * 只有真的有该跟进的客户时才弹一次。 */
    if (window.Notify) {
      try { Notify.start(); } catch (e) { /* 通知失败绝不能影响主流程 */ }
    }
    if (window.Auth && Auth.isOn()) loadTeam();

    // 注册 Service Worker，支持 PWA 离线使用
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(e => console.log('SW 注册失败（file:// 环境属于正常）:', e));
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
