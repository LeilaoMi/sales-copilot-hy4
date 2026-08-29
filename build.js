/*
 * 打包成单文件 HTML：把 styles.css 与所有 js 内联进 index.html。
 * 用法：node build.js  → 生成 ../销冠助手-单文件版.html
 * 目的：双击即可运行，也可直接微信/邮件发给同事，无需服务器。
 */
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const out = path.join(dir, '..', '销冠助手-单文件版.html');

let html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(dir, 'styles.css'), 'utf8');

html = html.replace(/<link rel="stylesheet" href="styles\.css">/, () => `<style>\n${css}\n</style>`);

/* 直接从 index.html 里读出脚本清单，不在这里再抄一份名单。
 * 之前名单是硬编码的，加了 playbook.js / digest.js / report.js 之后忘了同步，
 * 打包出来的单文件版一直缺三个模块 —— 页面能开，但话术库和周报是坏的。
 * 让构建脚本自己去看 HTML 引用了什么，就永远不会漏。 */
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
