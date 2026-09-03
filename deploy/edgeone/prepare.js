/* ============================================================
 * 部署前准备：由 js/core/sync-core.js 生成 ESM 版本给 EdgeOne 云函数用
 *
 * 为什么要生成，而不是直接 import 上四级目录的文件：
 * EdgeOne 构建时只保证把 cloud-functions 目录内的模块带进产物，
 * 跨出去的相对路径能不能带上全看运气。与其赌，不如放进来。
 *
 * 为什么要生成，而不是就地维护两份：
 * 合并算法写两份，改了一处忘了另一处，两台设备同步出来的结果就会不一样，
 * 而这种不一致极难排查。所以源头只保留一份，另一份由脚本生成。
 *
 * 用法：
 *   node prepare.js          生成 / 更新
 *   node prepare.js --check  只校验是否最新，不写入（给 CI 用）
 * ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, '..', '..', 'js', 'core', 'sync-core.js');
const DST = path.join(here, 'cloud-functions', '_shared', 'sync-core.js');

if (!fs.existsSync(SRC)) {
  console.error('找不到源文件：' + SRC);
  process.exit(1);
}

const srcText = fs.readFileSync(SRC, 'utf8');
const BEGIN = '/* ===== SYNC-CORE-BEGIN ===== */';
const END = '/* ===== SYNC-CORE-END ===== */';
const i = srcText.indexOf(BEGIN);
const j = srcText.indexOf(END);
if (i < 0 || j < 0 || j <= i) {
  console.error('sync-core.js 里找不到 SYNC-CORE-BEGIN / END 标记，无法提取逻辑体');
  process.exit(1);
}
const logic = srcText.slice(i + BEGIN.length, j).trim();

const HEADER = `/* 本文件由 deploy/edgeone/prepare.js 从 ../../js/core/sync-core.js 自动生成。
 * 不要直接改这个文件 —— 改了会被下一次部署覆盖回去。
 * 要改就改 js/core/sync-core.js，然后重新运行 node prepare.js。
 *
 * 关于哈希：ESM 环境下拿不到同步的 node:crypto，所以这里走 sync-core 内置的
 * 回退算法。空间名（spaceKey）只是一个不可逆映射，只要在同一个后端内稳定
 * 就够了，不需要和本地 server.js 算出一样的值 —— 两者用的是两套存储，
 * 本来也要各自重新推一次数据。
 */
`;

/* 生成的文件里保留 BEGIN / END 两个标记：
 * 一是读代码的人一眼能看出这段是从哪来的；
 * 二是测试脚本靠这两个标记比对「主项目和副本是否一致」，
 * 标记被吃掉了就没法比了。 */
const body = BEGIN + '\n' + logic + '\n' + END;

/* 只导出 default：逻辑体里已经有同名的 const（KEYS、merge 等），
 * 再具名 export 一遍会和它们重名，模块直接编译不过。
 * 调用方统一 import CORE from './sync-core.js' 即可。 */
const OUT = [HEADER, body, '', 'export default api;', ''].join('\n');

fs.mkdirSync(path.dirname(DST), { recursive: true });
const has = fs.existsSync(DST) ? fs.readFileSync(DST, 'utf8') : '';

if (has === OUT) {
  console.log('✓ cloud-functions/_shared/sync-core.js 已是最新');
  process.exit(0);
}

if (process.argv.includes('--check')) {
  console.error('✗ ESM 版 sync-core.js 与主项目不一致，请先运行 node prepare.js');
  process.exit(1);
}

fs.writeFileSync(DST, OUT);
console.log('✓ 已生成 cloud-functions/_shared/sync-core.js（ESM，' + OUT.length + ' 字节）');
