/**
 * 中继设备路由条目诊断（2026-10-02 真机事故的现场判别器）。
 *
 * 用法：node test/route-diagnose.mjs
 *   RA_RELAY=wss://...   覆盖中继地址（默认按 index.js 的优先级解析：env > relay-override.json > cordis.patch.yml）
 *
 * 判别目标（真机症状：手机退后台/关闭浏览器后，重新打开刷新，界面一直显示「重新连接」）：
 *   ① 只带 ra-device cookie、不带 c 参数的请求（= 前端所有 /api/*、assets 的真实形状）
 *   ② 带 c=<connectorId> 的同一请求（= 手机地址栏那一跳）
 *   ③ 只带 cookie、不带 c 的 /api/remote.mux（= 前端实时通道的真实形状）
 *   ④–⑥ 主动制造「手机最后一条 socket 关闭」这一条件，看条目是否留存
 *        （未修复的中继：条目随 socket 关闭被删 → ①③ 立刻变成 401/4503，且刷新永远回不来）
 *
 * ⚠ 本脚本会在未修复的中继上**真的**把该设备的路由条目删掉（模拟手机关闭），
 *   之后该设备要等连接器重连/重新配对才能恢复。请在维护窗口或修复后的中继上跑。
 */
import { readFileSync } from 'node:fs';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import wsPkg from '../relay/node_modules/ws/index.js';
const { WebSocket } = wsPkg;

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DATA = `${process.env.DSH_HOME ?? `${process.env.HOME}/.dsh`}/plugin-data/dsh-kite/default`;

function resolveRelay() {
  if (process.env.RA_RELAY) return { url: process.env.RA_RELAY.trim().replace(/\/+$/, ''), source: 'env RA_RELAY' };
  try {
    const ov = JSON.parse(readFileSync(`${DATA}/relay-override.json`, 'utf8'));
    if (ov.relayUrl) return { url: String(ov.relayUrl).trim().replace(/\/+$/, ''), source: 'relay-override.json（面板覆盖）' };
  } catch { /* 继续往下找 */ }
  try {
    const yml = readFileSync(`${process.env.HOME}/.dsh/profiles/desktop/cordis.patch.yml`, 'utf8');
    const m = /^\s*relayUrl:\s*['"]?(wss?:\/\/[^'"\s]+)/m.exec(yml);
    if (m) return { url: m[1].replace(/\/+$/, ''), source: 'cordis.patch.yml' };
  } catch { /* 无 */ }
  return { url: null, source: '未找到（请设 RA_RELAY）' };
}

const RELAY = resolveRelay();
if (!RELAY.url) { console.log('无法确定中继地址 —— 设 RA_RELAY=wss://… 后重跑'); process.exit(1); }
const HTTPS = RELAY.url.replace(/^ws/, 'http');
const WSS = RELAY.url.replace(/^http/, 'ws');
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // 中继多为 IP 证书，Node 默认拒（与 ws-mux.verify 同法）

const { loadConnectorKeys } = await import(`${ROOT}/identity/keys.js`);
const keys = await loadConnectorKeys(DATA);
const dev = JSON.parse(readFileSync(`${DATA}/devices.json`, 'utf8')).devices[0];
if (!dev) { console.log('本机没有已配对设备，先扫码配对再跑'); process.exit(1); }
const now = Date.now();
const body = Buffer.from(JSON.stringify({ deviceId: dev.deviceId, iat: now, exp: now + 3600_000 })).toString('base64url');
const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const rawEd = Buffer.from(JSON.parse(readFileSync(`${DATA}/connector-ed25519.json`, 'utf8')).private, 'base64url');
const priv = createPrivateKey({ key: Buffer.concat([PKCS8, rawEd]), format: 'der', type: 'pkcs8' });
const COOKIE = `ra-device=v1.${body}.${sign(null, Buffer.from(body), priv).toString('base64url')}`;
const CID = keys.fingerprint;

console.log(`中继      : ${RELAY.url} （来源：${RELAY.source}）`);
console.log(`connectorId: ${CID}`);
console.log(`deviceId   : ${dev.deviceId}（票据由本机密钥现签，非手机 cookie）`);
const health = await (await fetch(`${HTTPS}/healthz`)).json().catch(() => null);
if (health) console.log(`中继状态  : connectors=${health.connectors} devices=${health.devices}（connectors>1 时单连接器兜底失效，条目缺失即死锁）`);

const get = async (path) => {
  const r = await fetch(`${HTTPS}${path}`, { headers: { cookie: COOKIE }, redirect: 'manual' });
  const text = await r.text();
  const who = /需要配对链接|连接器不在线/.test(text) ? '中继未路由页' : (/需要配对/.test(text) ? '连接器票据拒绝页' : 'DSH 应用页面');
  return `${r.status} ${text.length}B（${who}）`;
};
const mux = (path, { hold = false, onReady } = {}) => new Promise((resolve) => {
  const ws = new WebSocket(`${WSS}${path}`, { headers: { cookie: COOKIE } });
  let opened = false;
  const done = (v) => { try { ws.terminate(); } catch { /* 已关 */ } resolve(v); };
  const timer = setTimeout(() => (hold && opened ? (onReady?.(ws), resolve('→ 已建立并保持打开')) : done(opened ? '仍 OPEN（未收到 ready）' : '无响应')), hold ? 4000 : 8000);
  ws.on('open', () => {
    opened = true;
    ws.send(JSON.stringify({ type: 'open', streamId: 'e1', endpoint: '$events', payload: { args: {} } }));
  });
  ws.on('message', (d) => {
    if (!String(d).includes('"ready"')) return;
    clearTimeout(timer);
    if (hold) { onReady?.(ws); resolve('→ 收到 ready 并保持打开'); } else done('→ 收到 DSH ready 帧（实时通道可用）');
  });
  ws.on('close', (code, reason) => { clearTimeout(timer); done(`→ close code=${code}（${reason}）`); });
});

console.log('\n【A】当前路由键状态');
console.log('  ① GET /            无 c 参数  :', await get('/'));
console.log('  ② GET /?c=<cid>    带 c 参数  :', await get(`/?c=${CID}`));
console.log('  ③ WS  /api/remote.mux 无 c    :', await mux('/api/remote.mux'));

console.log('\n【B】制造「手机最后一条 socket 关闭」');
if (process.env.RA_FORCE !== '1') {
  console.log('  已跳过（RA_FORCE=1 才执行）：该步会在**未修复**的中继上真正删掉本设备的路由条目，');
  console.log('  之后本设备要等连接器重连/重新配对才能恢复 —— 请在部署修复后用它做最终验收。');
} else {
  let kept = null;
  const opened = await mux(`/api/remote.mux?c=${CID}`, { hold: true, onReady: (ws) => { kept = ws; } });
  console.log('  ④ 带 c 的 mux WS（会重建条目）:', opened);
  if (kept) {
    console.log('  ⑤ 条目在时重放 ①            :', await get('/'));
    kept.terminate();
    await new Promise((r) => setTimeout(r, 800));
    const after = await get('/');
    console.log('  ⑥ 关闭后重放 ①（关键断言）  :', after);
    console.log('  ⑦ 关闭后重放 ③              :', await mux('/api/remote.mux'));
    console.log(after.startsWith('200')
      ? '\n★ PASS：socket 关闭后条目留存，手机可随时回来（中继已修复）'
      : '\n✗ FAIL：socket 关闭即失去路由键 —— 这正是「一直显示重新连接」的根因（中继未打补丁）');
  }
}
process.exit(0);
