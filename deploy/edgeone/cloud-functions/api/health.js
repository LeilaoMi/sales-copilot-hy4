/* 探活接口：GET /api/health
 *
 * 部署完先访问这个地址确认后端活着，再去 App 里填同步地址。
 * 否则一旦连不上，你分不清是地址填错、令牌不对，还是函数没起来。 */

import { getStore } from '@edgeone/pages-blob';
import CORE from '../_shared/sync-core.js';

const STORE_NAME = process.env.BLOB_STORE || 'sales-copilot';
const FIXED_TOKEN = process.env.SYNC_TOKEN || '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Sync-Token,Authorization,X-Device-Id'
};

export async function onRequest(context) {
  const req = context.request;
  if ((req.method || 'GET').toUpperCase() === 'OPTIONS') {
    /* 204 不能带 body，第一个参数必须是 null，见 sync.js 里的说明 */
    return new Response(null, { status: 204, headers: CORS });
  }

  const out = {
    ok: true,
    app: 'sales-copilot',
    mode: FIXED_TOKEN ? '专属模式（单令牌）' : '多人模式（令牌即空间）',
    store: STORE_NAME
  };

  try {
    const st = getStore({ name: STORE_NAME, consistency: 'strong' });
    const { stores } = await (await import('@edgeone/pages-blob')).listStores();
    out.stores = (stores || []).map(s => s.name);
    out.blobReady = (stores || []).some(s => s.name === STORE_NAME);
  } catch (e) {
    /* 探活接口永远返回 200 —— 它是给人类排障看的，
     * 把错误写进响应体里比返回 500 更直观 */
    out.ok = false;
    out.error = String(e && e.message || e);
  }

  /* 带正确令牌时顺带报一下这个空间有多少数据，方便确认「到底同步上没有」 */
  const token = CORE.tokenOf({ headers: req.headers, url: req.url });
  if (token && CORE.authOk({ headers: req.headers, url: req.url }, FIXED_TOKEN)) {
    try {
      const space = CORE.spaceKey(token);
      const st = getStore({ name: STORE_NAME, consistency: 'strong' });
      const { blobs } = await st.list({ prefix: 'sync/' + space + '/', consistency: 'strong' });
      out.space = space;
      out.devices = blobs.length;
    } catch (e) {
      out.spaceError = String(e && e.message || e);
    }
  } else {
    out.hint = '带上 X-Sync-Token 头可以看到你这个令牌下的数据条数';
  }

  return new Response(JSON.stringify(out, null, 2), {
    status: 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, CORS)
  });
}
