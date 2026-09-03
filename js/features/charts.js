/* ============================================================
 * 销冠助手 · 图表层（纯手写 SVG，零依赖、断网可用）
 * ============================================================ */
window.Charts = (function () {
  const E = Store.escapeHtml;

  /* 环形进度：目标完成率 */
  function ring(percent, opts) {
    opts = opts || {};
    const size = opts.size || 150;
    const stroke = opts.stroke || 14;
    const r = (size - stroke) / 2;
    const c = 2 * Math.PI * r;
    const p = Math.max(0, Math.min(1, Number(percent) || 0));
    const color = opts.color || (p >= 1 ? '#16a34a' : p >= 0.6 ? '#2563eb' : p >= 0.3 ? '#f59e0b' : '#ef4444');
    const center = opts.center || Math.round(p * 100) + '%';
    const sub = opts.sub || '';
    return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img">
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="#eef2f7" stroke-width="${stroke}"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${stroke}"
        stroke-linecap="round" stroke-dasharray="${(c * p).toFixed(2)} ${c.toFixed(2)}"
        transform="rotate(-90 ${size / 2} ${size / 2})"/>
      <text x="50%" y="${sub ? '47%' : '52%'}" text-anchor="middle" font-size="${size * 0.2}" font-weight="800" fill="#1f2937">${E(center)}</text>
      ${sub ? `<text x="50%" y="63%" text-anchor="middle" font-size="${size * 0.09}" fill="#6b7280">${E(sub)}</text>` : ''}
    </svg>`;
  }

  /* 横向条形：销售漏斗 / 分级分布 */
  function hbar(items, opts) {
    opts = opts || {};
    const fmt = opts.fmt || (v => String(v));
    const max = Math.max(1, ...items.map(i => Number(i.value) || 0));
    const rowH = opts.rowH || 30;
    const height = items.length * rowH + 8;
    const W = 640, H = height;
    const labelW = opts.labelW || 52;
    const valueW = opts.valueW || 96;
    const barMax = W - labelW - valueW - 12;
    let y = 6;
    let bars = '';
    items.forEach(it => {
      const v = Number(it.value) || 0;
      const w = Math.max(v > 0 ? 3 : 0, barMax * (v / max));
      const cy = y + rowH / 2;
      bars += `
        <text x="${labelW - 8}" y="${cy + 4}" text-anchor="end" font-size="12" fill="#6b7280">${E(it.name)}</text>
        <rect x="${labelW}" y="${cy - 9}" width="${barMax}" height="18" rx="9" fill="#f1f5f9"/>
        <rect x="${labelW}" y="${cy - 9}" width="${w.toFixed(1)}" height="18" rx="9" fill="${it.color || '#2563eb'}"/>
        <text x="${labelW + 10}" y="${cy + 4}" font-size="11" fill="#fff" font-weight="600"
          ${w < 46 ? 'display="none"' : ''}>${E(fmt(v, it))}</text>
        <text x="${W - 4}" y="${cy + 4}" text-anchor="end" font-size="12" fill="#1f2937" font-weight="600">${E(opts.right ? opts.right(it) : '')}</text>`;
      y += rowH;
    });
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="xMinYMin meet" role="img">${bars}</svg>`;
  }

  /* 折线 + 面积：近 6 月业绩 */
  function line(points, opts) {
    opts = opts || {};
    const W = 640, H = opts.height || 210;
    const padL = 56, padR = 12, padT = 14, padB = 28;
    const innerW = W - padL - padR, innerH = H - padT - padB;
    const max = Math.max(1, ...points.map(p => p.value));
    const niceMax = niceCeil(max);
    const n = points.length;
    const x = i => padL + (n === 1 ? innerW / 2 : innerW * i / (n - 1));
    const y = v => padT + innerH - innerH * (v / niceMax);

    let grid = '', ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const v = niceMax * i / ticks;
      const gy = y(v);
      grid += `<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${W - padR}" y2="${gy.toFixed(1)}" stroke="#eef2f7" stroke-width="1"/>
        <text x="${padL - 8}" y="${(gy + 4).toFixed(1)}" text-anchor="end" font-size="10" fill="#9ca3af">${E(Store.money(v))}</text>`;
    }
    const dLine = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
    const dArea = `${dLine} L${x(n - 1).toFixed(1)},${(padT + innerH).toFixed(1)} L${x(0).toFixed(1)},${(padT + innerH).toFixed(1)} Z`;

    let dots = '', labels = '';
    points.forEach((p, i) => {
      const cx = x(i), cy = y(p.value);
      dots += `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="4" fill="#fff" stroke="#2563eb" stroke-width="2.5">
        <title>${E(p.label)}：${E(Store.moneyFull(p.value))}${p.count != null ? '（' + p.count + '单）' : ''}</title></circle>`;
      labels += `<text x="${cx.toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="#6b7280">${E(p.label)}</text>`;
      if (p.value > 0) {
        labels += `<text x="${cx.toFixed(1)}" y="${(cy - 10).toFixed(1)}" text-anchor="middle" font-size="10" fill="#1f2937" font-weight="600">${E(Store.money(p.value))}</text>`;
      }
    });

    return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="xMinYMin meet" role="img">
      <defs><linearGradient id="lg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#2563eb" stop-opacity=".22"/>
        <stop offset="100%" stop-color="#2563eb" stop-opacity="0"/>
      </linearGradient></defs>
      ${grid}
      <path d="${dArea}" fill="url(#lg)"/>
      <path d="${dLine}" fill="none" stroke="#2563eb" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
      ${dots}${labels}
    </svg>`;
  }

  function niceCeil(v) {
    if (v <= 0) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(v)));
    const norm = v / mag;
    const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
    return step * mag;
  }

  /* 迷你柱状：阶段金额对比 */
  function miniBars(items) {
    const W = 640, H = 90;
    const max = Math.max(1, ...items.map(i => i.value));
    const n = items.length;
    const gap = 10, bw = (W - gap * (n + 1)) / n;
    let out = '';
    items.forEach((it, i) => {
      const h = Math.max(2, (H - 34) * (it.value / max));
      const x = gap + i * (bw + gap);
      const yy = H - 22 - h;
      out += `<rect x="${x.toFixed(1)}" y="${yy.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="6" fill="${it.color}">
        <title>${E(it.name)}：${E(Store.money(it.value))}</title></rect>
        <text x="${(x + bw / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="#6b7280">${E(it.name)}</text>
        <text x="${(x + bw / 2).toFixed(1)}" y="${(yy - 5).toFixed(1)}" text-anchor="middle" font-size="10" fill="#1f2937" font-weight="600">${E(Store.money(it.value))}</text>`;
    });
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="xMinYMin meet" role="img">${out}</svg>`;
  }

  return { ring, hbar, line, miniBars };
})();
