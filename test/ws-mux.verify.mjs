/**
 * WebSocket 实时通道验证（真机链路）：经中继建立 /api/remote.mux，发送 $events open 帧，
 * 断言收到 DSH 的 ready 帧（含 clientId）—— 这是前端「已连接」状态的依据。
 *
 * 用法：node test/ws-mux.verify.mjs
 * 可选环境变量：RA_RELAY=wss://你的中继
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// 仓库根目录：相对本文件解析，克隆到任意路径都能跑
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DATA = process.env.HOME + '/.dsh/plugin-data/dsh-kite/default';

/**
 * 中继地址必须**跟着插件配置走**，不能硬编码本机 8787。
 * 真机事故 2026-10-01：把连接器迁到 VPS 后，这条断言恒定失败 —— 不是链路坏了，
 * 而是探针还在敲那个已经没有连接器的本机中继。一个会因为「环境变了」而长期假红的
 * 门禁，等于没有门禁，还会掩盖真实回归。
 */
function resolveRelay() {
  if (process.env.RA_RELAY) return process.env.RA_RELAY;
  try {
    const yml = readFileSync(`${process.env.HOME}/.dsh/profiles/desktop/cordis.patch.yml`, 'utf8');
    const match = /^\s*relayUrl:\s*['"]?(wss?:\/\/[^'"\s]+)/m.exec(yml);
    if (match) return match[1].replace(/\/+$/, '');
  } catch { /* 读不到配置就退回本机自测中继 */ }
  return 'ws://127.0.0.1:8787';
}
const RELAY = resolveRelay();

const { loadConnectorKeys } = await import(`${ROOT}/identity/keys.js`);
const keys = await loadConnectorKeys(DATA);
const devices = JSON.parse(readFileSync(`${DATA}/devices.json`, 'utf8')).devices;
if (devices.length === 0) {
  console.log('[SKIP] 尚无已配对设备，无法验证 WS（先扫码配对）');
  process.exit(0);
}
const dev = devices[0];
const ticket = keys.signPayload({ deviceId: dev.deviceId, iat: Date.now(), exp: Date.now() + 3600_000 });
// connectorId 从密钥推导
const { createHash } = await import('node:crypto');
const fp = createHash('sha256').update(Buffer.concat([keys.ed25519.publicRaw, keys.x25519.publicRaw])).digest('hex').slice(0, 32);

const ws = new WebSocket(`${RELAY}/api/remote.mux?c=${fp}`, { headers: { cookie: `ra-device=${ticket}` } });
const received = [];
const ok = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(false), 12000);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'open', streamId: 'e1', endpoint: '$events', payload: { args: {} } }));
  ws.onmessage = (e) => {
    const text = typeof e.data === 'string' ? e.data : (e.data instanceof Blob ? '' : Buffer.from(e.data).toString('utf8'));
    if (!text) return;
    received.push(text);
    if (text.includes('"ready"')) { clearTimeout(timer); resolve(true); }
  };
  ws.onerror = () => { clearTimeout(timer); resolve(false); };
});
console.log(ok ? 'PASS  WS 实时通道：收到 DSH ready 帧' : 'FAIL  WS 实时通道：未收到 ready 帧');
if (ok) {
  const ready = JSON.parse(received.find((m) => m.includes('"ready"')));
  console.log(`      clientId=${ready.value.clientId}`);
  console.log(`      host.home=${ready.value.host.home}`);
} else {
  console.log(`      收到 ${received.length} 条消息: ${received.slice(0, 2).join(' | ').slice(0, 120)}`);
}
ws.close();
process.exitCode = ok ? 0 : 1;
