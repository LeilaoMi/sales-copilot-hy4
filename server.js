/* ============================================================
 * 销冠助手 · 同步后端（零依赖 Node.js）
 *
 * 一个文件同时提供：静态站点 + /api/sync 同步接口。
 * 启动：node server.js          （默认 8080）
 *      PORT=3000 node server.js
 *      SYNC_TOKEN=你的令牌 node server.js
 *
 * 接口：
 *   GET  /api/sync  → { revision, data }      拉取云端快照
 *   PUT  /api/sync  → { revision, data }      推送本地快照（服务端做 LWW 合并后返回）
 *   GET  /api/health → { ok, revision, size }
 *
 * 存储：./data/sync-store.json（不可写时退化为内存，并打印警告）
 * ============================================================ */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
/* 合并算法、令牌校验这些「协议层」的东西放在 sync-core.js，
 * 和 EdgeOne 云函数适配器共用一份 —— 两边各自实现一份的话，
 * 改了一处忘了另一处，同步出来的数据就会对不上，而且极难排查。 */
const CORE = require('./sync-core');

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'sync-store.json');
const TOKEN_FILE = path.join(DATA_DIR, 'token.txt');
const KEYS = CORE.KEYS;
const BACKUP_KEEP = Number(process.env.BACKUP_KEEP || 10);   // 每个空间保留的历史版本份数
const MAX_SPACES = Number(process.env.MAX_SPACES || 200);    // 空间数上限：公开部署时防止被刷

/* ---------- 令牌与两种运行模式 ----------
 *
 *  模式一「专属模式」：启动时带 SYNC_TOKEN=xxx
 *      → 只认这一个令牌，其余一律 401。个人自用推荐，最省心也最安全。
 *
 *  模式二「多人模式」：不设 SYNC_TOKEN
 *      → 令牌即空间，任意 ≥8 位的令牌都可接入，各占一个数据文件互不干扰。
 *        一台服务器就能给整个团队用，每人自己起一个长一点的令牌即可。
 *        注意：令牌就是唯一的钥匙，请让每个人用足够长且不易猜的字符串。
 */
const FIXED_TOKEN = process.env.SYNC_TOKEN || '';
let SUGGESTED = '';
let writable = true;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { writable = false; }
try { SUGGESTED = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (e) {}
if (!SUGGESTED) {
  SUGGESTED = crypto.randomBytes(12).toString('hex');
  try { fs.writeFileSync(TOKEN_FILE, SUGGESTED); } catch (e) {}
}
const MODE = FIXED_TOKEN ? '专属模式（单令牌）' : '多人模式（令牌即空间）';
console.log('============================================');
console.log('  销冠助手同步服务已启动');
console.log('  端口:   ' + PORT);
console.log('  模式:   ' + MODE);
if (FIXED_TOKEN) console.log('  令牌:   ' + FIXED_TOKEN);
else console.log('  令牌:   自定义，≥8 位即可（建议用：' + SUGGESTED + '）');
console.log('  存储:   ' + (writable ? DATA_DIR + '（按令牌分文件）' : '内存（目录不可写，重启即丢）'));
console.log('  备份:   ' + (writable ? '每次覆盖前自动留档，保留最近 ' + BACKUP_KEEP + ' 份（BACKUP_KEEP 可调）' : '不可用'));
console.log('============================================');

/* ---------- 存储：按令牌隔离 ----------
 * 一台服务器可以给多个业务员各发一个令牌，数据文件彼此独立，互不干扰。
 * 令牌 → 文件名用 sha256 前 12 位，避免令牌本身落盘。
 */
const spaces = new Map();   // tokenHash -> { revision, data }
const hash = CORE.spaceKey;   // 令牌 → 12 位空间名，令牌本身不落盘

function spaceFile(h) { return path.join(DATA_DIR, 'store-' + h + '.json'); }

function getSpace(token) {
  const h = hash(token);
  if (spaces.has(h)) return spaces.get(h);
  let sp = { revision: 0, data: null };
  let existed = false;
  try {
    const raw = fs.readFileSync(spaceFile(h), 'utf8');
    const p = JSON.parse(raw);
    if (p && typeof p === 'object') { sp = p; existed = true; console.log('[' + h + '] 已加载历史数据，revision=' + sp.revision); }
  } catch (e) { /* 首次使用，正常 */ }
  // 新空间要占位，先查是否超额（公开部署时防止被无限刷空间）
  if (!existed && spaces.size >= MAX_SPACES) return null;
  spaces.set(h, sp);
  return sp;
}
/* ---------- 轮转备份 ----------
 * 为什么需要：同步策略是「最后写入者赢」，一次误删、一次错误导入会同步到所有设备，
 * 且没有任何撤销入口。所以每次覆盖前先留一份历史版本，出事了能手动捞回来。
 * 保留最近 KEEP 份，按时间倒序，超出自动删最旧的。
 */
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const MIN_GAP = Number(process.env.BACKUP_MIN_GAP || 60 * 1000);   // 近期快照最小间隔
const DAILY_KEEP = 7;                  // 每日快照保留天数
const lastBackupAt = new Map();

function rotateBackup(h) {
  if (!writable) return;
  const f = spaceFile(h);
  try {
    if (!fs.existsSync(f)) return;
    const now = Date.now();

    /* 每日快照：一天一份，保留 7 天。
     * 这一层很关键——误操作常常是好几天后才发现，光靠近期快照早就被冲掉了。 */
    const day = new Date(now).toISOString().slice(0, 10);
    const dailyName = `store-${h}-daily-${day}.json`;
    if (!fs.existsSync(path.join(BACKUP_DIR, dailyName))) {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      fs.copyFileSync(f, path.join(BACKUP_DIR, dailyName));
      const cutoff = new Date(now - DAILY_KEEP * 86400000).toISOString().slice(0, 10);
      fs.readdirSync(BACKUP_DIR)
        .filter(n => n.startsWith(`store-${h}-daily-`) && n.slice(-15, -5) < cutoff)
        .forEach(n => fs.unlinkSync(path.join(BACKUP_DIR, n)));
    }

    /* 近期快照：滚动保留最近 BACKUP_KEEP 份 */
    if (now - (lastBackupAt.get(h) || 0) < MIN_GAP) return;
    lastBackupAt.set(h, now);
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    // 保留毫秒：只截到秒的话，同一秒内的多次备份会同名互相覆盖，历史就丢了
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-').slice(0, 23);
    fs.copyFileSync(f, path.join(BACKUP_DIR, `store-${h}-${stamp}.json`));

    const files = fs.readdirSync(BACKUP_DIR)
      .filter(n => n.startsWith(`store-${h}-`) && !n.includes('-daily-'))
      .sort();                                  // 时间戳字典序 = 时间序
    while (files.length > BACKUP_KEEP) {
      fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
    }
  } catch (e) { console.error('备份失败:', e.message); }
}

function persist(h, sp) {
  if (!writable) return;
  try {
    rotateBackup(h);                            // 先留后路，再覆盖
    const f = spaceFile(h), tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(sp));
    fs.renameSync(tmp, f);   // 原子写，避免写一半断电损坏
  } catch (e) { console.error('写入失败:', e.message); }
}

/* ---------- 合并：逐条 LWW + 墓碑 ---------- */
const merge = CORE.merge;
const calcRevision = CORE.calcRevision;

/* ---------- HTTP ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8'
};

function send(res, code, obj, headers) {
  const body = typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj);
  res.writeHead(code, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,PUT,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization'
  }, headers || {}));
  res.end(body);
}

/* 取令牌，按顺序尝试三种携带方式：
 *   1. Authorization: Bearer xxx        标准方式，首选
 *   2. X-Sync-Token: xxx                备用头（有些反向代理会吃掉 Authorization）
 *   3. ?token=xxx                       查询参数，兼容性最好
 * 为什么需要后两种：实测部分云平台网关（如 CloudStudio Gateway）会剥离 Authorization 头，
 * 表现为本地联调一切正常、一上线就全部 401，且很难排查。
 */
function tokenOf(req) { return CORE.tokenOf(req); }
function authOk(req) { return CORE.authOk(req, FIXED_TOKEN); }

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const pathname = decodeURIComponent(u.pathname);

  if (req.method === 'OPTIONS') return send(res, 204, '');

  // 健康检查：不带令牌，只返回服务状态，不暴露任何数据。
  // 带 authSeen/authVia 是为了排查「本地好使、上线就 401」——
  // 有些网关会剥离 Authorization 头，这里能一眼看出来。
  if (pathname === '/api/health') {
    const tk = tokenOf(req);
    return send(res, 200, {
      ok: true,
      mode: MODE,
      storage: writable ? 'file' : 'memory',
      spaces: spaces.size,
      authSeen: !!tk,
      authVia: tk ? (req.headers['x-sync-token'] ? 'header'
        : (req.headers.authorization ? 'authorization'
          : (new URL(req.url, 'http://x').searchParams.get('token') ? 'query' : '?')))
        : 'none',
      accepts: ['Authorization: Bearer', 'X-Sync-Token', '?token='],
      time: new Date().toISOString()
    });
  }

  // 历史版本列表（需令牌）：误同步后可找回上一个版本
  if (pathname === '/api/backups') {
    if (!authOk(req)) return send(res, 401, { error: '令牌无效' });
    if (req.method !== 'GET') return send(res, 405, { error: '不支持的方法' });
    const h = hash(tokenOf(req));
    let files = [];
    try {
      files = fs.readdirSync(BACKUP_DIR)
        .filter(n => n.startsWith('store-' + h + '-'))
        .sort().reverse()
        .map(n => {
          const s = fs.statSync(path.join(BACKUP_DIR, n));
          return { name: n, time: s.mtime.toISOString(), size: s.size };
        });
    } catch (e) { /* 还没有备份 */ }
    return send(res, 200, {
      keep: BACKUP_KEEP, backups: files,
      tip: '恢复办法：把想要的历史文件复制回 data/ 目录并改名为 store-' + h + '.json，然后重启服务'
    });
  }

  // 同步接口
  if (pathname === '/api/sync') {
    if (!authOk(req)) return send(res, 401, { error: '令牌无效' });
    const tk = tokenOf(req);
    const h = hash(tk);
    const store = getSpace(tk);
    if (!store) return send(res, 503, { error: '服务端空间数已达上限，请联系管理员或自行部署' });

    if (req.method === 'GET') {
      if (!store.data) return send(res, 404, { error: '云端暂无数据，等待第一次推送' });
      return send(res, 200, { revision: store.revision, data: store.data });
    }
    if (req.method === 'PUT') {
      let body = '';
      req.on('data', c => {
        body += c;
        if (body.length > 8 * 1024 * 1024) { req.destroy(); }   // 8MB 上限
      });
      req.on('end', () => {
        let incoming;
        try { incoming = JSON.parse(body).data; }
        catch (e) { return send(res, 400, { error: 'JSON 解析失败' }); }
        if (!incoming || typeof incoming !== 'object') return send(res, 400, { error: '缺少 data' });
        const merged = merge(store.data || {}, incoming);
        store.data = merged;
        store.revision = calcRevision(merged);
        persist(h, store);
        console.log('[' + h + '] 收到推送，revision=' + store.revision +
          ' 客户=' + (merged.customers || []).filter(x => !x.deleted).length +
          ' 商机=' + (merged.deals || []).filter(x => !x.deleted).length +
          ' 跟进=' + (merged.followups || []).filter(x => !x.deleted).length);
        send(res, 200, { revision: store.revision, data: merged });
      });
      return;
    }
    return send(res, 405, { error: '不支持的方法' });
  }

  // 静态文件
  let file = path.join(ROOT, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(ROOT)) return send(res, 403, { error: '禁止访问' });
  fs.stat(file, (err, st) => {
    if (err || st.isDirectory()) {
      file = path.join(ROOT, 'index.html');
    }
    fs.readFile(file, (e2, buf) => {
      if (e2) return send(res, 404, { error: '文件不存在' });
      send(res, 200, buf, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    });
  });
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error('\n启动失败：端口 ' + PORT + ' 已被占用。');
    console.error('  换个端口：PORT=3000 node server.js');
    console.error('  或查是谁占用：ss -ltnp | grep ' + PORT);
    process.exit(1);
  }
  console.error('服务异常：', e.message);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('监听 http://0.0.0.0:' + PORT);
});
