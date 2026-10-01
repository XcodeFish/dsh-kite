/**
 * ★ 完全模拟浏览器行为：c 只在根路径上（建立路由表），资源请求靠 cookie。
 */
import { readFileSync } from 'node:fs';

const { loadConnectorKeys } = await import('../identity/keys.js');
const DATA = process.env.HOME + '/.dsh/plugin-data/dsh-kite/default';
const keys = await loadConnectorKeys(DATA);

// connectorId 从数据目录的连接器公钥动态推导（不硬编码本机凭据）
const { createHash } = await import('node:crypto');
const FP = createHash('sha256').update(Buffer.concat([keys.ed25519.publicRaw, keys.x25519.publicRaw])).digest('hex').slice(0, 32);
const dev = JSON.parse(readFileSync(DATA + '/devices.json', 'utf8')).devices[0];
const ticket = keys.signPayload({ deviceId: dev.deviceId, iat: Date.now(), exp: Date.now() + 3600_000 });
const cookie = 'ra-device=' + ticket;
const C = '${FP}';
const BASE = 'http://127.0.0.1:8787';

// ① 首次导航：带 c（浏览器地址栏）
let r = await fetch(`${BASE}/?c=${C}`, { headers: { cookie } });
const html = await r.text();
console.log(`① 导航 /?c=... → ${r.status} ${html.length}B`);
console.log(`   含 HARNNESS/DSH 界面: ${html.includes('HARNESS') || html.includes('__DSH_BOOT__')}`);

// ② 提取所有资源，按浏览器方式请求（不带 c）
const raw = [
  ...(html.match(/<script[^>]+src="([^"]+)"/g) || []).map((m) => m.match(/src="([^"]+)"/)[1]),
  ...(html.match(/<link[^>]+href="([^"]+)"/g) || []).map((m) => m.match(/href="([^"]+)"/)[1])
];
const urls = [...new Set(raw)].map((u) => {
  const clean = u.replace(/&amp;/g, '&').replace(/^\.\//, '');
  return clean.startsWith('/') ? clean : '/' + clean;
});
console.log(`\n② 资源加载（${urls.length} 个，按浏览器方式带 cookie 不带 c）`);
let bad = 0;
for (const p of urls) {
  const rr = await fetch(`${BASE}${p}`, { headers: { cookie } });
  if (rr.status !== 200) bad += 1;
  console.log(`   ${rr.status === 200 ? 'OK  ' : 'x' + rr.status} ${(rr.headers.get('content-type') || '').split(';')[0].padEnd(20)} ${p.slice(0, 62)}`);
}
console.log(bad === 0 ? '\n★ 全部资源 200 —— 前端可完整加载（这就是浏览器实际看到的）' : `\n${bad} 个失败`);
