/**
 * 对**运行中的宿主**验证新版三轨认证：把即将被宿主加载的新代码作为独立服务起一份，
 * 用真实请求打三种场景，确认修复有效后再请你重启。
 */
import http from 'node:http';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAdminHandler, KillSwitch } from '../admin/panel.js';
import { loadConnectorKeys } from '../identity/keys.js';


const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ra-live-'));
const keys = await loadConnectorKeys(dir);

// connectorId 从数据目录的连接器公钥动态推导（不硬编码本机凭据）
const { createHash } = await import('node:crypto');
const FP = createHash('sha256').update(Buffer.concat([keys.ed25519.publicRaw, keys.x25519.publicRaw])).digest('hex').slice(0, 32);
let hostSession = true; // 模拟 webview 页内 fetch（宿主 cookie 有效）

function makeHandler(rejection) {
  const deps = {
    adapter: { requestRejection: rejection, launchToken: () => undefined, webServerPort: () => 0 },
    keys, killSwitch: new KillSwitch(dir),
    devices: { list: () => [], revoke: async () => true, revokeAll: async () => 0 },
    pairing: { list: () => [{ tokenMasked: 'tok…1234', name: '我的手机', expiresAt: Date.now() + 60000, used: true, code: '123456' }], begin: () => ({ token: 't', expiresAt: Date.now() + 1000 }), abortAll: () => 0 },
    audit: { tail: () => [], append: () => {}, recent: async () => [] },
    fingerprint: '${FP}',
    relayStatus: () => ({ state: 'open', relayUrl: 'ws://127.0.0.1:8787', metrics: { lastError: null } }),
    kickDevice: () => {}, relayPublicUrl: () => 'https://x.trycloudflare.com', relayOwned: true,
    probe: async () => ({ overall: 'ok', checks: [] })
  };
  return createAdminHandler(deps);
}
const handler = makeHandler(() => (hostSession ? undefined : 401));
const server = http.createServer((req, res) => handler(req, res));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const last8 = (s) => (s ? s.slice(-8) : '(none)');
const results = [];
const check = (n, ok, extra) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? ' → ' + extra : ''}`); };

// 场景 1：过期令牌 + 宿主轨可用 → 应 200（这是你遇到的场景）
const now = Date.now();
const stale = keys.signPayload({ kind: 'kite-bootstrap', iat: now - 700000, exp: now - 1000 });
let r = await fetch(`${base}/kite?kite_token=${encodeURIComponent(stale)}`);
let body = await r.text();
check('★过期令牌 + 宿主轨可用 → 200（不阻断）', r.status === 200, `status=${r.status}`);
check('  下发长效 kite-admin cookie', /kite-admin=v1\./.test(r.headers.get('set-cookie') || ''), `cookie=${last8(r.headers.get('set-cookie'))}`);
check('  返回真实面板 HTML', body.includes('DSH Kite'), `${body.length} bytes`);

// 场景 2：新鲜令牌 → 303 剥离 + cookie
const fresh = keys.signPayload({ kind: 'kite-bootstrap', iat: now, exp: now + 600000 });
r = await fetch(`${base}/kite?kite_token=${encodeURIComponent(fresh)}`, { redirect: 'manual' });
check('新鲜令牌 → 303 剥离令牌', r.status === 303, `location=${r.headers.get('location')}`);
check('  下发 kite-admin cookie', /kite-admin=v1\./.test(r.headers.get('set-cookie') || ''));

// 场景 3：/api/entry 实时签发（客户端自救路径）
r = await fetch(`${base}/kite/api/entry`);
const entry = await r.json();
const payload = keys.verifyPayload(decodeURIComponent(new URL(entry.url, 'http://x').searchParams.get('kite_token')));
check('/api/entry 实时签发新鲜令牌', r.status === 200 && payload.kind === 'kite-bootstrap' && payload.exp > Date.now() + 500000,
  `剩余 ${Math.round((payload.exp - Date.now()) / 60000)} 分钟`);

// 场景 4：过期令牌 + 宿主轨也不可用 → 应给出可读原因（不是裸 403）
hostSession = false;
r = await fetch(`${base}/kite?kite_token=${encodeURIComponent(stale)}`);
body = await r.text();
check('★两者都不可用 → 可读原因 + 三轨诊断', r.status === 401 && /认证失败/.test(body) && /宿主轨 rejection/.test(body), `status=${r.status}`);

const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} 项通过`);
server.close();
process.exitCode = failed ? 1 : 0;
