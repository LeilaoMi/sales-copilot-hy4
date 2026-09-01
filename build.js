/*
 * 两种产物，二选一：
 *
 *   node build.js          单文件 HTML（双击可开、可微信发给同事）
 *   node build.js --pages  生成 public/ 目录，用于 Cloudflare Pages / 静态托管
 *
 * 为什么不直接把整个项目目录丢给托管平台：
 *   项目根里躺着 data/ —— 那是真实的客户姓名、电话、微信。
 *   静态托管上传的每一个文件都是**公开可下载**的，
 *   整目录一传，等于把客户名单挂在公网上任人扒。
 *   所以 Pages 只认 public/ 这一个目录，里面只有站点本身的文件。
 *
 * 而这个目录**不能靠手动 cp 生成**：人会忘，而且忘了不报错，
 * 结果是部署上去一个空站，或者更糟——一份几周前的旧版本。
 * 所以做成一条命令。
 */
const fs = require('fs');
const path = require('path');

const dir = __dirname;

/* 从 index.html 读出它到底引用了哪些文件，而不是在这里再抄一份名单。
 * 之前名单是硬编码的，加了 playbook.js / digest.js / report.js 之后忘了同步，
 * 打包出来的单文件版一直缺三个模块 —— 页面能开，但话术库和周报是坏的。
 * 让构建脚本自己去看 HTML 引用了什么，就永远不会漏。 */
const rawHtml = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const referenced = new Set();
Array.from(rawHtml.matchAll(/<script src="([^"]+)"><\/script>/g)).forEach(m => referenced.add(m[1]));
Array.from(rawHtml.matchAll(/<link[^>]+href="([^"]+)"/g)).forEach(m => {
  if (/^https?:/.test(m[1])) return;      // CDN 引用不打包
  referenced.add(m[1]);
});
/* manifest 里写的图标也要带上，否则「添加到主屏幕」没有图标 */
try {
  const mf = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  (mf.icons || []).forEach(i => { if (i.src) referenced.add(i.src.replace(/^\.?\//, '')); });
} catch (e) {}

if (!referenced.size) throw new Error('index.html 里没解析出任何本地资源引用');

/* ---------- --pages 模式：生成部署目录 ---------- */
if (process.argv.includes('--pages')) {
  const outDir = path.join(dir, 'public');

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  let n = 0;
  /* index.html 自己是入口，不在引用表里，单独带上 */
  fs.copyFileSync(path.join(dir, 'index.html'), path.join(outDir, 'index.html'));
  n++;
  referenced.forEach(f => {
    /* 内联的 data: URI（比如内嵌 SVG 图标）不是文件，跳过 */
    if (/^data:/i.test(f)) return;
    const src = path.join(dir, f);
    if (!fs.existsSync(src)) { console.warn('  跳过（文件不存在）：' + f); return; }
    const dst = path.join(outDir, f);
    if (dst === path.join(outDir, 'index.html')) return;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    n++;
  });
  fs.copyFileSync(path.join(dir, 'manifest.json'), path.join(outDir, 'manifest.json'));

  /* 缓存规则的源文件放在 deploy/ 而不是 public/ ——
   * public/ 每次构建都要清空，手写的东西放那儿迟早被删掉，
   * 而且删了不报错，只会表现为「改了没生效」。
   * 这里从源文件复制过去，缺了就直接报错拦下，不让部署出一个
   * 「缓存规则静默失效」的站点。 */
  const headersSrc = path.join(dir, 'deploy', '_headers');
  if (!fs.existsSync(headersSrc)) {
    console.error('\n✗ 缺少 deploy/_headers（缓存规则源文件）');
    console.error('  没有它，sw.js 会被长期缓存，用户刷新拿不到新代码。');
    process.exit(1);
  }
  fs.copyFileSync(headersSrc, path.join(outDir, '_headers'));
  console.log('  ✓ 已带上 _headers（sw.js 与入口页不缓存）');

  /* 自动把 sw.js 的预缓存清单补齐全。
   *
   * 这个坑踩过两次：加了新模块，忘了往 sw.js 的 FILES 里加，
   * 离线一打开就是残缺页面。第一版漏 6 个，第二版漏 4 个
   * （auth / notify / team / sparring）。
   * 注释里那句「新增脚本文件时记得同步这里」被证明靠不住 ——
   * 人会忘，而且忘了不报错，只在离线时才现形，最难查。
   *
   * 所以改成构建时按 index.html 的实际引用重写一遍。
   * 根目录那份 sw.js 是开发时用的，仍然手写；
   * 但**部署出去的这份一定是全的** —— 那才是会到用户机器上的那份。 */
  const swSrc = path.join(dir, 'sw.js');
  if (fs.existsSync(swSrc)) {
    let sw = fs.readFileSync(swSrc, 'utf8');
    const statics = ['./', './index.html', './styles.css',
                     './manifest.json', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];
    const jsFiles = Array.from(referenced)
      .filter(f => /\.js$/.test(f) && !/^data:/i.test(f))
      .map(f => './' + f);
    const list = statics.concat(jsFiles).map(f => "  '" + f + "'").join(',\n');
    const before = sw;
    sw = sw.replace(/const FILES = \[[\s\S]*?\];/, 'const FILES = [\n' + list + '\n];');
    if (sw === before) {
      console.error('\n✗ 没能改写到 sw.js 的 FILES 清单（正则没匹配上）');
      console.error('  sw.js 结构变了吧，构建脚本要跟着改。');
      process.exit(1);
    }
    fs.writeFileSync(path.join(outDir, 'sw.js'), sw, 'utf8');
    console.log('  ✓ sw.js 预缓存清单已按 index.html 重写（' + jsFiles.length + ' 个脚本）');
  }

  /* 目录里必须闹明白有没有 data/ —— 有就是事故，直接报错拦下来 */
  const leaked = [];
  (function walk(d, rel) {
    fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) { if (e.name === 'data') leaked.push(r); else walk(path.join(d, e.name), r); }
      else if (/\.json$/i.test(e.name) && e.name !== 'manifest.json') leaked.push(r);
    });
  })(outDir, '');

  console.log(`已生成 ${outDir}：${n + 1} 个文件`);
  console.log('  包含：' + [...referenced].join(', ') + ', manifest.json');
  if (leaked.length) {
    console.error('\n✗ 部署目录里出现了不该有的数据文件：' + leaked.join(', '));
    console.error('  这些文件在静态托管上是公开可下载的，必须处理掉再部署。');
    process.exit(1);
  }
  console.log('  ✓ 未发现 data/ 或业务 JSON 泄漏');
  console.log('\n下一步：npx wrangler pages deploy public\n（或在 Cloudflare 后台把输出目录填成 public）');
  process.exit(0);
}

/* ---------- 默认：单文件 HTML ---------- */
const out = path.join(dir, '..', '销冠助手-单文件版.html');

let html = rawHtml;
const css = fs.readFileSync(path.join(dir, 'styles.css'), 'utf8');

html = html.replace(/<link rel="stylesheet" href="styles\.css">/, () => `<style>\n${css}\n</style>`);

const files = Array.from(html.matchAll(/<script src="([^"]+)"><\/script>/g)).map(m => m[1]);
if (!files.length) throw new Error('index.html 里没有找到任何 <script src> 引用');

files.forEach(f => {
  const code = fs.readFileSync(path.join(dir, f), 'utf8');
  const re = new RegExp(`<script src="${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"></script>`);
  if (!re.test(html)) throw new Error('未找到脚本引用：' + f);
  html = html.replace(re, () => `<script>\n${code}\n</script>`);
});
console.log('已内联 ' + files.length + ' 个脚本：' + files.join(', '));

// 单文件版没有外部资源，移除 manifest / icon 引用和 SW 注册，避免 404
html = html.replace(/<link rel="manifest"[^>]*>\n?/, '');
html = html.replace(/<link rel="apple-touch-icon"[^>]*>\n?/, '');
html = html.replace("navigator.serviceWorker.register('sw.js').catch", "// navigator.serviceWorker.register('sw.js').catch");

html = html.replace('<title>', '<!-- 单文件版：由 build.js 自动生成，可直接双击打开 -->\n<title>');
fs.writeFileSync(out, html, 'utf8');
console.log('已生成：' + out + '  (' + (Buffer.byteLength(html) / 1024).toFixed(1) + ' KB)');
