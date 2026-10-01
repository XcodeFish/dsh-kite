/**
 * 验证 gzip 是否生效：请求大资源，看 content-encoding 与传输大小。
 * 注意：需要 DSH 重启加载连接器新代码后才有压缩。
 */
import { readFileSync } from 'node:fs';

const { loadConnectorKeys } = await import('../identity/keys.js');
const D = process.env.HOME + '/.dsh/plugin-data/dsh-kite/default';
const keys = await loadConnectorKeys(D);

// connectorId 从数据目录的连接器公钥动态推导（不硬编码本机凭据）
const { createHash } = await import('node:crypto');
const FP = createHash('sha256').update(Buffer.concat([keys.ed25519.publicRaw, keys.x25519.publicRaw])).digest('hex').slice(0, 32);
const dev = JSON.parse(readFileSync(D + '/devices.json', 'utf8')).devices[0];
const ticket = keys.signPayload({ deviceId: dev.deviceId, iat: Date.now(), exp: Date.now() + 3600_000 });
const cookie = 'ra-device=' + ticket;
const html = await (await fetch('http://127.0.0.1:8787/?c=${FP}', { headers: { cookie } })).text();
const urls = [...new Set([...(html.match(/src="([^"]+)"/g) || []).map((m) => m.replace(/src="|"/g, '')), ...(html.match(/href="([^"]+)"/g) || []).map((m) => m.replace(/href="|"/g, ''))])]
  .map((u) => u.replace(/&amp;/g, '&'))
  .filter((u) => !u.startsWith('http'));
let totalRaw = 0, totalGz = 0, gzCount = 0;
console.log('资源压缩状态（Accept-Encoding: gzip）：');
for (const u of urls) {
  const p = u.startsWith('/') ? u : (u.startsWith('./') ? '/' + u.slice(2) : '/' + u);
  const r = await fetch('http://127.0.0.1:8787' + p, { headers: { cookie, 'accept-encoding': 'gzip' } });
  const b = (await r.arrayBuffer()).byteLength;
  const enc = r.headers.get('content-encoding') || '—';
  totalRaw += b;
  if (enc === 'gzip') { totalGz += b; gzCount += 1; }
  console.log(`  ${String(Math.round(b / 1024)).padStart(6)}KB  ${enc.padEnd(6)} ${p.slice(0, 46)}`);
}
console.log('');
console.log(`压缩生效的资源: ${gzCount}/${urls.length}`);
console.log(`总计传输: ${Math.round(totalRaw / 1024)}KB${totalGz ? `（其中 gzip ${Math.round(totalGz / 1024)}KB）` : ''}`);
if (gzCount === 0) console.log('\n★ 尚未压缩 —— 需重启 DSH 加载连接器新代码');
else console.log('\n★ gzip 已生效');
