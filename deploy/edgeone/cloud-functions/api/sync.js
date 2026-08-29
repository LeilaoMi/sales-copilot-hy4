/* ============================================================
 * 销冠助手 · EdgeOne 同步后端（Node Functions + Blob）
 *
 * 路径：cloud-functions/api/sync.js  →  线上路由 /api/sync
 * 协议与本地 server.js 完全一致，前端只需要把「同步地址」换成
 * 你的 EdgeOne 域名，其它一个字都不用改。
 *
 * ── 为什么用 Blob 而不是 KV ──────────────────────────────
 * KV 是最终一致的（最长 60 秒陈旧读）且没有 CAS（比较并交换）。
 * 同步这件事恰恰是「读 → 合并 → 写」，用 KV 会出现：
 *   手机读到旧数据 → 合并 → 写回 → 把电脑刚推的记录覆盖掉。
 * 丢的是客户资料和跟进记录，不可接受。
 * Blob 支持 consistency:"strong" 强一致读，写入即写即见。
 *
 * ── 为什么「每台设备写自己的 key」 ────────────────────────
 * 就算有了强一致读，读-改-写依然有竞态窗口：
 *   手机和电脑同时读到 v1，各自合并后写回，后写的那个会覆盖前一个。
 * 所以这里不共用一把钥匙 —— 每台设备只写自己那一份：
 *     sync/<空间>/<设备ID>.json
 * 读取时把该空间下所有设备的文件全部 merge 起来再返回。
 *
 * 这样谁也覆盖不了谁。而且 merge 的规则是「同一条记录按 updatedAt
 * 取新的」，它满足交换律和结合律，所以哪怕某一次读到了别人稍微陈旧
 * 的副本，多同步几次之后所有设备依然会收敛到同一份结果。
 *
 * 代价是空间随设备数线性增长（每台一份全量）。个人通常 1~3 台设备，
 * 免费额度 1GB，几千条客户/跟进记录不过几百 KB，完全够用。
 * ============================================================ */

import { getStore } from '@edgeone/pages-blob';
import CORE from '../_shared/sync-core.js';

/* 这些值也可以在 EdgeOne 控制台的「环境变量」里配，改完不用重新部署代码 */
const STORE_NAME = process.env.BLOB_STORE || 'sales-copilot';
const FIXED_TOKEN = process.env.SYNC_TOKEN || '';   // 留空 = 多人模式（令牌即空间）
const MAX_DEVICES = Number(process.env.MAX_DEVICES || 20);
const MAX_BODY = 8 * 1024 * 1024;                   // 8MB，和 server.js 一致

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Sync-Token,Authorization,X-Device-Id',
  'Access-Control-Max-Age': '86400'
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS)
  });
}

/* ---------- 存储 ---------- */
function store() {
  /* 整个 store 默认强一致。同步宁可慢几十毫秒，也不能读到旧数据 */
  return getStore({ name: STORE_NAME, consistency: 'strong' });
}

const PREFIX = 'sync/';
const spacePrefix = space => PREFIX + space + '/';
const deviceKey = (space, deviceId) => spacePrefix(space) + deviceId + '.json';

/* 把设备 ID 洗成能安全用作文件名的字符。
 * 设备 ID 是客户端给的，不能信 —— 里面要是带了 ../ 就会写到别人的空间去 */
function safeDeviceId(raw) {
  const s = String(raw || '').replace(/[^a-zA-Z0-9_-]/g, '');
  return s.slice(0, 40) || 'default';
}

/* ---------- 读取某个空间里的全部数据 ---------- */
async function readSpace(space) {
  const st = store();
  const prefix = spacePrefix(space);
  const { blobs } = await st.list({ prefix, consistency: 'strong' });

  /* 设备太多通常是出 bug 了（比如客户端每次都生成新 ID），
   * 与其默默写爆存储空间，不如直接报错让人来查 */
  if (blobs.length > MAX_DEVICES) {
    const err = new Error('该空间的设备数已达上限 ' + MAX_DEVICES + '，请检查是否有设备重复上报 ID');
    err.status = 413;
    throw err;
  }

  let merged = null;
  let devices = 0;
  for (const b of blobs) {
    const snap = await st.get(b.key, { type: 'json', consistency: 'strong' });
    if (!snap || !snap.data) continue;
    devices++;
    merged = merged ? CORE.merge(merged, snap.data) : snap.data;
  }
  return { data: merged, devices: devices };
}

/* ============================================================
 * 处理
 * ============================================================ */
export async function onRequest(context) {
  const req = context.request;
  const method = (req.method || 'GET').toUpperCase();

  /* 注意第一个参数必须是 null 而不是 ''：
   * 204 响应按规范不允许带 body，传空字符串会被标准 Response 当成「有 body」
   * 直接抛 Invalid response status code，预检请求全部 500，
   * 浏览器的跨域同步就彻底连不上了。这个坑只能靠真跑一次请求才看得见。 */
  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (method !== 'GET' && method !== 'PUT') return json({ error: '不支持的方法' }, 405);

  /* 鉴权：规则和 server.js 一字不差 */
  if (!CORE.authOk({ headers: req.headers, url: req.url }, FIXED_TOKEN)) {
    return json({ error: '令牌无效' }, 401);
  }

  const token = CORE.tokenOf({ headers: req.headers, url: req.url });
  const space = CORE.spaceKey(token);

  try {
    if (method === 'GET') {
      const { data, devices } = await readSpace(space);
      if (!data) return json({ error: '云端暂无数据，等待第一次推送' }, 404);
      return json({ revision: CORE.calcRevision(data), data: data, devices: devices });
    }

    /* ---------- PUT ---------- */
    let body;
    try {
      body = await req.json();
    } catch (e) {
      return json({ error: 'JSON 解析失败' }, 400);
    }
    const incoming = body && body.data;
    if (!incoming || typeof incoming !== 'object') return json({ error: '缺少 data' }, 400);

    const raw = JSON.stringify(incoming);
    if (raw.length > MAX_BODY) return json({ error: '数据过大（上限 8MB）' }, 413);

    /* 设备 ID 优先取请求头，其次取数据里的，都没有就落到 default。
     * 落到 default 意味着多台设备会共用一把钥匙，会互相覆盖 ——
     * 所以这里宁可少一种容错，也不静默退化：没有 ID 时明确记一条日志 */
    const devFromHeader = req.headers.get ? req.headers.get('x-device-id') : '';
    const deviceId = safeDeviceId(devFromHeader || incoming.deviceId || '');

    const st = store();
    const key = deviceKey(space, deviceId);

    /* 只覆盖自己上一次的快照，绝不碰别人的文件。
     * 自己的旧快照还是要先读出来 merge 一遍：万一这次推送漏了什么
     * （比如换浏览器、清过缓存），不能把历史数据冲掉 */
    const prev = await st.get(key, { type: 'json', consistency: 'strong' });
    const toWrite = prev && prev.data ? CORE.merge(prev.data, incoming) : incoming;

    await st.setJSON(key, {
      data: toWrite,
      deviceId: deviceId,
      updatedAt: Date.now(),
      app: 'sales-copilot'
    });

    /* 写完立刻把全部设备的合并结果算出来返回，
     * 客户端一步到位拿到最新，不用再发一次 GET */
    const { data, devices } = await readSpace(space);
    console.log('[sync] space=' + space + ' device=' + deviceId +
      ' devices=' + devices + ' revision=' + CORE.calcRevision(data || {}) +
      ' ' + JSON.stringify(CORE.countOf(data || {})));

    return json({ revision: CORE.calcRevision(data || {}), data: data || toWrite, devices: devices });
  } catch (e) {
    console.error('[sync] 失败：', e && e.message);
    return json({ error: e && e.message ? e.message : '服务端异常' }, (e && e.status) || 500);
  }
}
