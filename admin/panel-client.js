/**
 * 「手机远程」面板客户端 —— 注入进 DSH 主页面 DOM 运行（**不是 iframe**）。
 *
 * 为什么不用 iframe / 顶层导航（2026-09-30 真机实测结论，勿再回退）：
 *   iframe src   → 时好时坏（同源判定随文档来源漂移）
 *   iframe srcdoc→ 空白（opaque origin → 面板内请求被判跨站 403）
 *   window.open  → 桌面壳静默拦截
 *   顶层导航      → 401 白页（webview 顶层导航不带宿主会话 cookie）
 *   ★ 父页面 fetch → 始终 200（每一次探测都通过）
 * 因此面板 = 主页面内原生 DOM 浮层 + 父上下文 fetch。零 iframe、零导航、
 * 零对 webview cookie 语义的依赖。
 *
 * 认证：先 fetch 注入的入口 URL（内嵌 kite-bootstrap 令牌）→ 服务端 303 下发
 * kite-admin cookie → 后续 API 全走该 cookie。
 *
 * 本文件是**经典脚本**（无 import/export），由 admin/menu-entry.js 读入并内联注入。
 */
(function () {
  'use strict';
  try {
    var MENU_ID = 'dsh-ra-menu-entry';
    var OVERLAY_ID = 'dsh-ra-overlay';
    var STYLE_ID = 'dsh-ra-style';
    var API = '/kite/api';
    var API_ENTRY = API + '/entry';
    if (document.getElementById(MENU_ID)) return;
    if (location.pathname === '/kite' || location.pathname.indexOf('/kite/') === 0) return;

    var authed = false;
    var authError = '';

    function entryUrl() {
      return (window.__DSH_KITE_AUTH__ && window.__DSH_KITE_AUTH__.url) || '/kite';
    }

    /**
     * 首次兑换 kite-admin cookie。幂等：成功后不再请求。
     * ★ 兑换失败**不缓存失败状态**（曾因此在令牌过期后永久 403、刷新无效）：
     * 每次调用都重试，且带缓存破坏参数绕过 webview 的 fetch 缓存。
     */
    function auth() {
      if (authed) return Promise.resolve(true);
      // 先向服务端实时索取新鲜入口 URL（令牌 10 分钟有效；注入值可能已过期）。
      var url = entryUrl();
      return fetch(API_ENTRY, { credentials: 'same-origin', cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) { return (d && d.url) || url; })
        .catch(function () { return url; })
        .then(function (fresh) { return mint(fresh); });
    }

    function mint(url) {
      var sep = url.indexOf('?') === -1 ? '?' : '&';
      return fetch(url + sep + '_ra=' + Date.now(), { credentials: 'same-origin', redirect: 'follow', cache: 'no-store' })
        .then(function (r) {
          if (r.ok) { authed = true; authError = ''; return true; }
          authError = r.status === 403
            ? '认证失败：引导令牌已过期且宿主会话不可用。请刷新 DSH 页面（F5）重新注入令牌'
            : 'HTTP ' + r.status;
          return false;
        })
        .catch(function (e) {
          authError = '网络错误：' + (e && e.message ? e.message : e);
          return false;
        });
    }

    function api(path, opts) {
      return auth().then(function (ok) {
        if (!ok) throw new Error(authError || '认证失败');
        return fetch(API + path, Object.assign({ credentials: 'same-origin', cache: 'no-store' }, opts || {}));
      }).then(function (r) {
        if (r.status === 401 || r.status === 403) authed = false; // 凭据失效 → 下一轮重新兑换
        return r.json().then(function (data) {
          if (!r.ok) throw new Error(data && data.error ? data.error : 'HTTP ' + r.status);
          return data;
        });
      });
    }

    // ---- DOM 小工具（不用 HTML 字符串，避免解析/转义问题）----
    function h(tag, style, text) {
      var el = document.createElement(tag);
      if (style) el.style.cssText = style;
      if (text !== undefined && text !== null) el.textContent = String(text);
      return el;
    }
    function btn(label, style, onClick) {
      var b = h('button', style || BTN, label);
      b.onclick = onClick;
      return b;
    }

    var BTN = 'border:1px solid #2d3744;background:transparent;color:#9ec3ff;border-radius:6px;padding:5px 11px;cursor:pointer;font:12px/1.4 system-ui,-apple-system,sans-serif;';
    var BTN_PRIMARY = 'border:1px solid #2f81f7;background:#2f81f7;color:#fff;border-radius:6px;padding:6px 13px;cursor:pointer;font:600 12px/1.4 system-ui,-apple-system,sans-serif;';
    var BTN_DANGER = 'border:1px solid #f85149;background:transparent;color:#f85149;border-radius:6px;padding:5px 11px;cursor:pointer;font:12px/1.4 system-ui,-apple-system,sans-serif;';
    var CARD = 'background:#151a21;border:1px solid #232b36;border-radius:10px;padding:12px 14px;margin:10px 0;';
    var NOTE = 'color:#8b949e;font-size:12px;line-height:1.6;';
    var H2 = 'font:600 13px/1.5 system-ui,-apple-system,sans-serif;color:#9aa4b2;margin:16px 0 4px;';
    var MONO = 'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:#8b949e;word-break:break-all;';

    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return;
      var s = document.createElement('style');
      s.id = STYLE_ID;
      s.textContent = '#' + MENU_ID + '{transition:opacity .15s ease}#' + MENU_ID + ':hover{opacity:1!important}'
        + '#' + OVERLAY_ID + ' input{background:#0e1116;border:1px solid #2d3744;border-radius:6px;color:#e6e8eb;padding:6px 9px;font:12px/1.4 system-ui,sans-serif;min-width:8rem}'
        + '#' + OVERLAY_ID + ' td{padding:5px 6px;border-bottom:1px solid #1d242e;font-size:12px;color:#c9d1d9}'
        + '#' + OVERLAY_ID + ' th{text-align:left;padding:5px 6px;font-size:11px;color:#8b949e;font-weight:600;border-bottom:1px solid #232b36}'
        + '#' + OVERLAY_ID + ' ::-webkit-scrollbar{width:10px;height:10px}#' + OVERLAY_ID + ' ::-webkit-scrollbar-thumb{background:#2d3744;border-radius:5px}';
      document.head.appendChild(s);
    }

    // ---- 面板 ----
    function openPanel() {
      if (document.getElementById(OVERLAY_ID)) { document.getElementById(OVERLAY_ID).remove(); return; }
      ensureStyle();
      var wrap = h('div', 'position:fixed;inset:0;z-index:2147483001;background:rgba(6,8,12,.66);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;');
      wrap.id = OVERLAY_ID;
      var card = h('div', 'width:min(940px,94vw);height:min(86vh,760px);background:#0e1116;border:1px solid #232b36;border-radius:14px;box-shadow:0 18px 60px rgba(0,0,0,.55);overflow:hidden;display:flex;flex-direction:column;');

      var bar = h('div', 'display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 15px;border-bottom:1px solid #1d242e;flex:0 0 auto;');
      var title = h('div', 'font:600 13px/1.4 system-ui,-apple-system,sans-serif;color:#e6e8eb;', 'FSH 手机远程访问'.replace('FSH', 'DSH'));
      var right = h('div', 'display:flex;align-items:center;gap:8px;');
      var state = h('span', 'font:12px/1.4 system-ui,sans-serif;color:#8b949e;', '加载中…');
      right.appendChild(state);
      right.appendChild(btn('刷新', BTN, function () { load(true); }));
      right.appendChild(btn('关闭 (Esc)', BTN, function () { wrap.remove(); }));
      bar.appendChild(title);
      bar.appendChild(right);

      var body = h('div', 'flex:1;overflow:auto;padding:6px 18px 22px;');

      // 状态卡
      var statusCard = h('div', CARD);
      var statusRow = h('div', 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;');
      var badge = h('span', 'padding:2px 9px;border-radius:99px;font:11px/1.6 system-ui,sans-serif;background:#2a303a;color:#9aa4b2;', '未知');
      var relayUrlEl = h('span', MONO, '');
      statusRow.appendChild(badge);
      statusRow.appendChild(relayUrlEl);
      statusCard.appendChild(statusRow);
      var statusNote = h('div', NOTE, '');
      statusNote.style.marginTop = '7px';
      statusCard.appendChild(statusNote);

      // ---- 中继接入（可视化配置；交互稿 §2，令牌永不回显，探针用临时 connectorId）----
      var relayHead = h('div', H2, '中继接入（可视化配置）');
      var relayCard = h('div', CARD);
      var rcStateRow = h('div', 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;');
      var rcBadgeEl = h('span', 'padding:2px 9px;border-radius:99px;font:11px/1.6 system-ui,sans-serif;background:#2a303a;color:#9aa4b2;', '未知');
      var rcEffective = h('span', MONO, '（未配置）');
      rcStateRow.appendChild(rcBadgeEl);
      rcStateRow.appendChild(rcEffective);
      function rcInput(placeholder) { var i = document.createElement('input'); i.placeholder = placeholder; return i; }
      var rcUrl = rcInput('wss://中继地址:端口');
      var rcToken = rcInput('令牌（留空 = 沿用当前）');
      rcToken.type = 'password';
      var rcPublic = rcInput('公网入口（默认从地址派生 https）');
      var rcForm = h('div', 'display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;');
      [rcUrl, rcToken, rcPublic].forEach(function (el) { el.style.flex = '1'; el.style.minWidth = '12rem'; rcForm.appendChild(el); });
      var rcMsg = h('span', NOTE, '');
      var rcConfirm = h('div', 'display:none;border:1px solid #d29922;border-radius:8px;padding:10px 12px;margin-top:10px;background:#241a05;');
      var rcSummary = h('div', NOTE, '');
      var rcReWarn = h('div', 'color:#f85149;font-size:12px;line-height:1.6;display:none;margin-top:4px;', '⚠ 改公网入口 = 所有已配对手机都要重新扫码（设备私钥按 origin 隔离，新 origin 里没有它）。');
      var rcConfirmRow = h('div', 'display:flex;gap:8px;margin-top:8px;');
      var rcCurrent = h('div', NOTE, '');
      rcCurrent.style.marginTop = '10px';
      var rcData = null;
      var rcProbeBtn = btn('测试连接', BTN, function () { rcProbe(); });
      var rcApplyBtn = btn('应用并重连', BTN_PRIMARY, function () { rcArm(); });
      var rcYesBtn = btn('确认写入并重连', BTN_PRIMARY, function () { rcApply(); });
      var rcNoBtn = btn('取消', BTN, function () { rcDisarm(); });
      var rcBtns = h('div', 'display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap;');
      rcBtns.appendChild(rcProbeBtn); rcBtns.appendChild(rcApplyBtn); rcBtns.appendChild(rcMsg);
      rcConfirmRow.appendChild(rcYesBtn); rcConfirmRow.appendChild(rcNoBtn);
      rcConfirm.appendChild(rcSummary); rcConfirm.appendChild(rcReWarn); rcConfirm.appendChild(rcConfirmRow);
      relayCard.appendChild(rcStateRow);
      relayCard.appendChild(rcForm);
      relayCard.appendChild(rcBtns);
      relayCard.appendChild(rcConfirm);
      relayCard.appendChild(rcCurrent);
      rcUrl.oninput = function () {
        var v = rcUrl.value.trim();
        // ws:// 仅回环放行（本机联调）；远程明文入口在输入阶段就拦下。
        if (/^ws:\/\//i.test(v) && !/^ws:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(v)) rcMsg.textContent = '✗ 远程地址只允许 wss://（本机联调可用 ws://127.0.0.1）';
        else rcMsg.textContent = '';
      };
      var RC_HINT = {
        format: '地址格式不对：只接受 wss:// 开头。',
        dns: '域名解析失败：核对地址拼写，或服务器已下线。',
        tls: 'TLS/证书异常：证书过期或不被信任（裸 IP 证书 7 天短期档，Caddy 会自动续）。',
        timeout: '超时：服务未运行或云防火墙未放行端口（丢包表现为持续超时，秒回拒绝才是服务没起）。',
        server: '中继异常：查看 /healthz 与日志；确认部署的是新版中继（/metrics 含 wire_frame_limit 行）。',
        auth: '令牌被拒：与中继 RELAY_TOKENS 不一致，或当前未配置令牌。'
      };
      function rcSetMsg(text, bad) { rcMsg.textContent = text; rcMsg.style.color = bad ? '#f85149' : '#8b949e'; }
      function rcInputUrl() { return rcUrl.value.trim() || (rcData && rcData.effective.relayUrl) || ''; }
      function rcProbe() {
        rcSetMsg('探测中…（临时 connectorId，不影响在线连接）', false);
        rcProbeBtn.disabled = true;
        api('/relay/probe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ relayUrl: rcInputUrl(), relayToken: rcToken.value.trim(), relayPublicUrl: rcPublic.value.trim() }) })
          .then(function (r) {
            if (r.ok) rcSetMsg('✓ 探针通过（' + (r.latencyMs || 0) + 'ms）· 可以「应用并重连」', false);
            else rcSetMsg('✗ ' + (RC_HINT[r.code] || '') + (r.reason ? '（' + r.reason + '）' : ''), true);
          })
          .catch(function (e) { rcSetMsg('探针失败：' + e.message, true); })
          .then(function () { rcProbeBtn.disabled = false; });
      }
      function rcArm() {
        var url = rcInputUrl().trim();
        if (!/^wss:\/\//i.test(url) && !/^ws:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(url)) { rcSetMsg('✗ 远程地址只允许 wss://（本机联调可用 ws://127.0.0.1）', true); return; }
        var pub = rcPublic.value.trim() || url.replace(/^wss/i, 'https');
        var changed = rcData && rcData.effective.relayPublicUrl && rcData.effective.relayPublicUrl !== pub;
        var newlySet = rcData && !rcData.effective.relayPublicUrl;
        rcSummary.textContent = '将写入并生效：地址 ' + url + ' ｜ 公网入口 ' + pub + ' ｜ 令牌 ' + (rcToken.value.trim() ? '更新为新值' : '沿用当前');
        rcReWarn.style.display = (changed || newlySet) ? 'block' : 'none';
        rcConfirm.style.display = 'block';
        rcApplyBtn.disabled = true;
      }
      function rcDisarm() { rcConfirm.style.display = 'none'; rcApplyBtn.disabled = false; }
      function rcApply() {
        rcYesBtn.disabled = true;
        rcSetMsg('写入并重连中…', false);
        api('/relay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ relayUrl: rcInputUrl().trim(), relayToken: rcToken.value.trim(), relayPublicUrl: rcPublic.value.trim() }) })
          .then(function (r) {
            if (r.ok) {
              rcSetMsg('✓ 已写入 relay-override.json 并重连（来源：面板覆盖；删该文件即回退）', false);
              rcToken.value = '';
              rcDisarm();
              load(true);
            } else if (r.stage === 'killed') {
              rcSetMsg('✗ ' + r.reason, true);
              rcDisarm();
            } else {
              var prefix = r.stage === 'probe' ? '探针未通过' : (r.stage === 'write' ? '写入失败' : '校验未通过');
              rcSetMsg('✗ ' + prefix + '：' + (r.code ? (RC_HINT[r.code] || '') + ' ' : '') + (r.reason || ''), true);
              if (r.stage !== 'validate') rcDisarm();
            }
          })
          .catch(function (e) { rcSetMsg('请求失败：' + e.message, true); })
          .then(function () { rcYesBtn.disabled = false; });
      }
      function rcRender() {
        if (!rcData) return;
        var map = { open: ['已连接', '#123527', '#7ee2b8'], connecting: ['连接中', '#2a303a', '#9aa4b2'], retrying: ['重试中', '#3a2c12', '#e3b341'], standby: ['待机', '#2a303a', '#9aa4b2'], killed: ['已紧急停用', '#3a1518', '#f85149'] };
        var m = map[rcData.relay && rcData.relay.state] || ['未知', '#2a303a', '#9aa4b2'];
        rcBadgeEl.textContent = m[0]; rcBadgeEl.style.background = m[1]; rcBadgeEl.style.color = m[2];
        rcEffective.textContent = (rcData.effective.relayUrl || '（未配置）') + (rcData.relay && rcData.relay.lastError ? ' · ' + rcData.relay.lastError : '');
        var srcMap = { env: 'env（优先级最高，面板改动不生效）', override: '面板覆盖', patch: 'cordis.patch.yml', derived: '自动派生', default: '默认' };
        var s = rcData.sources || {};
        var tokenText = rcData.effective.relayTokenSet ? '已设置（指纹 ' + rcData.effective.relayTokenFp + '）' : '未设置';
        rcCurrent.textContent = '生效来源：地址=' + (srcMap[s.relayUrl] || s.relayUrl) + ' · 令牌=' + (srcMap[s.relayToken] || s.relayToken) + ' · 入口=' + (srcMap[s.relayPublicUrl] || s.relayPublicUrl)
          + '　|　令牌 ' + tokenText + '　|　覆盖文件 ' + (rcData.override && rcData.override.exists ? '存在（' + new Date(rcData.override.changedAt).toLocaleString() + ' 写入）' : '无');
        var killed = rcData.killswitch && rcData.killswitch.enabled;
        rcApplyBtn.disabled = Boolean(killed);
        rcApplyBtn.title = killed ? 'kill switch 生效中：先解除紧急停用' : '';
        if (killed) rcSetMsg('kill switch 生效中：解除后才可应用新配置', true);
      }
      function rcLoad() {
        return api('/relay').then(function (d) { rcData = d; rcRender(); }).catch(function (e) { rcSetMsg('配置读取失败：' + e.message, true); });
      }

      // 配对区
      var pairHead = h('div', H2, '添加设备（扫码连接）');
      var pairCard = h('div', CARD);
      var pairRow = h('div', 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;');
      var nameInput = document.createElement('input');
      nameInput.placeholder = '设备名（如 我的手机）';
      nameInput.style.flex = '1';
      var pairBtn = btn('生成配对二维码', BTN_PRIMARY, function () { makePairing(); });
      pairRow.appendChild(nameInput);
      pairRow.appendChild(pairBtn);
      pairCard.appendChild(pairRow);
      var pairOut = h('div', 'display:none;margin-top:12px;');
      var pairFlex = h('div', 'display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap;');
      var qrBox = h('div', 'flex:0 0 auto;background:#fff;padding:8px;border-radius:10px;line-height:0;');
      var pairInfo = h('div', 'flex:1;min-width:15rem;');
      var pairHint = h('div', NOTE, '用手机相机或浏览器扫码打开（一次性，用后即焚）：');
      var linkRow = h('div', 'display:flex;gap:6px;align-items:center;margin-top:6px;');
      var linkInput = document.createElement('input');
      linkInput.readOnly = true;
      linkInput.style.flex = '1';
      linkRow.appendChild(linkInput);
      linkRow.appendChild(btn('复制', BTN, function () {
        try { navigator.clipboard.writeText(linkInput.value); } catch (e) { linkInput.select(); }
      }));
      var countdown = h('div', NOTE, '');
      countdown.style.marginTop = '6px';
      var codeLabel = h('div', NOTE, '手机提交后，这里显示桌面侧校验码（与手机比对一致再确认）：');
      codeLabel.style.marginTop = '10px';
      var codeEl = h('div', 'font:700 26px/1.3 ui-monospace,Menlo,monospace;letter-spacing:.18em;color:#7ee2b8;min-height:2rem;', '等待手机提交…');
      // 配对终态横幅：成功/失败/过期在这里落定 —— 光靠码位本身说不出「成了没有」。
      var pairBanner = h('div', 'display:none;margin-top:10px;border-radius:8px;padding:9px 11px;font:12px/1.6 system-ui,-apple-system,sans-serif;');
      pairInfo.appendChild(pairHint);
      pairInfo.appendChild(linkRow);
      pairInfo.appendChild(countdown);
      pairInfo.appendChild(codeLabel);
      pairInfo.appendChild(codeEl);
      pairInfo.appendChild(pairBanner);
      pairFlex.appendChild(qrBox);
      pairFlex.appendChild(pairInfo);
      pairOut.appendChild(pairFlex);
      pairCard.appendChild(pairOut);

      // 设备区
      var devHead = h('div', H2, '已配对设备');
      var devCard = h('div', CARD);
      var table = h('table', 'width:100%;border-collapse:collapse;');
      var thead = h('thead');
      var htr = h('tr');
      ['名称', '设备 ID', '配对时间', '最近活跃', ''].forEach(function (t) { htr.appendChild(h('th', null, t)); });
      thead.appendChild(htr);
      var tbody = h('tbody');
      table.appendChild(thead);
      table.appendChild(tbody);
      devCard.appendChild(table);
      var devActions = h('div', 'display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;');
      devActions.appendChild(btn('撤销全部设备', BTN_DANGER, function () {
        if (!confirm('撤销全部设备并断开其连接？')) return;
        api('/devices/revoke-all', { method: 'POST' }).then(function () { load(true); }).catch(showError);
      }));
      devActions.appendChild(btn('紧急停用（kill switch）', BTN_DANGER, function () {
        if (!confirm('紧急停用远程访问？会立即断开中继并停止重连。')) return;
        api('/killswitch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) })
          .then(function () { load(true); }).catch(showError);
      }));
      devCard.appendChild(devActions);

      // 探针 + 审计
      var probeHead = h('div', H2, '宿主 API 探针');
      var probeCard = h('div', CARD);
      var probeRow = h('div', 'display:flex;gap:10px;align-items:center;');
      var probeState = h('span', NOTE, '');
      probeRow.appendChild(btn('运行探针', BTN, function () {
        probeState.textContent = '运行中…';
        api('/probe', { method: 'POST' }).then(function (d) {
          probeState.textContent = d.overall === 'ok' ? '全部通过' : '存在失败项：' + (d.checks || []).filter(function (c) { return c.status !== 'passed'; }).map(function (c) { return c.name; }).join(', ');
        }).catch(function (e) { probeState.textContent = '失败：' + e.message; });
      }));
      probeRow.appendChild(probeState);
      probeCard.appendChild(probeRow);

      var auditHead = h('div', H2, '审计（最近事件）');
      var auditCard = h('div', CARD);
      var auditPre = h('pre', 'margin:0;font:11px/1.5 ui-monospace,Menlo,monospace;color:#8b949e;max-height:13rem;overflow:auto;white-space:pre-wrap;', '（加载中）');
      auditCard.appendChild(auditPre);

      body.appendChild(statusCard);
      body.appendChild(relayHead);
      body.appendChild(relayCard);
      body.appendChild(pairHead);
      body.appendChild(pairCard);
      body.appendChild(devHead);
      body.appendChild(devCard);
      body.appendChild(probeHead);
      body.appendChild(probeCard);
      body.appendChild(auditHead);
      body.appendChild(auditCard);

      card.appendChild(bar);
      card.appendChild(body);
      wrap.appendChild(card);
      wrap.addEventListener('click', function (e) { if (e.target === wrap) wrap.remove(); });
      document.addEventListener('keydown', function esc(e) {
        if (e.key === 'Escape') { wrap.remove(); document.removeEventListener('keydown', esc); }
      });
      (document.body || document.documentElement).appendChild(wrap);

      var timer = null;
      var pending = null;
      // 本次面板发起的配对：{ tokenMasked } —— 用来认领服务端返回的终态，
      // 别人拿旧二维码扫出的结局不会污染这个面板（见 pairingLast 的归属判断）。
      var pairWatch = null;
      // 成功态自动折叠的定时器句柄。必须持有并显式清除：
      // ① 本体每 1.5/5 秒轮询一次，无条件重挂 setTimeout 会让折叠永不触发（成功态赖着不走）；
      // ② 用户折叠前又点了一次「生成配对二维码」时，上一轮的折叠定时器必须撤掉 ——
      //    否则它会在新配对进行中把二维码区藏掉（真机复现：失败提示刚出就被藏）。
      var pairHideTimer = null;
      function cancelPairHide() {
        if (pairHideTimer) { clearTimeout(pairHideTimer); pairHideTimer = null; }
      }

      function showError(e) {
        state.textContent = '出错：' + (e && e.message ? e.message : e);
        state.style.color = '#f85149';
      }

      /** 终态提示条。tone: 'ok' | 'bad' | 'warn'。 */
      function showBanner(tone, html) {
        var skin = {
          ok: 'border:1px solid #1f6f4a;background:#0f2a1e;color:#7ee2b8;',
          bad: 'border:1px solid #7a2a2a;background:#2a1416;color:#f85149;',
          warn: 'border:1px solid #7a5a1a;background:#241a05;color:#e3b341;'
        };
        pairBanner.style.cssText = 'display:block;margin-top:10px;border-radius:8px;padding:9px 11px;font:12px/1.6 system-ui,-apple-system,sans-serif;' + (skin[tone] || skin.warn);
        pairBanner.innerHTML = html;
      }

      /**
       * 配对终态渲染 —— 面板不再显示「等待手机提交…」的第二种含义。
       *
       * ★ 真机事故 2026-10-03（用户截图）：扫码成功、设备已进「已配对设备」表，
       *   红框里却仍是「等待手机提交…」。根因是**没有终态来源**：配对成功那一刻
       *   pairing.complete() 就把会话从 pending 删掉了，面板每轮只能看到「条目消失」，
       *   而「成功 / 验签失败 / 二维码过期 / kill switch 清空」在 list() 里长得一模一样。
       *   原来只有独立页 /kite 有个基于时间窗的启发式（window.__pairWatch），
       *   注入式浮层（本文件）连那个都没有 → 永远停在初始文案。
       *   现在服务端直接给终态（status.pairingLast），两端同源、无启发式。
       */
      function renderPairOutcome(s) {
        var last = s.pairingLast;
        var list = s.pairings || [];
        var coded = null;
        for (var i = 0; i < list.length; i += 1) { if (list[i].code) { coded = list[i]; break; } }

        if (coded) {
          // 进行中：手机已提交公钥，出示桌面侧校验码供两端比对。
          codeEl.textContent = coded.code;
          codeEl.style.color = '#7ee2b8';
          codeLabel.textContent = '手机已提交公钥。请与手机上的 6 位码比对，一致再在手机上点确认：';
          pairBanner.style.display = 'none';
          return;
        }

        if (list.length > 0) {
          // 进行中：等手机提交公钥。
          codeEl.textContent = '等待手机提交…';
          codeEl.style.color = '#7ee2b8';
          codeLabel.textContent = '手机提交后，这里显示桌面侧校验码（与手机比对一致再确认）：';
          pairBanner.style.display = 'none';
          return;
        }

        // 没有进行中的会话 —— 看终态。
        if (!pairWatch) return; // 本次面板没发起过配对（例如刚打开面板）：保持原样，别乱报
        if (!last) {
          // 会话没了、服务端也没有任何终态：唯一可疑情况是**服务端重启**（面板是刚被重新
          // 注入的，但服务端 pending 已清空）。这时二维码多半已失效，让用户重来而不是干等。
          // 注意不能靠 at 时间戳判断 —— 重启后 at 会归零，反而更小。
          codeEl.textContent = '—';
          codeEl.style.color = '#8b949e';
          showBanner('warn', '配对会话已失效（服务可能刚重启过）。二维码已作废，请重新点「生成配对二维码」。');
          return;
        }
        if (!last.tokenMasks || last.tokenMasks.indexOf(pairWatch.tokenMasked) === -1) {
          // 这条终态属于**别人**的配对（另一个面板，或有人拿旧二维码在扫）：
          // 与本面板无关，保持现有显示不动 —— 误报「已失效 / 已成功」都比多等一轮更糟。
          return;
        }

        if (last.ok) {
          codeEl.textContent = '✓ 配对成功';
          codeEl.style.color = '#4ade80';
          codeLabel.textContent = '设备已加入下方「已配对设备」表';
          showBanner('ok', '设「' + esc2(last.name || 'device') + '」已加入 · 配对完成，手机正在进入 DSH。');
          // 3 秒后自动折叠二维码区，避免占屏（与独立页 /kite 同一节奏）。
          // ★ 必须只挂一次：本函数每 1.5/5 秒被调用一次，无条件 setTimeout 会不断续命，
          //   折叠永远不触发（真机表现为成功态赖着不走）。
          if (!pairHideTimer && pairOut.style.display !== 'none') {
            pairHideTimer = setTimeout(function () {
              pairHideTimer = null;
              try { pairOut.style.display = 'none'; } catch (e) { /* 面板已关 */ }
              pairWatch = null;
            }, 3000);
          }
          return;
        }

        var reasonText = {
          expired: '二维码已过期（120 秒未完成）。请重新生成。',
          rejected: '挑战验签失败' + (last.detail ? '：' + esc2(last.detail) : '') + '。请重新生成二维码再扫。',
          reused: '该二维码已被使用过（一次性）。请重新生成。',
          'invalid-pubkey': '手机提交的公钥格式非法。请重新生成二维码再扫。',
          aborted: '配对已被中止（紧急停用 kill switch）。请先解除停用。',
          unknown: '配对令牌无效或已过期。请重新生成二维码。'
        }[last.reason] || '配对未完成。请重新生成二维码。';
        codeEl.textContent = '✗ 未完成';
        codeEl.style.color = '#f85149';
        showBanner('bad', reasonText);
      }

      function esc2(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }

      function renderStatus(s) {
        state.style.color = '#8b949e';
        state.textContent = '';
        var map = { open: ['已连接', '#123527', '#7ee2b8'], connecting: ['连接中', '#2a303a', '#9aa4b2'], retrying: ['重试中', '#3a2c12', '#e3b341'], standby: ['待机', '#2a303a', '#9aa4b2'], killed: ['已紧急停用', '#3a1518', '#f85149'] };
        var owned = s.relayOwned !== false;
        if (!owned && s.relay.state !== 'open') { badge.textContent = '由另一 DSH 实例接管'; badge.style.background = '#2a303a'; badge.style.color = '#9aa4b2'; }
        else {
          var m = map[s.relay.state] || ['未知', '#2a303a', '#9aa4b2'];
          badge.textContent = m[0]; badge.style.background = m[1]; badge.style.color = m[2];
        }
        relayUrlEl.textContent = s.relay.relayUrl || '（未配置中继）';
        var parts = [];
        parts.push(s.relayPublicUrl ? '手机入口 ' + s.relayPublicUrl : '未配置手机入口（relayPublicUrl）');
        parts.push('指纹 ' + String(s.fingerprint || '').slice(0, 12));
        if (s.relay.metrics && s.relay.metrics.lastError) parts.push('最近错误 ' + s.relay.metrics.lastError);
        // 丢帧观测（P0）：丢帧是「客户端 revision 跳号」的直接嫌疑，必须一眼可见。
        if (s.relay.metrics && s.relay.metrics.framesDropped) {
          var byReason = s.relay.metrics.dropsByReason || {};
          var detail = Object.keys(byReason).map(function (k) { return k + '×' + byReason[k]; }).join('、');
          parts.push('⚠ 丢帧 ' + s.relay.metrics.framesDropped + '（' + detail + '）');
        }
        if (s.killswitch && s.killswitch.enabled) parts.push('kill switch 生效中');
        statusNote.textContent = parts.join(' · ');
        // 设备表
        tbody.textContent = '';
        if (!s.devices || s.devices.length === 0) {
          var tr0 = h('tr');
          var td0 = h('td', NOTE, '暂无设备');
          td0.colSpan = 5;
          tr0.appendChild(td0);
          tbody.appendChild(tr0);
        } else {
          s.devices.forEach(function (d) {
            var tr = h('tr');
            tr.appendChild(h('td', null, d.name));
            tr.appendChild(h('td', MONO, d.deviceId));
            tr.appendChild(h('td', null, d.pairedAt ? new Date(d.pairedAt).toLocaleString() : '-'));
            tr.appendChild(h('td', null, d.lastActiveAt ? new Date(d.lastActiveAt).toLocaleString() : '-'));
            var tdBtn = h('td');
            tdBtn.appendChild(btn('撤销', BTN_DANGER, function () {
              api('/devices/' + encodeURIComponent(d.deviceId), { method: 'DELETE' }).then(function () { load(true); }).catch(showError);
            }));
            tr.appendChild(tdBtn);
            tbody.appendChild(tr);
          });
        }
        // 配对区：进行中会话 + 终态（成功/失败/过期）统一渲染。
        // ★ 旧码在这里只有 `if (list.length > 0)` 一个分支 —— 会话一消失就什么都不做，
        //   于是「等待手机提交…」永驻（真机事故 2026-10-03，用户截图红框）。
        renderPairOutcome(s);
        auditPre.textContent = (s.audit || []).map(function (e2) {
          return new Date(e2.ts).toLocaleTimeString() + ' ' + (e2.kind || '') + (e2.deviceId ? ' ' + e2.deviceId : '') + (e2.reason ? ' — ' + e2.reason : '') + (e2.path ? ' ' + e2.path : '');
        }).join('\n') || '（暂无事件）';
      }

      function load(isManual) {
        rcLoad();
        return api('/status').then(function (s) {
          pending = s;
          renderStatus(s);
          if (isManual) { state.style.color = '#7ee2b8'; state.textContent = '已刷新'; setTimeout(function () { state.textContent = ''; state.style.color = '#8b949e'; }, 1500); }
        }).catch(function (e) {
          badge.textContent = '不可用'; badge.style.background = '#3a1518'; badge.style.color = '#f85149';
          relayUrlEl.textContent = '';
          statusNote.textContent = '状态加载失败：' + e.message + '　—　可点击右上「刷新」重试；若持续失败，用真实浏览器打开 http://127.0.0.1:<端口>/kite';
          showError(e);
        });
      }

      function makePairing() {
        var name = (nameInput.value || '').trim() || 'phone';
        pairBtn.disabled = true;
        pairBtn.textContent = '生成中…';
        api('/pairings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: name }) })
          .then(function (d) {
            pairOut.style.display = 'block';
            linkInput.value = d.pairingUrl || ('（未配置中继）token=' + d.token);
            qrBox.textContent = '';
            if (d.qrSvg) {
              var box = h('div', 'width:190px;height:190px;');
              box.innerHTML = d.qrSvg; // 服务端生成的 SVG（无脚本，安全）
              var svg = box.firstChild;
              if (svg) { svg.setAttribute('width', '190'); svg.setAttribute('height', '190'); }
              qrBox.appendChild(box);
            } else {
              qrBox.appendChild(h('div', 'width:174px;padding:8px;color:#0e1116;font:12px/1.5 system-ui,sans-serif;', d.note || '未配置中继，无法生成二维码'));
            }
            codeEl.textContent = '等待手机提交…';
            codeEl.style.color = '#7ee2b8';
            codeLabel.textContent = '手机提交后，这里显示桌面侧校验码（与手机比对一致再确认）：';
            pairBanner.style.display = 'none';
            // ★ 认领本次配对的终态：tokenMasked 由服务端给（与 /status 的 pairingLast 同一格式），
            //   面板据此判断「那条结局是不是我这次发起的」。
            pairWatch = d.tokenMasked ? { tokenMasked: d.tokenMasked } : null;
            // 上一轮成功态的折叠定时器必须撤掉，否则它会在新配对进行中把二维码区藏掉。
            cancelPairHide();
            var left = Math.max(0, Math.round((d.expiresAt - Date.now()) / 1000));
            countdown.textContent = left > 0 ? left + 's 后过期' : '已过期，请重新生成';
            var t = setInterval(function () {
              if (!document.getElementById(OVERLAY_ID)) { clearInterval(t); return; }
              var n = Math.max(0, Math.round((d.expiresAt - Date.now()) / 1000));
              countdown.textContent = n > 0 ? n + 's 后过期' : '已过期，请重新生成';
              if (n <= 0) clearInterval(t);
            }, 1000);
          })
          .catch(showError)
          .then(function () { pairBtn.disabled = false; pairBtn.textContent = '生成配对二维码'; });
      }

      load();
      // ★ 自适应轮询：配对区展开时 1.5 秒一轮 —— 用户就盯着那个红框看，
      //   5 秒的节奏在「扫码 → 出码」之间会有肉眼可见的空白期。
      //   平时（无配对）退回 5 秒，别为一块静态面板多打接口。
      var tick = function () {
        if (!document.getElementById(OVERLAY_ID)) { clearInterval(timer); return; }
        load();
        var want = pairOut.style.display === 'block' ? 1500 : 5000;
        if (want !== intervalMs) { intervalMs = want; clearInterval(timer); timer = setInterval(tick, intervalMs); }
      };
      var intervalMs = 5000;
      timer = setInterval(tick, intervalMs);
    }

    function makeButton() {
      if (document.getElementById(MENU_ID)) return;
      var host = document.body || document.documentElement;
      if (!host) return;
      var b = document.createElement('button');
      b.id = MENU_ID;
      b.setAttribute('aria-label', '手机远程访问');
      b.title = '手机远程访问（扫码连接）';
      b.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="margin-right:5px"><rect x="7" y="2" width="10" height="20" rx="2"></rect><line x1="11" y1="18" x2="13" y2="18"></line></svg><span>手机远程</span>';
      b.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483000;display:inline-flex;align-items:center;padding:6px 12px;border-radius:999px;border:1px solid rgba(110,168,254,.35);background:rgba(21,26,33,.82);color:#9ec3ff;font:12px/1.4 system-ui,-apple-system,sans-serif;cursor:pointer;opacity:.72;backdrop-filter:blur(6px);';
      b.onclick = openPanel;
      host.appendChild(b);
    }

    /**
     * 供侧栏入口（admin/sidebar-entry.js）调用：把面板打开函数暴露到 window。
     * 幂等赋值；面板客户端若未注入，侧栏入口自行回退（点击悬浮按钮 → 静默）。
     */
    window.__DSH_KITE_OPEN__ = openPanel;

    /**
     * 悬浮按钮显隐：由 index.js 注入的 __DSH_KITE_ENTRY__.floating 决定。
     * 全局缺失时 fail-open（floating !== false → 显示），保证旧行为与既有 e2e 不受影响。
     * ★ 面板引擎（本脚本）与入口按钮是两件事：'sidebar' 模式下仍注入本脚本（面板要能打开），
     *   只是不建悬浮按钮。
     */
    var entryCfg = (window.__DSH_KITE_ENTRY__ && typeof window.__DSH_KITE_ENTRY__ === 'object') ? window.__DSH_KITE_ENTRY__ : {};
    if (entryCfg.floating !== false) {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', makeButton, { once: true });
      else makeButton();
    }
  } catch (e) {
    /* 入口失败绝不影响 GUI */
  }
})();
