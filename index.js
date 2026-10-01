/**
 * dsh-kite — DSH 手机远程访问插件（host-only，零外部导入）。
 *
 * 架构（ADR-001/002/004）：纯出站三段式。本机不开任何入站端口；插件内出站 WSS 连
 * 自建中继，手机连同一中继；Connector 在插件进程内重建请求（Host 恒为 127.0.0.1:port
 * + 注入 loopback cookie），DSH 全部 API 面（PWA / 终端 / 上传 / 审批）零翻译可用。
 *
 * 模块：
 *   transport/  出站 WSS + 承载帧 + E2E 原语     identity/ 设备 ACL + 配对 + 票据
 *   policy/     方法黑名单 + 会话预设锁定 + 审计 proxy/    loopback 凭据 + 反向代理 + WS 桥
 *   approvals/  审批旁听审计                     admin/    管理面板 + 手机配对页
 *
 * 装载纪律（真机事故教训，勿回退）：
 * - 零外部导入（link: 安装链上没有宿主 node_modules）。
 * - 静态 inject 只声明 ['webServer']；connection 走 ctx.inject 可选注入；
 *   服务缺失 = 保持惰性，绝不拖垮 profile。
 * - 所有定时器/异步回调里只碰捕获的对象与 ctx.get(name,false)，绝不直取 ctx.xxx 属性。
 * - 瀑布监听只旁听、绝不吞 next()；异步副作用 fire-and-forget + catch。
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

import { hostAdapter } from './host-adapter.js';
import { loadConnectorKeys } from './identity/keys.js';
import { DeviceStore } from './identity/device-store.js';
import { createTicketService } from './identity/ticket.js';
import { createPairingService } from './identity/pairing.js';
import { createPolicy } from './policy/methods.js';
import { AuditLog } from './policy/audit.js';
import { LoopbackCredential } from './proxy/loopback-credential.js';
import { RelayConnector, probeRelay } from './transport/relay-client.js';
import { acquireRelayOwnerLock } from './transport/owner-lock.js';
import { registerApprovalAudit } from './approvals/responders.js';
import { createAdminHandler, createPairPageHandler, KillSwitch, RelayOverrideStore } from './admin/panel.js';
import { menuEntryRows } from './admin/menu-entry.js';

export const name = 'kite';
export const inject = ['webServer'];

const VERSION = '0.2.0';

/** 数据目录：$DSH_HOME/plugin-data/dsh-kite/<profile>/（宿主进程没有 DSH_PROFILE → default）。 */
export function defaultDataDir(config) {
  if (config && typeof config.dataDir === 'string' && config.dataDir) return config.dataDir;
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const profile = String(process.env.DSH_PROFILE || (config && config.profile) || 'default').replace(/[^\w.-]/g, '_');
  return path.join(home, 'plugin-data', 'dsh-kite', profile);
}

/**
 * 旧数据目录（插件更名 dsh-remote-access → dsh-kite 前的落点）。
 * 仅默认路径参与迁移；显式 dataDir 由用户自管，插件不碰。
 */
export function legacyDataDir(config) {
  if (config && typeof config.dataDir === 'string' && config.dataDir) return null;
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const profile = String(process.env.DSH_PROFILE || (config && config.profile) || 'default').replace(/[^\w.-]/g, '_');
  return path.join(home, 'plugin-data', 'dsh-remote-access', profile);
}

/**
 * 一次性迁移：旧目录存在且新目录不存在时整体 rename —— 同盘原子、原样保留
 * 0600 权限与全部内容（连接器密钥/设备表/审计/kill switch），已配对手机无需重新扫码。
 * 新目录已存在则不动（不覆盖）；之后想回退到旧版插件，把目录名改回去即可。
 */
export async function migrateLegacyDataDir(dataDir, config, logger) {
  const legacy = legacyDataDir(config);
  if (!legacy || legacy === dataDir) return false;
  const [legacyExists, newExists] = await Promise.all([
    fsp.stat(legacy).then(() => true, () => false),
    fsp.stat(dataDir).then(() => true, () => false)
  ]);
  if (!legacyExists || newExists) return false;
  await fsp.mkdir(path.dirname(dataDir), { recursive: true });
  await fsp.rename(legacy, dataDir);
  logger?.info?.('[kite] 已迁移旧数据目录 dsh-remote-access → dsh-kite（密钥/设备表/审计原样保留）');
  return true;
}

/** 配置规范化（config 来自 cordis.patch.yml）。四级优先级（HANDOVER §5.3）：
 *  env (DSH_KITE_RELAY_URL/_TOKEN) > relay-override.json（面板写入）> patch > 默认值。
 *  面板覆盖排在 patch 之上：插件数据目录是插件唯一完全拥有的配置面（§5.1）。
 *  返回 __sources 供面板显示每个字段的实际生效来源。 */
export function readConfig(config, override) {
  const cfg = config && typeof config === 'object' ? config : {};
  const num = (value, fallback, min, max) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n)) : fallback;
  };
  const ov = override && typeof override === 'object' ? override : null;
  const pick = (key, envName) => {
    const env = envName ? process.env[envName] : undefined;
    if (typeof env === 'string' && env.trim() !== '') return { value: env.trim(), source: 'env' };
    const o = ov ? ov[key] : undefined;
    if (typeof o === 'string' && o.trim() !== '') return { value: o.trim(), source: 'override' };
    const p = cfg[key];
    if (typeof p === 'string' && p.trim() !== '') return { value: p.trim(), source: 'patch' };
    return { value: '', source: 'default' };
  };
  const urlPick = pick('relayUrl', 'DSH_KITE_RELAY_URL');
  const relayUrl = /^wss?:\/\//.test(urlPick.value) ? urlPick.value.replace(/\/+$/, '') : '';
  const tokenPick = pick('relayToken', 'DSH_KITE_RELAY_TOKEN');
  const publicPick = pick('relayPublicUrl', null);
  return {
    relayUrl,
    relayToken: tokenPick.value,
    relayPublicUrl: publicPick.value || (relayUrl ? relayUrl.replace(/^ws/, 'http') : ''),
    remoteAgentPreset: String(cfg.remoteAgentPreset ?? 'default'),
    allowedAgentPresets: Array.isArray(cfg.allowedAgentPresets) ? cfg.allowedAgentPresets.map(String) : ['default'],
    allowTerminal: cfg.allowTerminal === true,
    allowUpload: cfg.allowUpload === true,
    menuEntry: cfg.menuEntry !== false,
    pairingTtlSeconds: num(cfg.pairingTtlSeconds, 120, 30, 3600),
    ticketTtlHours: num(cfg.ticketTtlHours, 12, 1, 24 * 30),
    dataDir: cfg.dataDir,
    __sources: {
      relayUrl: relayUrl ? urlPick.source : 'default',
      relayToken: tokenPick.value ? tokenPick.source : 'default',
      relayPublicUrl: publicPick.value ? publicPick.source : (relayUrl ? 'derived' : 'default')
    }
  };
}

export function apply(ctx, config) {
  const logger = ctx?.logger;
  if (!ctx || typeof ctx.inject !== 'function' || !ctx.webServer || typeof ctx.webServer.register !== 'function') {
    logger?.warn?.('[kite] webServer service unavailable; plugin stays inert');
    return;
  }
  const cfg = readConfig(config);
  const adapter = hostAdapter(ctx);
  const dataDir = defaultDataDir(cfg);
  const audit = new AuditLog(dataDir, logger);
  const killSwitch = new KillSwitch(dataDir);
  const relayOverride = new RelayOverrideStore(dataDir);

  // 立即挂管理面（未就绪时 API 返回 starting），避免面板路径与其它插件撞车窗口。
  let deps = null;
  const starting = (req, res) => {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('kite 正在启动（密钥/设备表加载中），请稍后刷新。');
  };
  const disposeRoute = ctx.effect(() => adapter.registerRoute({
    kind: 'prefix',
    path: '/kite',
    handler: (req, res) => (deps ? deps.adminHandler(req, res) : starting(req, res))
  }), 'kite: admin panel');

  // 审批旁听：立即注册（不依赖密钥/设备表）。
  const approvalMetrics = { shown: 0 };
  const disposeApprovalAudit = registerApprovalAudit(ctx, {
    audit: (entry) => audit.append(entry),
    logger,
    metrics: { approvalShown: () => { approvalMetrics.shown += 1; } }
  });

  /**
   * 入口 URL：内嵌插件自签的短期引导令牌（10 分钟，仅授权管理面；不暴露宿主启动令牌）。
   * keys 在 boot 完成后才就绪，就绪前退回宿主会话轨。
   */
  let keysRef = null;
  const buildMenuUrl = () => {
    try {
      if (keysRef) {
        const now = Date.now();
        const token = keysRef.signPayload({ kind: 'kite-bootstrap', iat: now, exp: now + 24 * 3600 * 1000 });
        return `/kite?kite_token=${encodeURIComponent(token)}`;
      }
    } catch {
      /* 签名失败 → 退回宿主会话轨 */
    }
    return '/kite';
  };

  // Web GUI 入口（「手机远程」悬浮按钮）：与官方 client-ui-* 插件同通道注入 boot HTML。
  let disposeMenuEntry;
  if (cfg.menuEntry && typeof ctx.on === 'function') {
    try {
      disposeMenuEntry = ctx.on('webserver/index-inject', (table) => {
        if (Array.isArray(table)) table.push(...menuEntryRows({ authedUrl: buildMenuUrl() }));
      });
    } catch (error) {
      logger?.warn?.(`[kite] menu entry inject failed (panel still available at /kite): ${error.message}`);
    }
  }

  const metrics = { startedAt: Date.now() };
  const boot = (async () => {
    // 更名迁移先于一切加载：密钥/设备表必须在新目录就位后再读。
    await migrateLegacyDataDir(dataDir, cfg, logger).catch((error) => {
      logger?.warn?.(`[kite] 旧数据目录迁移失败（按全新目录继续）: ${error.message}`);
      return false;
    });
    await fsp.mkdir(dataDir, { recursive: true });
    const [keys] = await Promise.all([loadConnectorKeys(dataDir), killSwitch.load()]);
    // 面板覆盖（relay-override.json）加载后同步进 cfg —— 原地修改同一个对象，
    // 让 `() => cfg.relayPublicUrl` 这类 live getter 看到新值（§5.5 坑 3）。
    const override = await relayOverride.load();
    const effective = readConfig(config, override);
    for (const field of ['relayUrl', 'relayToken', 'relayPublicUrl']) cfg[field] = effective[field];
    cfg.__sources = effective.__sources;
    const devices = await new DeviceStore(dataDir, logger).load();
    keysRef = keys; // 入口令牌签名用（注入回调触发时读取）
    const tickets = createTicketService(keys, cfg.ticketTtlHours * 3600_000, logger);
    const policy = createPolicy(cfg);
    const credential = new LoopbackCredential(adapter, logger);

    let live = null; // { pairing, pairPage, relay } —— 改配置时整体重建（§5.5 坑 2：secureCookies 捕获于创建时）
    const buildLive = () => {
      const pairing = createPairingService({
        keys,
        tickets,
        devices,
        ttlMs: cfg.pairingTtlSeconds * 1000,
        logger,
        audit: (entry) => audit.append(entry),
        // ws:// 中继（本地联调）不发 Secure cookie，否则 http 下浏览器会丢弃。
        secureCookies: cfg.relayUrl.startsWith('wss://')
      });
      const pairPage = createPairPageHandler({ pairing, fingerprint: keys.fingerprint, tickets, devices, audit: (entry) => audit.append(entry) });
      const relay = new RelayConnector({
        relayUrl: cfg.relayUrl,
        relayToken: cfg.relayToken,
        connectorId: keys.fingerprint,
        devices,
        tickets,
        pairing,
        policy,
        credential,
        keys,
        audit: (entry) => audit.append(entry),
        logger,
        isKilled: () => killSwitch.enabled,
        handlePairPage: (...args) => live.pairPage(...args)
      });
      return { pairing, pairPage, relay };
    };
    live = buildLive();

    let relayOwned = false; // 展示用：boot 期是否取得了出站职责（面板改配置后按锁现状重新评估）
    let relayLock = null;
    /** 出站传输的启动门槛（boot 与面板改配置共用同一条）。
     *  锁状态看 relayLock.owned 而非 boot 期的 relayOwned —— 否则「boot 时待机、
     *  面板首次配置」的实例永远起不来（集成测试抓到的回归）。 */
    const startRelayIfAllowed = (relay) => {
      if (!cfg.relayUrl || killSwitch.enabled) return;
      if (relayLock && !relayLock.owned) return;
      relayOwned = true;
      relay.start();
    };
    /** 令牌指纹（sha256 前 8 位）：面板可比对凭据是否同一把，令牌本体永不出机（§5.6）。 */
    const tokenFp = () => (cfg.relayToken ? createHash('sha256').update(cfg.relayToken).digest('hex').slice(0, 8) : null);
    const relayConfigStatus = () => {
      const st = live.relay.status();
      return {
        effective: { relayUrl: cfg.relayUrl || null, relayPublicUrl: cfg.relayPublicUrl || null, relayTokenSet: Boolean(cfg.relayToken), relayTokenFp: tokenFp() },
        sources: cfg.__sources ?? null,
        override: { exists: Boolean(relayOverride.get()), changedAt: relayOverride.get()?.changedAt ?? null },
        killswitch: { enabled: killSwitch.enabled },
        relayOwned,
        relay: { state: st.state, lastError: st.metrics.lastError ?? null }
      };
    };
    const probeRelayConfig = (input) => {
      const token = (String(input?.relayToken ?? '').trim()) || cfg.relayToken || '';
      if (!token) return Promise.resolve({ ok: false, code: 'auth', reason: '令牌未设置：输入框留空且当前没有已配置的令牌' });
      return probeRelay({ relayUrl: input?.relayUrl, relayToken: token, timeoutMs: 10_000 });
    };
    /** 面板「应用并重连」：校验 → 服务端复探针（不信任客户端缓存）→ 0600 落盘 → 原地生效 → 重建重连。 */
    const applyRelayOverride = async (next) => {
      const relayUrl = String(next?.relayUrl ?? '').trim();
      const relayPublicUrl = String(next?.relayPublicUrl ?? '').trim();
      const relayToken = String(next?.relayToken ?? '').trim();
      if (killSwitch.enabled) return { ok: false, stage: 'killed', reason: 'kill switch 生效中：请先解除紧急停用再修改中继配置' };
      // wss:// 一律放行；ws:// 仅限回环（本机联调）—— 远程明文入口永不接受（§5.5 坑 2）。
      const loopbackWs = /^ws:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i;
      if (!/^wss:\/\//i.test(relayUrl) && !loopbackWs.test(relayUrl)) {
        return { ok: false, stage: 'validate', reason: '中继地址只允许 wss://（本机联调可用 ws://127.0.0.1:端口）' };
      }
      if (relayPublicUrl && !/^https?:\/\//.test(relayPublicUrl)) return { ok: false, stage: 'validate', reason: '公网入口必须是 http(s):// 地址' };
      if (!relayToken && !cfg.relayToken) return { ok: false, stage: 'validate', reason: '令牌必填：当前没有已配置的令牌，输入框不能留空' };
      const probe = await probeRelayConfig({ relayUrl, relayToken });
      if (!probe.ok) return { ok: false, stage: 'probe', code: probe.code, reason: probe.reason };
      const publicUrl = relayPublicUrl || relayUrl.replace(/^wss/i, 'https');
      try {
        await relayOverride.set({ relayUrl, relayPublicUrl: publicUrl, relayToken });
      } catch (error) {
        return { ok: false, stage: 'write', reason: `写入 relay-override.json 失败：${error.message}` };
      }
      cfg.relayUrl = relayUrl;
      cfg.relayToken = relayToken || cfg.relayToken;
      cfg.relayPublicUrl = publicUrl;
      cfg.__sources = {
        relayUrl: 'override',
        relayToken: relayToken ? 'override' : (cfg.__sources?.relayToken ?? 'default'),
        relayPublicUrl: 'override'
      };
      live.relay.dispose();
      live = buildLive();
      startRelayIfAllowed(live.relay);
      // 审计不含令牌本体，只有指纹前缀（§5.6）。
      audit.append({ kind: 'relay.reconfigure', source: 'panel', relayUrl, tokenFingerprint: tokenFp() });
      logger?.info?.(`[kite] 中继配置已应用（面板覆盖）→ ${relayUrl}`);
      return { ok: true, effective: relayConfigStatus() };
    };

    const adminHandler = createAdminHandler({
      adapter,
      killSwitch,
      devices,
      // 面板改配置会整体重建 pairing —— 走转发门面，路由层永远摸到当前实例。
      pairing: {
        begin: (...args) => live.pairing.begin(...args),
        list: (...args) => live.pairing.list(...args),
        abortAll: (...args) => live.pairing.abortAll(...args)
      },
      audit,
      fingerprint: keys.fingerprint,
      relayStatus: () => live.relay.status(),
      kickDevice: (deviceId) => live.relay.kickDevice(deviceId),
      relayPublicUrl: () => cfg.relayPublicUrl || null,
      probe: () => runProbe({ adapter, credential, logger }),
      relayConfigStatus,
      probeRelayConfig,
      applyRelayOverride
    });
    deps = { adminHandler, relay: live.relay, devices, credential, keys, relayOwned: false, relayLock: null };

    // 设备触达的周期落盘（定时器纪律：只碰捕获对象）。
    const flushTimer = setInterval(() => {
      devices.flush().catch(() => {});
    }, 60_000);
    flushTimer.unref?.();

    // 多宿主共存：同一数据目录只允许一个实例连接中继（否则同指纹抢座，请求随机 502）。
    relayLock = acquireRelayOwnerLock(dataDir, logger);
    if (!cfg.relayUrl) {
      logger?.info?.('[kite] relayUrl 未配置：管理面板可用（可在面板「中继接入」里直接配置），出站传输待机。');
    } else if (killSwitch.enabled) {
      logger?.warn?.('[kite] kill switch 生效中：出站传输保持断开（管理面板可恢复）。');
    } else if (!relayLock.owned) {
      logger?.warn?.(`[kite] 另一 DSH 实例（pid=${relayLock.holder}）持有中继：本实例出站传输待机。`);
    } else {
      relayOwned = true;
      live.relay.start();
    }
    deps.relayOwned = relayOwned;
    deps.relayLock = relayLock;
    metrics.readyAt = Date.now();
    logger?.info?.(`[kite] ready in ${metrics.readyAt - metrics.startedAt}ms (fingerprint ${keys.fingerprint.slice(0, 12)}, devices ${devices.list().length})`);
    // relay 用 getter：面板改配置重建后，清理逻辑释放的仍是当前实例。
    return { get relay() { return live.relay; }, devices, credential, killSwitch, flushTimer };
  })();

  boot.catch((error) => {
    logger?.warn?.(`[kite] bootstrap failed (plugin inert, host unaffected): ${error.message}`);
  });

  ctx.effect(() => async () => {
    disposeApprovalAudit?.();
    disposeMenuEntry?.();
    disposeRoute?.();
    const ready = await boot.catch(() => null);
    ready?.flushTimer && clearInterval(ready.flushTimer);
    ready?.relay?.dispose();
    ready?.relayLock?.release();
  }, 'kite: lifecycle');

  // ---- 探针（方案 §8.5，管理面板触发）----
  async function runProbe({ adapter: adapter_, credential }) {
    const checks = [];
    // ① webServer 可达 + 认证门在位（无 cookie 访问 / 应得 401）。
    const port = adapter_.webServerPort();
    if (!port) {
      checks.push({ name: 'webServer.port', status: 'failed', detail: 'port unavailable' });
    } else {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
        checks.push({ name: 'webServer.port', status: res.status === 401 || res.status === 303 ? 'passed' : 'warn', detail: `GET / → ${res.status}` });
      } catch (error) {
        checks.push({ name: 'webServer.port', status: 'failed', detail: error.message });
      }
    }
    // ② loopback 凭据交换（authenticatedUrl → 303 → dsh-auth cookie）。
    try {
      const { base, cookie } = await credential.acquire();
      checks.push({ name: 'credential.exchange', status: cookie.startsWith('dsh-auth-') ? 'passed' : 'failed', detail: `${base} cookie=${cookie.split('=', 1)[0]}=…` });
    } catch (error) {
      checks.push({ name: 'credential.exchange', status: 'failed', detail: error.message });
      return { overall: 'failed', checks };
    }
    // ③ 重建请求过 isTrustedApiRequest：真实 RPC（session/list 信封）应非 403。
    try {
      const { base, cookie } = await credential.acquire();
      const res = await fetch(new URL('/api/session/list', base), {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'ra-probe', method: 'session/list', payload: {} }),
        signal: AbortSignal.timeout(10_000)
      });
      const text = (await res.text()).slice(0, 300);
      checks.push({
        name: 'api.forward',
        status: res.status === 403 ? 'failed' : 'passed',
        detail: `POST /api/session/list → ${res.status} ${text}`
      });
    } catch (error) {
      checks.push({ name: 'api.forward', status: 'failed', detail: error.message });
    }
    const overall = checks.every((c) => c.status === 'passed') ? 'ok' : (checks.some((c) => c.status === 'failed') ? 'failed' : 'warn');
    return { overall, checks, version: VERSION, metrics };
  }
}
