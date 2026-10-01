/**
 * 会话流探针：完全按手机 PWA 的路径复现一次「加载历史」。
 *
 * 路径与手机一致：连接器密钥签设备票据 → 经公网中继 → 中继桥到本机 DSH。
 * 用途：在【不依赖手机、不依赖浏览器】的前提下，直接看 DSH 吐出来的前几帧
 * 到底是什么类型 —— 这是判断「客户端报 entry before its opening cursor」
 * 究竟是丢帧还是 DSH 本身没先发 snapshot 的唯一干净办法。
 *
 * 用法：
 *   node test/session-stream.probe.mjs                     # 列出会话
 *   node test/session-stream.probe.mjs <sessionAddress>    # 对该会话开 follow 并 dump 帧
 *
 * 环境变量：RA_RELAY（默认读插件配置里的 relayUrl）
 */
import { readFileSync } from 'node:fs';
import { loadConnectorKeys } from '../identity/keys.js';

const DATA = `${process.env.HOME}/.dsh/plugin-data/dsh-kite/default`;
const HTTP_BASE = (() => {
  if (process.env.RA_RELAY) return process.env.RA_RELAY.replace(/^ws/, 'http').replace(/\/+$/, '');
  const yml = readFileSync(`${process.env.HOME}/.dsh/profiles/desktop/cordis.patch.yml`, 'utf8');
  const match = /^\s*relayUrl:\s*['"]?(wss?:\/\/[^'"\s]+)/m.exec(yml);
  return match ? match[1].replace(/^ws/, 'http').replace(/\/+$/, '') : 'http://127.0.0.1:8787';
})();
const WS_BASE = HTTP_BASE.replace(/^http/, 'ws');
const FP = null; // 运行时填

const keys = await loadConnectorKeys(DATA);
const fingerprint = keys.fingerprint;
const devices = JSON.parse(readFileSync(`${DATA}/devices.json`, 'utf8')).devices;
if (!devices.length) {
  console.log('[SKIP] 尚无已配对设备');
  process.exit(0);
}
const deviceId = devices[0].deviceId;
const ticket = keys.signPayload({ deviceId, iat: Date.now(), exp: Date.now() + 3600_000 });
const COOKIE = `ra-device=${ticket}`;

console.log(`中继      ${HTTP_BASE}`);
console.log(`设备      ${deviceId}`);
console.log(`连接器指纹 ${fingerprint}`);

const target = process.argv[2];

if (!target) {
  // DSH 的 HTTP RPC 信封（第一次用错形状时，它的报错把字段一个个列了出来）：
  //   { type: 'client-request', rpcId, method, payload }
  const res = await fetch(`${HTTP_BASE}/api/session/list?c=${fingerprint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: COOKIE },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `probe-${Date.now()}`,
      method: 'session/list',
      payload: { args: { _request: {} } }
    })
  });
  console.log(`\nPOST /api/session/list → HTTP ${res.status}`);
  const text = await res.text();
  console.log(text.slice(0, 2000));
  console.log('\n（把上面某个会话的 address 作为参数再跑一次，即可 dump 它的流帧）');
  process.exit(0);
}

// ---- 开 mux，按 session/follow 打开流，dump 前若干帧 ----
const url = `${WS_BASE}/api/remote.mux?c=${fingerprint}`;
console.log(`\n开流 ${url}\nendpoint=session/follow address=${target}\n`);
const ws = new WebSocket(url, { headers: { cookie: COOKIE } });
const frameTypes = [];
let raw = 0;
let maxPayload = 0;
let totalBytes = 0;
// 中继传的是 base64：connector→relay 那一跳的帧体积 ≈ 原始 payload × 4/3 + JSON 信封(~150B)
const encoded = (n) => Math.ceil(n / 3) * 4 + 150;
const LIMIT = 1024 * 1024;

const done = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve('timeout'), 25000);
  ws.onopen = () => {
    console.log('mux 已连上，发送 open 帧');
    ws.send(JSON.stringify({
      type: 'open',
      streamId: 'probe-1',
      endpoint: 'session/follow',
      payload: { args: { request: { address: { kind: 'session', sessionId: target }, assistantStream: true } } }
    }));
  };
  ws.onmessage = (event) => {
    const text = typeof event.data === 'string' ? event.data : '';
    raw += 1;
    totalBytes += text.length;
    if (text.length > maxPayload) maxPayload = text.length;
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* 非 JSON */ }
    const kind = parsed?.type ?? parsed?.kind ?? '(无法解析)';
    const extra = parsed?.value?.type ?? parsed?.frame?.type ?? parsed?.event?.type ?? '';
    frameTypes.push(`${kind}${extra ? ` / ${extra}` : ''}`);
    if (kind === 'error') console.log(`  ★ error 帧原文: ${text}`);
    if (raw <= 12) {
      console.log(`  帧#${raw}: type=${kind}${extra ? ` value.type=${extra}` : ''} bytes=${text.length}`);
    }
    const hasSnapshot = /"snapshot"/.test(text);
    if (hasSnapshot && raw <= 12) console.log('      ↑ 这一帧是 snapshot');
    if (raw >= 40) { clearTimeout(timer); resolve('enough'); }
  };
  ws.onerror = (e) => { console.log(`mux 错误: ${e?.message ?? e}`); clearTimeout(timer); resolve('error'); };
  ws.onclose = (e) => { clearTimeout(timer); resolve(`closed ${e.code} ${e.reason}`); };
});

console.log(`\n结束原因: ${done}   总帧数: ${raw}`);
console.log('前 12 帧类型序列:');
frameTypes.slice(0, 12).forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
const firstSnapshotAt = frameTypes.findIndex((t) => /snapshot/.test(t));
console.log(`\n本流合计 ${totalBytes} 字节 / ${raw} 帧`);
console.log(`最大单帧（原始 payload）: ${maxPayload} 字节`);
console.log(`过中继时（base64+信封）  : ${encoded(maxPayload)} 字节  = 上限的 ${(encoded(maxPayload) / LIMIT * 100).toFixed(1)}%`);
console.log(`中继帧上限                : ${LIMIT} 字节`);
console.log(`距上限还有               : ${LIMIT - encoded(maxPayload)} 字节\n`);
console.log(`\n首个 snapshot 出现在第 ${firstSnapshotAt < 0 ? '（未出现）' : firstSnapshotAt + 1} 帧`);
if (firstSnapshotAt > 0) console.log('★ 有问题：snapshot 之前已经有别的帧 —— 正是客户端报的那条契约违规');
if (firstSnapshotAt === 0) console.log('正常：snapshot 是第一帧');
ws.close();
