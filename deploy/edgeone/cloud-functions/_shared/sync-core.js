/* 本文件由 deploy/edgeone/prepare.js 从 ../../sync-core.js 自动生成。
 * 不要直接改这个文件 —— 改了会被下一次部署覆盖回去。
 * 要改就改主项目的 sync-core.js，然后重新运行 node prepare.js。
 *
 * 关于哈希：ESM 环境下拿不到同步的 node:crypto，所以这里走 sync-core 内置的
 * 回退算法。空间名（spaceKey）只是一个不可逆映射，只要在同一个后端内稳定
 * 就够了，不需要和本地 server.js 算出一样的值 —— 两者用的是两套存储，
 * 本来也要各自重新推一次数据。
 */

/* ===== SYNC-CORE-BEGIN ===== */
'use strict';

  /* 参与同步的集合。settings / deviceId 单独处理（见 merge 末尾） */
  const KEYS = ['customers', 'deals', 'followups', 'scripts'];

  /* ---------- 令牌 ---------- */
  function sha256(s) {
    /* 浏览器里没有 node:crypto。这里只用做一个不可逆的空间名映射，
     * 不是密码学用途（令牌本身就是钥匙），所以用一个自实现的 FNV 变体兜底。
     * Node 环境下优先用真 sha256，和 server.js 的历史数据文件名保持一致。 */
    try {
      const c = require('crypto');
      return c.createHash('sha256').update(String(s)).digest('hex');
    } catch (e) {
      let h1 = 0x811c9dc5, h2 = 0x01000193;
      const str = String(s);
      for (let i = 0; i < str.length; i++) {
        h1 ^= str.charCodeAt(i); h1 = (h1 * 0x01000193) >>> 0;
        h2 = (h2 ^ str.charCodeAt(i)) * 0x85ebca6b >>> 0;
      }
      return ('0000000' + h1.toString(16)).slice(-8) + ('0000000' + h2.toString(16)).slice(-8)
        + ('0000000' + str.length.toString(16)).slice(-8);
    }
  }

  /* 令牌 → 空间名。只取前 12 位：够随机，且令牌本身不落盘。 */
  function spaceKey(token) { return sha256(String(token || '')).slice(0, 12); }

  /* 从 HTTP 请求里取令牌。三种写法都认，前端怎么方便怎么来。 */
  function tokenOf(req) {
    if (!req) return '';
    const h = req.headers || {};
    const direct = h['x-sync-token'] || (h.get ? h.get('x-sync-token') : '');
    if (direct && String(direct).trim()) return String(direct).trim();
    const a = h.authorization || (h.get ? h.get('authorization') : '');
    if (a) {
      const t = String(a).replace(/^Bearer\s+/i, '').trim();
      if (t) return t;
    }
    const u = req.url || '';
    const m = String(u).match(/[?&]token=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  /* 校验。两种模式：
   *  专属模式（配了 SYNC_TOKEN）→ 只认这一个；
   *  多人模式（没配）→ 令牌即空间，够长就行，各占一个空间互不干扰。 */
  function authOk(req, fixedToken) {
    const t = tokenOf(req);
    if (!t) return false;
    if (fixedToken) return t === fixedToken;
    return t.length >= 8;
  }

  /* ============================================================
   * 合并：同一条记录按 updatedAt 取新的（LWW）
   *
   * 这是整个同步的地基。三条约定：
   *   1. 以 id 为主键，不看顺序；
   *   2. 同 id 比 updatedAt，谁新留谁（相等时偏向传入的 b，保证推送方能覆盖自己）；
   *   3. 删除是软删除（deleted 标记），所以墓碑也要参与同步 ——
   *      否则 A 设备删了、B 设备还留着，一同步又活过来了。
   * ============================================================ */
  function merge(a, b) {
    const out = {};
    KEYS.forEach(k => {
      const map = new Map();
      (a && a[k] ? a[k] : []).forEach(r => { if (r && r.id) map.set(r.id, r); });
      (b && b[k] ? b[k] : []).forEach(r => {
        if (!r || !r.id) return;
        const prev = map.get(r.id);
        if (!prev || (Number(r.updatedAt) || 0) >= (Number(prev.updatedAt) || 0)) map.set(r.id, r);
      });
      out[k] = Array.from(map.values());
    });

    const ra = (a && a.savedAt) || 0, rb = (b && b.savedAt) || 0;
    out.savedAt = Math.max(ra, rb);
    out.v = 1;
    /* settings / deviceId 不是列表，没法按 id 合并，取新的那份 */
    if (b && b.settings) out.settings = b.settings;
    else if (a && a.settings) out.settings = a.settings;
    if (b && b.deviceId) out.deviceId = b.deviceId;
    else if (a && a.deviceId) out.deviceId = a.deviceId;
    return out;
  }

  /* 版本号：取所有记录里最大的 updatedAt。
   * 前端拿它做「云端有没有比我新」的快速判断，不用每次都全量比对。 */
  function calcRevision(data) {
    let max = 0;
    KEYS.forEach(k => (data && data[k] ? data[k] : []).forEach(r => {
      if (Number(r.updatedAt) > max) max = Number(r.updatedAt);
    }));
    return max;
  }

  /* 清点一下数据里有多少条（写日志和排查问题用） */
  function countOf(data) {
    const c = {};
    KEYS.forEach(k => { c[k] = ((data && data[k]) || []).filter(x => x && !x.deleted).length; });
    return c;
  }

  const api = { KEYS: KEYS, spaceKey: spaceKey, tokenOf: tokenOf, authOk: authOk,
    merge: merge, calcRevision: calcRevision, countOf: countOf };
/* ===== SYNC-CORE-END ===== */

export default api;
