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
 *
 * ★ 2026-10-02：只读 cordis.patch.yml 仍然不够 —— 那只覆盖四级优先级的**第三级**。
 *   面板「中继接入配置」写的是 relay-override.json，排在 patch **之上**（见 index.js
 *   readConfig 的 source 顺序：env > override > patch > default）。于是从面板迁到 VPS
 *   的用户，patch 里根本没有 relayUrl → 探针静默回落到 ws://127.0.0.1:8787。
 *   而 8787 在本机可能被别的服务占用（实测 switchlane 监听该端口并回 %{status:"ok"}），
 *   于是失败信息是「未收到 ready 帧」这种**看似链路故障、实为敲错门**的假红。
 *   这里按 index.js 的真实优先级解析，并在回落到默认值时把来源说清楚。
 */
function resolveRelay() {
  if (process.env.RA_RELAY) return { url: process.env.RA_RELAY, source: 'env RA_RELAY' };
  const dataDir = process.env.DSH_HOME
    ? `${process.env.DSH_HOME}/plugin-data/dsh-kite/default`
    : `${process.env.HOME}/.dsh/plugin-data/dsh-kite/default`;
  // 第二级：面板覆盖（插件数据目录，最高优先级的落盘配置）
  try {
    const ov = JSON.parse(readFileSync(`${dataDir}/relay-override.json`, 'utf8'));
    if (typeof ov.relayUrl === 'string' && ov.relayUrl.trim() !== '') {
      return { url: ov.relayUrl.trim().replace(/\/+$/, ''), source: 'relay-override.json（面板覆盖）' };
    }
  } catch { /* 没有 override 就继续往下找 */ }
  // 第三级：profile patch
  try {
    const yml = readFileSync(`${process.env.HOME}/.dsh/profiles/desktop/cordis.patch.yml`, 'utf8');
    const match = /^\s*relayUrl:\s*['"]?(wss?:\/\/[^'"\s]+)/m.exec(yml);
    if (match) return { url: match[1].replace(/\/+$/, ''), source: 'cordis.patch.yml' };
  } catch { /* 读不到配置就退回本机自测中继 */ }
  return { url: 'ws://127.0.0.1:8787', source: '默认值（未找到任何 relayUrl 配置）' };
}
const RELAY = resolveRelay();
console.log(`[relay] ${RELAY.url}  （来源：${RELAY.source}）`);

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

const ws = new WebSocket(`${RELAY.url}/api/remote.mux?c=${fp}`, { headers: { cookie: `ra-device=${ticket}` } });
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
  console.log(`      connectorId=${fp}  中继=${RELAY.url}（来源：${RELAY.source}）`);
  console.log(`      收到 ${received.length} 条消息: ${received.slice(0, 2).join(' | ').slice(0, 120)}`);
  // ★ 失败时先说清楚「敲的是谁的门」：中继上没有该连接器时，症状与本条断言完全一样，
  //   不打印地址就会把「配置指向错」误读成「WS 链路坏了」。
  console.log('      排查：该中继上是否有此 connectorId 的连接器？');
  console.log(`        curl -sk ${RELAY.url.replace(/^ws/, 'http')}/healthz   # connectors 应为 ≥1`);
  console.log('      若地址不对：设 RA_RELAY=wss://正确中继 重跑，或检查 relay-override.json / cordis.patch.yml。');
}
ws.close();
process.exitCode = ok ? 0 : 1;
