/**
 * P0 回归（2026-10-02 真机事故）：中继上挂着 **2 个连接器** 时，
 * 手机 socket 关闭不得把设备路由条目一起删掉，否则手机再也回不来。
 *
 * 真机现场：
 *   中继 /healthz 报 connectors=2（本机正当连接器 + 一个幽灵连接器进程）；
 *   手机浏览器退后台/关闭 → 最后一条 phone socket close →
 *   中继把 deviceId→connector 条目删掉（旧 relay/server.mjs 的 close 分支）；
 *   而连接器只在「重连 / 配对完成」时才重报设备表 →
 *   此后该设备所有**只带 ra-device cookie** 的请求失去路由键：
 *     · 前端全部相对路径请求 → 中继 401/503（连接器根本收不到）
 *     · 不带 c 的 /api/remote.mux → 中继 4503 掐断 → 界面永久「重新连接」，刷新无用
 *   单连接器部署被 connectorFor 的 connectors.size===1 兜底掩盖，所以只有多连接器暴露。
 *
 * 本测试复现该形状（不起真手机）：
 *   ① 两个模拟连接器接入同一中继（A 上报设备 d1，B 什么都不上报）
 *   ② 手机形状的 mux WS（带 ra-device cookie、不带 c）建起来 → 走 cookie 路由
 *   ③ 关掉它（= 浏览器退后台/被杀）
 *   ④ 再发一条只带 cookie 的普通请求 → 必须仍然被路由到 A（修复前：401，连 A 都到不了）
 *   ⑤ 同时断言：没人上报过的 ad-hoc 声称条目仍会被回收（不留垃圾条目）
 */
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { encodeFrame, decodeFrame } from '../transport/frames.js';
import wsPkg from '../relay/node_modules/ws/index.js';
const { WebSocket: WsClient } = wsPkg;

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TOKEN = 'route-entry-token-0123456789';
const DEVICE = 'routeEntryDevice0000001';

const waitFor = async (fn, { timeout = 6000, interval = 50, label = 'condition' } = {}) => {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - t0 > timeout) throw new Error(`超时等待：${label}`);
    await new Promise((r) => setTimeout(r, interval));
  }
};

const relay = spawn(process.execPath, [`${ROOT}/relay/server.mjs`], {
  env: { ...process.env, PORT: '0', RELAY_TOKENS: TOKEN, HOST: '127.0.0.1', RELAY_CONNECTOR_PING_MS: '1000' },
  stdio: ['ignore', 'pipe', 'pipe']
});
relay.stderr.on('data', (c) => process.stderr.write(`[relay] ${c}`));
const port = await new Promise((res, rej) => {
  const t = setTimeout(() => { relay.kill('SIGKILL'); rej(new Error('中继启动超时')); }, 8000);
  relay.stdout.on('data', (c) => {
    const m = /listening on [^:]+:(\d+)/.exec(String(c));
    if (m) { clearTimeout(t); res(Number(m[1])); }
  });
});
const BASE = `http://127.0.0.1:${port}`;
const WSS = `ws://127.0.0.1:${port}`;
console.log(`中继已启动 127.0.0.1:${port}`);

/** 一个「什么都不干、但证明请求有没有被投进来」的模拟连接器。 */
function fakeConnector(id, deviceIds) {
  const state = { httpHeads: [], wsOpens: [] };
  const ws = new WsClient(`${WSS}/connector?c=${id}`, ['ra.v1', `ra-bearer.${TOKEN}`]);
  const ready = new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`连接器 ${id} 接入超时`)), 5000);
    ws.on('open', () => ws.send(encodeFrame({ kind: 'hello', proto: 1, caps: ['http', 'ws'] })));
    ws.on('message', (data) => {
      const frame = decodeFrame(String(data));
      if (frame.kind === 'hello-ack') {
        ws.send(encodeFrame({ kind: 'devices', deviceIds }));
        clearTimeout(t);
        res();
        return;
      }
      if (frame.kind === 'http-head') {
        state.httpHeads.push(frame);
        ws.send(encodeFrame({ kind: 'http-res-head', deviceId: frame.deviceId, streamId: frame.streamId, status: 200, headers: { 'content-type': 'text/plain' } }));
        ws.send(encodeFrame({ kind: 'http-res-body', deviceId: frame.deviceId, streamId: frame.streamId, chunk: Buffer.from('from-' + id).toString('base64url'), final: true }));
        return;
      }
      if (frame.kind === 'ws-open') {
        state.wsOpens.push(frame);
        ws.send(encodeFrame({ kind: 'ws-accept', deviceId: frame.deviceId, streamId: frame.streamId }));
      }
    });
  });
  return { id, ws, ready, state };
}

const A = fakeConnector('aaaa1111aaaa1111aaaa1111aaaa1111', [DEVICE]);
const B = fakeConnector('bbbb2222bbbb2222bbbb2222bbbb2222', []);
await Promise.all([A.ready, B.ready]);
await waitFor(async () => {
  const h = await (await fetch(`${BASE}/healthz`)).json();
  return h.connectors === 2;
}, { label: '两个连接器都在线' });
console.log('已满足前置条件：中继上 connectors=2（单连接器兜底失效）');

const cookie = 'ra-device=v1.' + Buffer.from(JSON.stringify({ deviceId: DEVICE, iat: Date.now(), exp: Date.now() + 3600_000 })).toString('base64url') + '.c2ln';

// ---- ② 手机形状的 mux WS：带 cookie、不带 c ----
const phone = new WsClient(`${WSS}/api/remote.mux`, { headers: { cookie } });
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('手机侧 mux WS 未建起来（中继没路由到连接器）')), 5000);
  phone.on('open', () => { clearTimeout(t); res(); });
  phone.on('error', (e) => { clearTimeout(t); rej(new Error('mux WS error: ' + e.message)); });
});
await waitFor(() => A.state.wsOpens.length === 1, { label: '连接器 A 收到 ws-open' });
console.log('手机形状 mux WS 已建立，并被路由到连接器 A（cookie 路由命中）');

// ---- ③ 关掉它：模拟浏览器退后台/关闭 ----
phone.close();
await waitFor(() => phone.readyState === 3, { label: '手机 socket 关闭' });
await new Promise((r) => setTimeout(r, 400)); // 让中继跑完 close 清理

// ---- ④ 只带 cookie 的普通请求必须仍能路由到 A ----
const res = await fetch(`${BASE}/`, { headers: { cookie } });
const text = await res.text();
console.log(`手机关闭后，仅带 cookie 的 GET / → ${res.status} ${text.length}B（${text.trim().slice(0, 20)}）`);
assert.equal(A.state.httpHeads.length, 1, '设备路由条目必须留存到连接器重报设备表为止（否则手机永远回不来）');
assert.equal(res.status, 200, '中继应把请求投给连接器');
assert.equal(text.trim(), 'from-aaaa1111aaaa1111aaaa1111aaaa1111', '响应来自连接器 A');

// ---- ⑤ 反向断言：连接器没上报过的 ad-hoc 条目仍要被回收，不留垃圾 ----
const ghost = new WsClient(`${WSS}/api/remote.mux?c=aaaa1111aaaa1111aaaa1111aaaa1111&d=ghostDeviceNotPublished`, { headers: { cookie: 'ra-device=v1.e30.c2ln' } });
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('ghost 声称 WS 未建立')), 5000);
  ghost.on('open', () => { clearTimeout(t); res(); });
});
ghost.close();
await new Promise((r) => setTimeout(r, 400));
const health = await (await fetch(`${BASE}/healthz`)).json();
console.log(`清理后中继设备条目数 devices=${health.devices}（期望 1：只有连接器上报过的那个）`);
assert.equal(health.devices, 1, '未上报的 ad-hoc 条目必须被回收');

console.log('\n★ PASS：手机 socket 关闭后设备条目仍在，且不留垃圾条目');
relay.kill('SIGKILL');
process.exit(0);
