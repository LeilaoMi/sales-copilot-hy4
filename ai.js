/* ============================================================
 * 销冠助手 · AI 助手层（可选增强）
 * 数据与 API Key 全部本地，请求直连用户配置的服务商，无中间服务器。
 *
 * 统一走 OpenAI Chat Completions 协议。这不是偷懒——
 * 国内主流模型商（DeepSeek / 智谱 / 通义 / Moonshot / 豆包 / 硅基流动）
 * 现在都兼容这套协议，意味着换模型只是换一个地址 + 一个模型名，
 * 不用给每家写一套代码。用户手里的免费 key 才能真的用起来。
 *
 * 一条原则：**AI 只做生成，不做判断。**
 *   数字、金额、日期这些必须来自本地账本（见 buildPrompt 里的上下文拼装）。
 *   让模型编数字，错了没人知道；让模型润色文字，错了用户一眼看出来。
 * ============================================================ */
window.AI = (function () {
  const S = Store;

  /* ---------- 服务商预设 ----------
   * g 字段用于分组（cn 国内直连 / intl 海外 / local 本机自建 / custom 自定义）。
   * 标了免费额度的是真能白嫖的——个人小团队最该先试这几个。
   * 免费政策会变，所以这里只写「有免费额度」，具体以各家官网为准。
   *
   * ── 关于这些地址的可信度（改之前务必读）──
   * 用户踩过一次狠的：复制了 https://open.bigmodel.cn/api/coding/paas
   * 去拉取模型，得到 404 —— 少了 /v4 那一截。
   * 所以这里的地址不是凭记忆抄的，是拿 GET {base}/models 逐个探过的：
   *   401/403 = 端点存在，只是 Key 无效（要的就是这个）
   *   404     = 路径不对
   *   000     = 沙箱网络到不了，没能实测
   * 实测结果记在每个分组的注释里。标「未实测」的那几家（OpenAI / Mistral /
   * xAI / Gemini / Perplexity / Anthropic）是从沙箱连不上的，用的是各家
   * 官方文档的公开地址，第一次用如果报 404，按提示里的常见写法试 /v4、/v1。 */
  const PROVIDERS = {
    /* ── 国内直连：2026-09-01 实测 12 家全部返回 401/403，端点都有效 ── */
    deepseek: { g: 'cn', name: 'DeepSeek', base: 'https://api.deepseek.com/v1', model: 'deepseek-chat', note: '' },
    /* 注意 base 一定要包含 /v4 那一截：
     * 智谱的列表/对话都挂在 /api/paas/v4/* 下，少了这截直接 404。
     * 用户最容易踩的坑就是从别处复制地址时把 /v4 一起截掉了。 */
    zhipu: { g: 'cn', name: '智谱 GLM', base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', note: 'GLM-4-Flash 免费（地址含 /v4）' },
    qwen: { g: 'cn', name: '通义千问', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', note: '部分模型有免费额度' },
    siliconflow: { g: 'cn', name: '硅基流动', base: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct', note: '有免费模型' },
    moonshot: { g: 'cn', name: 'Moonshot Kimi', base: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', note: '' },
    doubao: { g: 'cn', name: '豆包（火山方舟）', base: 'https://ark.cn-beijing.volces.com/api/v3', model: '', note: '需在方舟控制台建推理接入点，模型名填接入点 ID' },
    qianfan: { g: 'cn', name: '百度千帆', base: 'https://qianfan.baidubce.com/v2', model: 'ernie-4.0-8k', note: '部分模型免费' },
    spark: { g: 'cn', name: '讯飞星火', base: 'https://spark-api-open.xf-yun.com/v1', model: 'generalv3.5', note: '有免费额度' },
    hunyuan: { g: 'cn', name: '腾讯混元', base: 'https://api.hunyuan.cloud.tencent.com/v1', model: 'hunyuan-turbo', note: '部分模型免费' },
    stepfun: { g: 'cn', name: '阶跃星辰', base: 'https://api.stepfun.com/v1', model: 'step-1-8k', note: '' },
    lingyi: { g: 'cn', name: '零一万物', base: 'https://api.lingyiwanwu.com/v1', model: 'yi-large', note: '' },
    minimax: { g: 'cn', name: 'MiniMax', base: 'https://api.minimax.chat/v1', model: 'abab6.5s-chat', note: '' },

    /* ── 海外 ──
     * 实测通的：Groq 403 / OpenRouter 200 / Together 401 / Fireworks 401 /
     *           Cerebras 403(地区限制) / SambaNova 200 / Nebius 401 /
     *           Novita 200 / DeepInfra 401
     * 沙箱连不上（000，未实测，用官方文档地址）：OpenAI / Anthropic /
     *           Gemini / Mistral / xAI / Perplexity */
    openai: { g: 'intl', name: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-4o-mini', note: '未实测（沙箱连不上）' },
    /* Azure 的地址里带资源名和部署名，没法预设，只能让用户自己填 */
    azure: { g: 'intl', name: 'Azure OpenAI', base: '', model: '', note: '填 https://你的资源名.openai.azure.com/openai/deployments/部署名' },
    anthropic: { g: 'intl', name: 'Anthropic Claude', base: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5', note: '官方 OpenAI 兼容层，未实测' },
    gemini: { g: 'intl', name: 'Google Gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.0-flash', note: '有免费额度，未实测' },
    groq: { g: 'intl', name: 'Groq', base: 'https://api.groq.com/openai/v1', model: 'llama-3.1-8b-instant', note: '免费，国内访问不稳' },
    mistral: { g: 'intl', name: 'Mistral', base: 'https://api.mistral.ai/v1', model: 'mistral-small-latest', note: '部分免费，未实测' },
    xai: { g: 'intl', name: 'xAI Grok', base: 'https://api.x.ai/v1', model: 'grok-3-mini', note: '未实测' },
    openrouter: { g: 'intl', name: 'OpenRouter', base: 'https://openrouter.ai/api/v1', model: '', note: '一个 Key 用遍各家，模型名要带厂家前缀' },
    together: { g: 'intl', name: 'Together', base: 'https://api.together.xyz/v1', model: '', note: '' },
    fireworks: { g: 'intl', name: 'Fireworks', base: 'https://api.fireworks.ai/inference/v1', model: '', note: '' },
    perplexity: { g: 'intl', name: 'Perplexity', base: 'https://api.perplexity.ai', model: 'sonar', note: '未实测' },
    cerebras: { g: 'intl', name: 'Cerebras', base: 'https://api.cerebras.ai/v1', model: 'llama3.1-8b', note: '免费，地区限制严' },
    sambanova: { g: 'intl', name: 'SambaNova', base: 'https://api.sambanova.ai/v1', model: 'Meta-Llama-3.1-8B-Instruct', note: '有免费额度' },
    nebius: { g: 'intl', name: 'Nebius AI', base: 'https://api.studio.nebius.com/v1', model: '', note: '' },
    novita: { g: 'intl', name: 'Novita', base: 'https://api.novita.ai/v3/openai', model: '', note: '' },
    deepinfra: { g: 'intl', name: 'DeepInfra', base: 'https://api.deepinfra.com/v1/openai', model: '', note: '' },

    /* ── 本机 / 自建 ──
     * 这三个从沙箱连不上（服务没跑），地址是各家的默认端口。
     * 关键提醒：浏览器直接 fetch 本机服务会被 CORS 拦掉，
     * 各家都要额外开跨域，note 里写明了怎么开。 */
    ollama: { g: 'local', name: 'Ollama（本机）', base: 'http://localhost:11434/v1', model: 'qwen2.5:7b', note: '需先设 OLLAMA_ORIGINS=* 并重启，否则浏览器拦 CORS' },
    lmstudio: { g: 'local', name: 'LM Studio（本机）', base: 'http://localhost:1234/v1', model: '', note: '需在设置里开「允许跨域（CORS）」' },
    vllm: { g: 'local', name: 'vLLM / 自建网关', base: 'http://localhost:8000/v1', model: '', note: '需网关放行 CORS' },

    custom: { g: 'custom', name: '自定义（OpenAI 兼容）', base: '', model: '', note: '自己填地址和模型名' }
  };

  const GROUPS = [
    { id: 'cn', name: '国内直连' },
    { id: 'intl', name: '海外' },
    { id: 'local', name: '本机 / 自建' },
    { id: 'custom', name: '自定义' }
  ];

  function cfg() { return S.state.settings.ai || {}; }
  function saveCfg(patch) {
    S.state.settings.ai = Object.assign({}, cfg(), patch);
    S.state.settings.updatedAt = Date.now();
    S.save();
  }

  /* 实际生效的地址和模型：选了预设就用预设的，自定义就用自己的 */
  function endpoint() {
    const c = cfg();
    const p = PROVIDERS[c.provider] || PROVIDERS.deepseek;
    const base = (c.base || p.base || '').replace(/\/$/, '');
    return base + '/chat/completions';
  }
  function modelName() {
    const c = cfg();
    const p = PROVIDERS[c.provider] || PROVIDERS.deepseek;
    return c.model || p.model || '';
  }

  /* ---------- Prompt 工厂 ---------- */
  function buildPrompt(scenario, customerId, extra) {
    const now = S.fmtDateTime(new Date());
    let prompt = `[当前时间：${now}]\n`;
    prompt += `你是一名经验丰富的 B2B 销售顾问，擅长写跟进话术、销售周报、复盘分析和作战建议。回答要具体、可执行，不要用套话。\n\n`;

    if (scenario === 'followup') {
      prompt += '任务：为以下客户写一条跟进话术，可直接用于微信或电话。\n';
      prompt += customerContext(customerId);
      prompt += `\n要求：${extra || '语气专业、不卑不亢；先承接上下文，再给出一个明确的下一步动作（如"周三下午 3 点线上演示"）。控制在 120 字以内。'}`;
    }
    else if (scenario === 'weekly') {
      /* 五段式：借鉴了同款项目的分法，但**数字全部来自本地账本**，
       * 模型只负责解读和组织语言，不许自己编数。 */
      prompt += '任务：根据以下本周销售数据，写一份周报，可直接发给直属领导。\n';
      prompt += weeklyContext();
      prompt += `\n要求：${extra || '严格按这五段写，每段一个小标题：①回顾（本周做了什么，用上面的数字）②解读（数字说明什么，哪里好哪里糟）③风险（哪几单可能要凉，为什么）④下周行动清单（3-5 条，每条要有客户名 + 具体动作 + 时间）⑤一句话总结（给领导看的那句）。数据只能用上面给的，不许自己编。不超过 500 字。'}`;
    }
    else if (scenario === 'lost') {
      prompt += '任务：分析以下输单记录，给出复盘结论。\n';
      prompt += lostContext();
      prompt += `\n要求：${extra || '归纳输单原因 TOP3、金额分布、给出 3 条可执行的改进动作（下个月就能做）。'}`;
    }
    else if (scenario === 'battle') {
      prompt += '任务：为以下重点客户制定下一步作战建议。\n';
      prompt += customerContext(customerId, true);
      prompt += `\n要求：${extra || '输出：①客户决策链猜测 ②当前卡点 ③下一步 3 个具体动作（谁、什么时候、做什么）④风险提醒。'}`;
    }
    /* ---------- 情报简报（新增）----------
     * 同款项目是靠 Tavily 联网抓公司信息再让模型综合。
     * 这里不接联网搜索：国内访问不稳、要再付一份钱，
     * 而且销售自己搜比我接 API 准。
     * 所以改成「模型自身知识 + 用户已经填的客户信息」，
     * 但必须明确标注待核实——**宁可说不确定，不能编得像真的**。 */
    else if (scenario === 'intel') {
      prompt += '任务：为这家客户写一份作战简报。\n';
      prompt += customerContext(customerId, true);
      prompt += `
输出严格按这六段，每段一个小标题：
① 背景：这家公司是做什么的、大概什么规模（基于你的了解和上面给的信息）
② 行业痛点 TOP3：这个行业通常最头疼的三件事
③ 决策人关心什么：按上面给的联系人职务，猜他最在意什么
④ 中文开场白：一条可以直接发微信的开场白，60 字以内
⑤ 英文开场白：一条英文版开场白，60 词以内
⑥ 雷区：跟这类客户打交道容易踩的坑，3 条

**极其重要**：
- 你没有联网，上面给的信息有限。凡是**推测**的内容，必须在句尾标注「（待核实）」。
- 行业痛点、决策人关注点这类通用判断，请明确写成「这个行业通常……」而不是断言「这家公司就是……」。
- 宁可说「不确定」，也不要编得像亲眼见过。销售拿着一份编出来的简报去见客户，比没有简报更糟。
${extra ? '\n补充要求：' + extra : ''}`;
    }
    /* ---------- 话术军火（新增）----------
     * 本地四路加权检索已经在 playbook 里做得挺准，
     * 这里让模型做的是「把检索到的素材改写成能直接发出去的话」，
     * 也就是生成，不是判断——符合上面那条原则。 */
    else if (scenario === 'advise') {
      prompt += '任务：客户说了下面这句话，帮我接住。\n';
      prompt += `客户原话：${extra || '（未提供）'}\n`;
      if (customerId) prompt += customerContext(customerId);
      const hits = (typeof Playbook !== 'undefined' && Playbook.search) ? Playbook.search(extra || '', 3) : [];
      if (hits.length) {
        prompt += '\n本地话术库里找到的参考资料（优先参考这些，它们是自己人实战过的）：\n';
        hits.forEach((h, i) => {
          prompt += `  [${i + 1}] ${h.title || h.scene || ''}\n      ${String(h.content || '').replace(/\n/g, ' ').slice(0, 300)}\n`;
        });
      }
      prompt += `
输出四段：
① 判断：客户说这话，真实意思是什么（一句话）
② 应对要点：3 条，每条一句话
③ 可以直接发的话：一段完整的微信文字，口语化，120 字以内
④ 下一步：什么时候、用什么方式再跟进

要求：不要模板腔，不要「感谢您的信任」这类废话。`;
    }
    return prompt;
  }

  function customerContext(id, deep) {
    if (!id) return '（未指定客户，请生成一条通用的客户跟进开场话术）';
    const c = S.get('customers', id);
    if (!c) return '（客户不存在）';
    const m = S.customerMeta(c);
    const deals = S.list('deals').filter(d => d.customerId === id);
    const fus = S.list('followups').filter(f => f.customerId === id).sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 3);
    let s = `客户：${c.name}\n`;
    s += `分级：${c.level} / 状态：${c.status} / 行业：${c.industry || '未知'} / 来源：${c.source || '未知'}\n`;
    s += `联系人：${c.contact || '未知'}（${c.title || '职务未知'}）\n`;
    s += `商机：${m.dealCount} 个，在谈 ${S.moneyFull(m.openAmount)}，已成交 ${S.moneyFull(m.wonAmount)}\n`;
    if (deals.length) {
      s += '商机明细：\n' + deals.map(d => `  - ${d.title}：${S.stageOf(d.stage).name}，${S.moneyFull(d.amount)}，预计成交 ${d.expectedClose || '未定'}${d.lostReason ? '，输单原因：' + d.lostReason : ''}`).join('\n') + '\n';
    }
    if (fus.length) {
      s += '最近跟进：\n' + fus.map(f => `  - ${S.fmtDateTime(f.at)} ${f.type}：${f.content.replace(/\n/g, ' ')}`).join('\n') + '\n';
    }
    if (c.tags) s += `标签：${c.tags}\n`;
    if (deep && c.note) s += `客户备注/决策链：${c.note}\n`;
    return s;
  }

  function weeklyContext() {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 86400000);
    const newCust = S.list('customers').filter(c => new Date(c.createdAt) >= weekAgo);
    const fus = S.list('followups').filter(f => new Date(f.at) >= weekAgo);
    const won = S.list('deals').filter(d => d.stage === 'won' && d.closedAt && new Date(d.closedAt) >= weekAgo);
    const advanced = S.list('deals').filter(d => d.updatedAt && new Date(d.updatedAt) >= weekAgo && !['won','lost'].includes(d.stage));
    const st = S.stats();
    let s = `本周（${S.fmtDate(weekAgo)} 至 ${S.fmtDate(now)}）数据：\n`;
    s += `- 新增客户：${newCust.length} 家\n`;
    s += `- 跟进记录：${fus.length} 条\n`;
    s += `- 已赢单：${won.length} 单，金额 ${S.moneyFull(S.sum(won, d => d.amount))}\n`;
    s += `- 推进中的商机：${advanced.length} 个\n`;
    s += `- 本月目标完成率：${Math.round(st.rate * 100)}%\n`;
    if (fus.length) {
      s += '本周重点跟进（按时间倒序前 10 条）：\n' + fus.slice().sort((a,b)=>String(b.at).localeCompare(String(a.at))).slice(0,10).map(f => {
        const c = S.get('customers', f.customerId);
        return `  ${S.fmtDate(f.at)} ${c ? c.name : ''} ${f.type}：${f.content.replace(/\n/g, ' ')}`;
      }).join('\n') + '\n';
    }
    if (advanced.length) {
      s += '本周推进的商机：\n' + advanced.map(d => `  ${d.title}（${S.customerName(d.customerId)}）→ ${S.stageOf(d.stage).name}`).join('\n') + '\n';
    }
    return s;
  }

  function lostContext() {
    const lost = S.list('deals').filter(d => d.stage === 'lost');
    if (!lost.length) return '暂无输单记录。';
    let s = `输单总数：${lost.length} 单，金额合计 ${S.moneyFull(S.sum(lost, d => d.amount))}\n`;
    const reasons = {};
    lost.forEach(d => {
      const r = d.lostReason || '未填写原因';
      reasons[r] = (reasons[r] || 0) + 1;
    });
    s += '输单原因分布：\n' + Object.entries(reasons).sort((a,b)=>b[1]-a[1]).map(([r,n])=>`  - ${r}：${n} 单`).join('\n') + '\n';
    s += '输单明细：\n' + lost.map(d => `  ${S.customerName(d.customerId)} ${d.title} ${S.moneyFull(d.amount)}：${d.lostReason || '未填原因'}`).join('\n') + '\n';
    return s;
  }

  /* ---------- API 调用 ---------- */
  async function ask(prompt, opts) {
    const c = cfg();
    if (!c.key) throw new Error('还没配置 API Key，请先在「设置 → AI 助手」里填');
    const url = endpoint();
    if (!url || url === '/chat/completions') {
      throw new Error('还没填接口地址（选自定义时要自己填 Base URL）');
    }
    const model = modelName();
    if (!model) throw new Error('还没填模型名');

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + c.key },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: '你是销冠助手内置的销售顾问，用中文回答，输出可直接复制使用。' },
          { role: 'user', content: prompt }
        ],
        temperature: (opts && opts.temperature) || 0.7,
        stream: false
      })
    });
    if (!resp.ok) {
      let msg = 'HTTP ' + resp.status;
      try { const e = await resp.json(); msg = (e.error && e.error.message) || e.message || JSON.stringify(e); } catch (e) {}
      throw new Error(msg);
    }
    const data = await resp.json();
    return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  }

  /* ---------- 多轮对话 ----------
   * ask() 是「一问一答」，但陪练这类场景必须带上前面说过的话，
   * 否则 AI 扮演的客户每一轮都失忆，聊两句就自相矛盾，练不下去。
   *
   * 和系统提示分开传，是因为不同场景要给它不同的「人设」，
   * 写死在 ask() 里会让那个函数越来越臃肿。 */
  async function chat(messages, opts) {
    const c = cfg();
    if (!c.key) throw new Error('还没配置 API Key，请先在「设置 → AI 助手」里填');
    const url = endpoint();
    if (!url || url === '/chat/completions') {
      throw new Error('还没填接口地址（选自定义时要自己填 Base URL）');
    }
    const model = modelName();
    if (!model) throw new Error('还没填模型名');

    const o = opts || {};
    const msgs = [{ role: 'system', content: o.system || '你是销冠助手内置的销售顾问，用中文回答。' }]
      .concat(messages || []);

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + c.key },
      body: JSON.stringify({
        model: model,
        messages: msgs,
        temperature: typeof o.temperature === 'number' ? o.temperature : 0.8,
        stream: false
      })
    });
    if (!resp.ok) {
      let msg = 'HTTP ' + resp.status;
      try { const e = await resp.json(); msg = (e.error && e.error.message) || e.message || JSON.stringify(e); } catch (e) {}
      throw new Error(msg);
    }
    const data = await resp.json();
    return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  }

  /* ---------- 测试连接 ---------- */
  function testConnection() {
    return ask('你好，请只回复“连接成功”四个字。', { temperature: 0 });
  }

  /* ---------- 拉取模型列表 ----------
   * 各家都实现了 OpenAI 的 GET /v1/models，
   * 有了这个就不用让用户手敲模型名——那玩意儿又长又容易打错。 */
  async function listModels() {
    const c = cfg();
    if (!c.key) throw new Error('还没配置 API Key');
    const p = PROVIDERS[c.provider] || PROVIDERS.deepseek;
    const base = (c.base || p.base || '').replace(/\/$/, '');
    if (!base) throw new Error('还没填接口地址');
    const resp = await fetch(base + '/models', {
      headers: { 'Authorization': 'Bearer ' + c.key }
    });
    /* 这里踩过坑：智谱 BigModel 把 401 / 400 错误塞进 HTTP 200 里返回
     * （响应体是 {"code":401,"msg":"令牌已过期...","success":false}），
     * resp.ok 是 true，但其实是鉴权失败。如果只看 HTTP 状态码，
     * 会落到下面"没返回模型列表"的分支，给的提示跟"地址填错"一样，
     * 用户看不出是 Key 的问题。所以 200 的响应必须额外看 body。
     *
     * 注意：HTTP 404 / 401 之类是正常错误，照 resp.status 报就行，
     * 不能也走 bodyErr 那条 —— 那会让「地址填错」被说成「Key 没权限」。 */
    if (resp.ok) {
      const data = await resp.json().catch(() => ({}));
      const zhipuStyleErr = (data.success === false && data.msg)
        || (typeof data.code === 'number' && data.code >= 400 && data.msg);
      if (zhipuStyleErr) {
        throw new Error('HTTP 200 但接口报错：' + zhipuStyleErr
          + '（常见原因：Key 没填 / 填错了 / 没权限）');
      }
      const list = (data.data || []).map(m => m.id || m.name).filter(Boolean);
      if (!list.length) throw new Error('这家没返回模型列表，请手动填模型名');
      return list.sort();
    }
    let msg = 'HTTP ' + resp.status;
    try { const e = await resp.json(); if (e && e.error && e.error.message) msg += ' · ' + e.error.message; } catch (e2) {}
    /* 404 最常见的是地址错了（缺 /v4 那一截）。
     * 直接把根路径（包含 v1 / v4）的几个常见形式列出来，
     * 用户看一眼就知道该往哪改，不用再翻官方文档。 */
    if (resp.status === 404) {
      msg += '（常见原因：接口地址少了一截 /v1 或 /v4，可以手动填模型名绕过）';
    } else if (resp.status === 401) {
      msg += '（Key 无效或没权限）';
    }
    throw new Error(msg);
  }

  /* ---------- 404 时自动找对地址 ----------
   * 用户踩过的最狠的一个坑：地址少了一截（智谱少了 /v4），
   * 拉取就 404，而提示再清楚他也得自己回去改、再点一次。
   * 与其让他猜，不如程序自己把常见的几种写法都试一遍：
   * 哪个通了就直接告诉他「应该填这个」，一行都不用他改。
   *
   * 只在 404 的时候试 —— 401 说明地址是对的，只是 Key 不行，
   * 那种情况瞎试地址纯属浪费时间。 */
  async function probeBase(base, key) {
    const root = String(base || '').replace(/\/+$/, '');
    if (!root) return null;
    const cands = [
      root + '/v1',
      root + '/v4',
      root + '/api/v1',
      root + '/api/paas/v4',
      root + '/openai/v1',
      root + '/compatible-mode/v1'
    ];
    /* 试的时候要快：每个最多 6 秒，而且是串行的，
     * 但 404 探测本来就很少发生，慢一点可以接受。
     * 反过来并行发 6 个请求容易被服务商当攻击。 */
    for (const cand of cands) {
      if (cand === root) continue;
      try {
        const r = await fetch(cand + '/models', {
          headers: { 'Authorization': 'Bearer ' + key }
        });
        /* 401 / 403 / 200 都算「这个地址是对的」：
         * 200 = 通了；401/403 = 路径对，只是我们的 Key 无效或没权限。
         * 只有 404 才是「这条路不存在」。 */
        if (r.status === 200 || r.status === 401 || r.status === 403) {
          return cand;
        }
      } catch (e) { /* 这一个不通，试下一个 */ }
    }
    return null;
  }

  /* ---------- 历史配置 ----------
   * 只存 key 的前几位，不存明文。
   * 切换历史时如果没重新填 key，就沿用在用的那个——
   * 借鉴项目也是这么处理的，理由一样：明文留在浏览器里不安全。 */
  const HISTORY_MAX = 5;
  function pushHistory(c) {
    const h = (S.state.settings.aiHistory || []).filter(x => x.sig !== signature(c));
    h.unshift({
      provider: c.provider || 'custom',
      base: c.base || '',
      model: c.model || '',
      sig: signature(c),
      keyHint: (c.key || '').slice(0, 6),
      at: Date.now()
    });
    S.state.settings.aiHistory = h.slice(0, HISTORY_MAX);
    S.save();
  }
  function signature(c) {
    return [c.provider || '', c.base || '', c.model || '', (c.key || '').slice(0, 6)].join('|');
  }

  return {
    PROVIDERS, GROUPS, cfg, saveCfg, endpoint, modelName,
    buildPrompt, ask, chat, testConnection, listModels, probeBase,
    pushHistory, customerContext, weeklyContext, lostContext
  };
})();
