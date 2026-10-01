/**
 * QR 可扫性验证（独立解码器 jsQR 逐位比对）。默认 `npm test` 不跑本文件
 * （文件名非 *.test.mjs）；显式运行：
 *   npm i --prefix /tmp/qr-verify jsqr && node test/qr-decode.verify.mjs
 * jsqr 不可用时打印安装指引并跳过（exit 0），不阻塞常规测试。
 */
import { createRequire } from 'node:module';
import { qrMatrix } from '../admin/qr.js';

let jsQR = null;
for (const base of ['/tmp/qr-verify/', process.cwd() + '/']) {
  try {
    jsQR = createRequire(base)('jsqr');
    break;
  } catch {
    /* 继续找 */
  }
}
if (!jsQR) {
  console.log('[SKIP] 未找到 jsqr 解码器。运行 `npm i --prefix /tmp/qr-verify jsqr` 后重试本脚本。');
  process.exit(0);
}

const cases = [
  'https://relay.example.com/kite/pair?token=AbCdEf123456&name=phone&c=0123456789abcdef0123456789abcdef',
  'https://r.example.com/pair?token=' + 'x'.repeat(60) + '&name=' + encodeURIComponent('我的手机'),
  'https://relay.example.com/',
  'http://127.0.0.1:8787/kite/pair?token=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef&name=%E6%88%91%E7%9A%84%E6%89%8B%E6%9C%BA&c=ffffffffffffffffffffffffffffffff',
  'H'
];
let failed = 0;
for (const text of cases) {
  const qr = qrMatrix(text);
  const quiet = 4;
  const dim = (qr.size + quiet * 2) * 8;
  const rgba = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let y = 0; y < qr.size; y += 1) {
    for (let x = 0; x < qr.size; x += 1) {
      if (!qr.get(x, y)) continue;
      for (let dy = 0; dy < 8; dy += 1) {
        for (let dx = 0; dx < 8; dx += 1) {
          const p = (((y + quiet) * 8 + dy) * dim + ((x + quiet) * 8 + dx)) * 4;
          rgba[p] = rgba[p + 1] = rgba[p + 2] = 0;
        }
      }
    }
  }
  const decoded = jsQR(rgba, dim, dim);
  const ok = decoded && decoded.data === text;
  if (!ok) failed += 1;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] v${qr.version} ${qr.size}x${qr.size} "${text.slice(0, 48)}${text.length > 48 ? '…' : ''}"`);
}
console.log(failed === 0 ? '\n全部可扫：jsQR 逐位解码一致' : `\n${failed} 个样本解码失败`);
process.exitCode = failed === 0 ? 0 : 1;
