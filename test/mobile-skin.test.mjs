/**
 * 移动端自适应层契约测试（方案 v4）。
 *
 * 覆盖两条已证实的链路缺陷：
 * 1. content-length 必须与注入后 body 一致（relay-client #sendHttpResponse 原样转发头，
 *    中继 writeHead 透传；不重写 = 手机按旧长度收流 → 整页挂起）。
 * 2. etag/last-modified 必须剥离 + no-store（宿主对未注入内容签 304 → 手机用回
 *    未注入缓存页 → 注入随机失效）。
 * 以及全部门禁条件：GET/200/text-html/幂等/尺寸上限/附件跳过/无 </head> 跳过。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyMobileSkin, SKIN_MARKER, SKIN_VERSION } from '../admin/mobile-skin.js';
import { forwardRequest } from '../proxy/reverse-proxy.js';
import { createPolicy } from '../policy/methods.js';
import { AuditLog } from '../policy/audit.js';

const SHELL = (extra = '') => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${extra}</head><body><div id="root"></div></body></html>`;

function htmlBody(s = SHELL()) {
  return Buffer.from(s, 'utf8');
}

const base = (over = {}) => ({
  method: 'GET',
  path: '/',
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8', etag: 'W/"abc"', 'last-modified': 'yesterday', 'content-length': '999' },
  body: htmlBody(),
  ...over
});

test('注入：HTML 文档命中 —— marker 恰好一次、content-length 同步、etag/last-modified 剥离、no-store', () => {
  const r = applyMobileSkin(base());
  assert.ok(r, '必须命中');
  const text = r.body.toString('utf8');
  assert.equal(text.split(SKIN_MARKER).length - 1, 1, 'marker 恰好一次');
  assert.ok(text.includes('dsh-kite-mobile'), '样式块存在');
  assert.ok(text.includes('--dsh-chat-user-width'), '列宽 token 覆盖存在');
  assert.equal(r.headers['content-length'], String(r.body.length), 'content-length 与新 body 同步（否则手机挂起）');
  assert.equal(r.headers.etag, undefined, 'etag 剥离（304 缓存陷阱）');
  assert.equal(r.headers['last-modified'], undefined, 'last-modified 剥离');
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.ok(r.body.length > htmlBody().length, 'body 变大');
  // 注入点必须在 </head> 之前（样式要在首帧前生效）
  assert.ok(text.indexOf('dsh-kite-mobile') < text.indexOf('</head>'));
});

test('注入：viewport meta 补 viewport-fit=cover（精确替换，已含则不动）', () => {
  const r = applyMobileSkin(base());
  assert.ok(r.body.toString('utf8').includes('initial-scale=1, viewport-fit=cover'));
  // 已含 viewport-fit 的页面不重复补
  const r2 = applyMobileSkin(base({ body: htmlBody(SHELL().replace('initial-scale=1', 'initial-scale=1, viewport-fit=cover')) }));
  assert.ok(r2, '其余注入照常');
  assert.equal(r2.body.toString('utf8').split('viewport-fit=cover').length - 1, 1, '不重复追加');
});

test('注入：已有 viewport-fit 时仍补 interactive-widget=resizes-content', () => {
  const body = htmlBody('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head><body></body></html>');
  const r = applyMobileSkin(base({ body }));
  const text = r.body.toString('utf8');
  assert.match(text, /viewport-fit=cover, interactive-widget=resizes-content/);
  const reversed = htmlBody('<!doctype html><html><head><meta content="width=device-width, initial-scale=1, viewport-fit=cover" name="viewport"></head><body></body></html>');
  const r3 = applyMobileSkin(base({ body: reversed }));
  assert.match(r3.body.toString('utf8'), /viewport-fit=cover, interactive-widget=resizes-content/);
});

test('内容：全面窄屏规则覆盖 composer、审批/提问、操作行、右栏、终端和弹窗', () => {
  const text = applyMobileSkin(base()).body.toString('utf8');
  for (const selector of [
    '[data-composer-seat]',
    '[data-model-compact]',
    '[data-approval-key]',
    '[data-question-key]',
    '[data-actions-reveal]',
    '[data-sidebar-right-session]',
    '[data-terminal]',
    '[data-code-block-content]',
    '[role="dialog"]'
  ]) assert.ok(text.includes(selector), `缺少窄屏规则 ${selector}`);
  assert.ok(text.includes('min-height:44px'), '触控目标规则存在');
  assert.ok(text.includes('max-height:min(42dvh,360px)'), '交互卡滚动边界存在');
  assert.ok(text.includes(':has(> div:first-child > button[aria-haspopup="listbox"])'), 'composer send-space structure rule exists');
  assert.ok(text.includes('flex:0 0 44px;width:44px;height:44px'), 'composer send button reserves a stable hit box');
  assert.ok(text.includes('> :not(button) > *{min-width:0;max-width:100%;overflow:hidden'), 'activity contents shrink inside the reserved space');
});
test('门禁：POST / 非 200 / 非 HTML / 空体 一律不注入', () => {
  assert.equal(applyMobileSkin(base({ method: 'POST' })), null);
  assert.equal(applyMobileSkin(base({ status: 404 })), null);
  assert.equal(applyMobileSkin(base({ status: 302 })), null);
  assert.equal(applyMobileSkin(base({ headers: { 'content-type': 'application/json; charset=utf-8' }, body: Buffer.from('{"ok":true}') })), null);
  assert.equal(applyMobileSkin(base({ body: Buffer.alloc(0) })), null);
  assert.equal(applyMobileSkin(base({ method: 'HEAD' })), null, 'HEAD 无 body，天然跳过');
});

test('门禁：附件下载（content-disposition）绝不改写', () => {
  assert.equal(applyMobileSkin(base({ headers: { 'content-type': 'text/html', 'content-disposition': 'attachment; filename="a.html"' } })), null);
});

test('门禁：无 </head> 的 HTML 不动', () => {
  assert.equal(applyMobileSkin(base({ body: Buffer.from('<div>no head close</div>') })), null);
});

test('门禁：幂等 —— 已含 marker 的页面跳过', () => {
  const once = applyMobileSkin(base());
  const again = applyMobileSkin(base({ body: once.body, headers: { 'content-type': 'text/html; charset=utf-8' } }));
  assert.equal(again, null);
});

test('门禁：超过 2MB 的 HTML 不注入', () => {
  const big = htmlBody(SHELL() + '<!--' + 'x'.repeat(2 * 1024 * 1024) + '-->');
  assert.ok(big.length > 2 * 1024 * 1024);
  assert.equal(applyMobileSkin(base({ body: big })), null);
});

test('门禁：带扩展名的非文档路径跳过（/、/index.html、/?c=… 放行）', () => {
  assert.equal(applyMobileSkin(base({ path: '/assets/logo.svg' })), null);
  assert.ok(applyMobileSkin(base({ path: '/index.html' })));
  assert.ok(applyMobileSkin(base({ path: '/?c=0123abcd' })));
  assert.ok(applyMobileSkin(base({ path: '/' })));
});

test('内容：SKIN_VERSION 写进 marker，便于真机 devtools 确认层版本', () => {
  const r = applyMobileSkin(base());
  assert.ok(r.body.toString('utf8').includes(`${SKIN_MARKER}="${SKIN_VERSION}"`));
});

test('集成：forwardRequest 缓冲路径接通 skin（deps.mobileSkin 注入）', async () => {
  // 直接以 applyMobileSkin 作为 deps.mobileSkin 走 forwardRequest 主链路，
  // 验证注入后的头/body 从代理原样返回（gzip 分支在 relay-client 侧，另测）。
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', etag: '"x"' });
    res.end(SHELL());
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ra-skin-'));
    const audit = new AuditLog(dir, console);
    const result = await forwardRequest(
      {
        credential: { acquire: async () => ({ base: `http://127.0.0.1:${server.address().port}`, cookie: 'dsh-auth-test=v1' }) },
        policy: createPolicy({ remoteAgentPreset: 'default', allowedAgentPresets: ['default'] }),
        audit: (e) => audit.append(e),
        mobileSkin: applyMobileSkin
      },
      { deviceId: 'd1', method: 'GET', path: '/', headers: { cookie: 'ra-device=t' }, isDeviceValid: true }
    );
    const text = result.body.toString('utf8');
    assert.ok(text.includes(SKIN_MARKER), '主链路注入生效');
    assert.equal(result.headers['content-length'], String(result.body.length), '代理返回头与新 body 同步');
    assert.equal(result.headers.etag, undefined);
    assert.equal(result.headers['cache-control'], 'no-store');
  } finally {
    server.close();
  }
});
