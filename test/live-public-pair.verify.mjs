/**
 * 真机验收：对**运行中的公网中继 + 运行中的本机 DSH**走一遍完整配对，
 * 而不是只做「路由判别」这种间接推断。
 *
 * 为什么要有这个脚本（2026-10-02 教训）：
 *   中继换版后，我用「陈旧 cookie + c=当前实例」的判别器确认修复生效 —— 但这只是
 *   证明**路由**对了，没有证明**配对能走通**。真正要回答的是「手机现在能不能配上」，
 *   那就必须真的走一遍 /kite/pair → pair/begin → pair/complete → welcome → /。
 *   判别器可以全绿而配对仍失败（例如连接器侧还在跑旧码、或设备表没上报）。
 *
 * 与仓库内其它 e2e 的分工：
 *   - full-chain.e2e.mjs / pair.e2e.mjs：**本地**起 relay + 模拟 DSH，验代码逻辑。
 *   - 本脚本：**不打桩**，直接打线上中继与线上 DSH —— 它验的是「这次部署」，
 *     所以会随环境真变而红/绿，这正是部署验收需要的信号。
 *
 * 用法：node test/live-public-pair.verify.mjs
 * 环境变量：
 *   RA_PUBLIC   公网中继（默认从插件配置解析，与 ws-mux.verify.mjs 同源）
 *   RA_LOCAL    本机 DSH webServer（默认 http://127.0.0.1:19387）
 *   RA_KEEP     设为 1 则不吊销本次验证创建的设备（默认吊销，避免污染设备表）
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const LOCAL = process.env.RA_LOCAL ?? 'http://127.0.0.1:19387';
const DATA = process.env.DSH_HOME
  ? `${process.env.DSH_HOME}/plugin-data/dsh-kite/default`
  : `${process.env.HOME}/.dsh/plugin-data/dsh-kite/default`;

/** 公网中继按 index.js 的真实优先级解析：env > relay-override.json > patch > 默认。 */
function resolvePublic() {
  if (process.env.RA_PUBLIC) return { url: process.env.RA_PUBLIC, source: 'env RA_PUBLIC' };
  try {
    const ov = JSON.parse(readFileSync(`${DATA}/relay-override.json`, 'utf8'));
    if (typeof ov.relayPublicUrl === 'string' && ov.relayPublicUrl.trim() !== '') {
      return { url: ov.relayPublicUrl.trim().replace(/\/+$/, ''), source: 'relay-override.json' };
    }
  } catch { /* 继续往下找 */ }
  try {
    const yml = readFileSync(`${process.env.HOME}/.dsh/profiles/desktop/cordis.patch.yml`, 'utf8');
    const m = /^\s*relayPublicUrl:\s*['"]?(https?:\/\/[^'"\s]+)/m.exec(yml);
    if (m) return { url: m[1].replace(/\/+$/, ''), source: 'cordis.patch.yml' };
  } catch { /* 无 */ }
  return { url: null, source: '未找到（请设 RA_PUBLIC）' };
}

const results = [];
const check = (name, ok, extra) => {
  results.push([name, ok]);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' → ' + extra : ''}`);
};

const PUB = resolvePublic();
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (buf) => createHash('sha256').update(buf).digest();

// ---- 连接器密钥/指纹：本机 DSH 用的那套（决定 c= 路由键）----
const { loadConnectorKeys } = await import(new URL('../identity/keys.js', import.meta.url));
const keys = await loadConnectorKeys(DATA);
const CONNECTOR_ID = keys.fingerprint;

console.log(`本机 DSH   : ${LOCAL}`);
console.log(`公网中继   : ${PUB.url ?? '(未解析到)'}  （来源：${PUB.source}）`);
console.log(`connectorId: ${CONNECTOR_ID}`);
console.log('');

if (!PUB.url) {
  console.log('无法确定公网中继 —— 设 RA_PUBLIC=https://<中继> 后重跑');
  process.exit(1);
}

// 中继是 IP 证书（shortlived），Node 默认会拒；这与浏览器行为一致，故此处单独放行。
const prevTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const ua = 'kite-live-verify/1.0';
/**
 * ★ 每个请求都必须带超时。旧中继的失败形态是**黑洞**（请求投进错误连接器后无人应答），
 *   undici 默认 headersTimeout 是 300s —— 首跑就在这里挂了 5 分钟才崩，什么也没打印。
 *   一个会静默挂死的验收脚本比没有更糟：看起来像「还在跑」，实际早就失败了。
 *   现在超时即报错，错误信息里带上路径，让「黑洞」变成一眼可读的结论。
 */
const REQ_TIMEOUT_MS = Number(process.env.RA_TIMEOUT_MS ?? 20_000);
async function relayFetch(path, init = {}) {
  try {
    return await fetch(`${PUB.url}${path}`, {
      ...init,
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
      headers: { 'user-agent': ua, ...(init.headers ?? {}) }
    });
  } catch (error) {
    const why = error.name === 'TimeoutError' || /timeout/i.test(error.message)
      ? `请求超时（${REQ_TIMEOUT_MS}ms）—— 中继把该请求黑洞化了（投给了不响应的连接器）`
      : error.message;
    throw new Error(`${path} → ${why}`);
  }
}
/** 本机 DSH 也一样加超时，避免面板端挂死拖住整轮验收。 */
async function localFetch(path, init = {}) {
  try {
    return await fetch(`${LOCAL}${path}`, { ...init, signal: AbortSignal.timeout(REQ_TIMEOUT_MS) });
  } catch (error) {
    throw new Error(`${path} → ${error.message}`);
  }
}

// ---- ① 面板侧：生成真实配对链接（走本机 DSH，与用户点「生成二维码」等价）----
let pairingUrl = null;
let pairToken = null;
try {
  const entry = await (await localFetch('/kite/api/entry')).json();
  const res = await localFetch(entry.url, { redirect: 'manual' });
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const created = await localFetch('/kite/api/pairings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'live-verify' })
  });
  const body = await created.json();
  pairToken = body.token;
  pairingUrl = body.pairingUrl;
  globalThis.__adminCookie = cookie;
  check('① 本机面板签发配对链接', Boolean(pairToken), pairingUrl ? pairingUrl.replace(/token=[^&]+/, 'token=…') : '无');
} catch (error) {
  check('① 本机面板签发配对链接', false, error.message);
}

// ---- ② 手机侧：无任何 cookie（模拟新设备浏览器）打开配对链接 ----
if (pairingUrl) {
  // ★ 关键：不带 ra-device cookie。带陈旧 cookie 正是真机事故里打中旧实例的场景。
  try {
    const u = new URL(pairingUrl);
    const page = await relayFetch(u.pathname + u.search);
    const html = await page.text();
    check('② 手机打开配对链接（无 cookie）', page.status === 200 && html.includes('设备配对'),
      `HTTP ${page.status}${html.includes('设备配对') ? ' · 配对页' : html.includes('还没有接入') ? ' · 落到旧实例提示页 ✗' : ''}`);
  } catch (error) {
    check('② 手机打开配对链接（无 cookie）', false, error.message);
  }
} else {
  check('② 手机打开配对链接（无 cookie）', false, '无配对链接可测');
}

// ---- ③ 真配对：begin（Ed25519 公钥 + 挑战）----
let challenge = null;
let deviceId = null;
let verifyCode = null;
let deviceCookie = null;
if (pairToken) {
  try {
    const { generateKeyPairSync } = await import('node:crypto');
    const kp = generateKeyPairSync('ed25519');
    const pubDer = kp.publicKey.export({ type: 'spki', format: 'der' });
    const pubRaw = pubDer.subarray(pubDer.length - 32);
    globalThis.__liveKeys = { kp, pubRaw };

    const begin = await relayFetch(`/kite/pair/begin?c=${CONNECTOR_ID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: pairToken, pubKey: b64u(pubRaw), name: 'live-verify' })
    });
    const beginBody = await begin.json().catch(() => ({}));
    challenge = beginBody.challenge ?? null;
    deviceId = beginBody.deviceId ?? null;
    verifyCode = beginBody.code ?? null;
    check('③ 配对 begin 返回挑战与校验码', Boolean(challenge && deviceId),
      `HTTP ${begin.status}${verifyCode ? ` · code=${verifyCode}` : ''}${beginBody.error ? ` · ${beginBody.error}` : ''}`);
  } catch (error) {
    check('③ 配对 begin 返回挑战与校验码', false, error.message);
  }
} else {
  check('③ 配对 begin 返回挑战与校验码', false, '无令牌');
}

// ---- ④ 配对完成：签名挑战 → 下发设备 cookie ----
if (challenge && globalThis.__liveKeys) {
  try {
    const { sign } = await import('node:crypto');
    const { kp } = globalThis.__liveKeys;
    const ts = Date.now();
    // ★ 签的是 `nonce ‖ connectorId ‖ ts`，不是裸 challenge（见 identity/ticket.js
    //   verifyChallenge）。只签 challenge 会被判 signature verify failed —— 这是本脚本
    //   首跑的假红，不是产品缺陷。
    const message = Buffer.concat([
      Buffer.from(challenge, 'utf8'),
      Buffer.from(CONNECTOR_ID, 'utf8'),
      Buffer.from(String(ts), 'utf8')
    ]);
    const sig = sign(null, message, kp.privateKey);
    const done = await relayFetch(`/kite/pair/complete?c=${CONNECTOR_ID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ challenge, sig: b64u(sig), ts })
    });
    const setCookie = (done.headers.getSetCookie?.() ?? [])[0] ?? '';
    deviceCookie = /ra-device=[^;]+/.exec(setCookie)?.[0] ?? null;
    const errText = deviceCookie ? '' : (await done.text().catch(() => '')).slice(0, 120);
    check('④ 配对完成并下发设备 cookie', done.status === 200 && Boolean(deviceCookie),
      `HTTP ${done.status}${deviceCookie ? ' · ra-device ✓' : ` · ${errText}`}`);
  } catch (error) {
    check('④ 配对完成并下发设备 cookie', false, error.message);
  }
} else {
  check('④ 配对完成并下发设备 cookie', false, '无挑战');
}

// ---- ⑤ 进入 DSH：带设备 cookie 摸 /（手机点「进入 DSH」后做的事）----
if (deviceCookie) {
  try {
    const home = await relayFetch(`/?c=${CONNECTOR_ID}`, { headers: { cookie: deviceCookie } });
    const body = await home.text();
    const isPairHint = body.includes('需要配对') || body.includes('还没有接入');
    check('⑤ 带设备 cookie 进入 DSH', home.status === 200 && !isPairHint,
      `HTTP ${home.status}${isPairHint ? ' · 落到配对提示页 ✗' : ' · 已进入 DSH ✓'}`);
  } catch (error) {
    check('⑤ 带设备 cookie 进入 DSH', false, error.message);
  }
} else {
  check('⑤ 带设备 cookie 进入 DSH', false, '无设备 cookie');
}

// ---- ⑥ 中继上该连接器在线 ----
try {
  const health = await (await relayFetch('/healthz')).json();
  check('⑥ 中继报告连接器在线', health.connectors >= 1, `connectors=${health.connectors}`);
} catch (error) {
  check('⑥ 中继报告连接器在线', false, error.message);
}

// ---- 清理：吊销本次验证设备，避免污染设备表 ----
if (process.env.RA_KEEP !== '1' && deviceId && globalThis.__adminCookie) {
  try {
    const del = await localFetch(`/kite/api/devices/${encodeURIComponent(deviceId)}`, {
      method: 'DELETE', headers: { cookie: globalThis.__adminCookie }
    });
    console.log(`\n清理：已吊销验证设备 ${deviceId.slice(0, 8)}…（HTTP ${del.status}）`);
  } catch (error) {
    console.log(`\n清理：吊销失败（${error.message}）—— 该设备会在设备表里留下，可在面板手动撤销`);
  }
}

if (prevTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTls;

const pass = results.filter(([, ok]) => ok).length;
console.log(`\n${pass}/${results.length} 项通过`);
process.exitCode = pass === results.length ? 0 : 1;
