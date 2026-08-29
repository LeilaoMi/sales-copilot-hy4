/* ============================================================
 * 销冠助手 · AI 助手层（可选增强）
 * 数据与 API Key 全部本地，请求直连用户配置的服务商，无中间服务器。
 * 默认兼容 OpenAI 格式（DeepSeek / 通义 / OpenAI 等）。
 * ============================================================ */
window.AI = (function () {
  const S = Store;

  function cfg() { return S.state.settings.ai || {}; }

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
      prompt += '任务：根据以下本周销售数据，写一份周报，可直接发给直属领导。\n';
      prompt += weeklyContext();
      prompt += `\n要求：${extra || '包含：①本周关键成果 ②重点客户推进 ③下周行动计划 ④需要支持。简洁，不超过 400 字。'}`;
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
  async function ask(prompt) {
    const c = cfg();
    if (!c.key) throw new Error('未配置 API Key，请先在「设置 → AI 助手」中配置');
    const url = (c.base || 'https://api.deepseek.com/v1').replace(/\/$/, '') + '/chat/completions';
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + c.key },
      body: JSON.stringify({
        model: c.model || 'deepseek-chat',
        messages: [
          { role: 'system', content: '你是销冠助手内置的销售顾问，用中文回答，输出可直接复制使用。' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        stream: false
      })
    });
    if (!resp.ok) {
      let msg = 'HTTP ' + resp.status;
      try { const e = await resp.json(); msg = e.error?.message || JSON.stringify(e); } catch (e) {}
      throw new Error(msg);
    }
    const data = await resp.json();
    return data.choices?.[0]?.message?.content || '';
  }

  /* ---------- 快捷工具 ---------- */
  function testConnection() {
    return ask('你好，请回复“连接成功”二字。');
  }

  return { buildPrompt, ask, testConnection };
})();
