import test from 'node:test';
import assert from 'node:assert/strict';
import { createPolicy, safeProxyPath } from '../policy/methods.js';
import { rewriteSessionCreateBody, rewriteSealedOpen } from '../policy/presets.js';

function policy(overrides = {}) {
  return createPolicy({
    remoteAgentPreset: 'default',
    allowedAgentPresets: ['default'],
    allowTerminal: false,
    allowUpload: false,
    ...overrides
  });
}

test('策略：session/create 注入远程预设（R5 核心验收）', () => {
  const verdict = policy().decide({ method: 'POST', path: '/api/session/create', body: Buffer.from('{}') });
  assert.equal(verdict.action, 'rewrite');
  const body = JSON.parse(verdict.body.toString('utf8'));
  assert.equal(body.agentPreset, 'default', '省略 agentPreset 必须被注入');
});

test('策略：session/create 显式白名单内预设保留并仍强制收敛', () => {
  const p = createPolicy({ remoteAgentPreset: 'remote-safe', allowedAgentPresets: ['remote-safe', 'default'] });
  const verdict = p.decide({ method: 'POST', path: '/api/session/create', body: Buffer.from('{"agentPreset":"default"}') });
  assert.equal(verdict.action, 'rewrite');
  assert.equal(JSON.parse(verdict.body.toString()).agentPreset, 'remote-safe', '统一收敛到 remoteAgentPreset');
});

test('策略：session/create 白名单外预设必须 403', () => {
  const verdict = policy().decide({ method: 'POST', path: '/api/session/create', body: Buffer.from('{"agentPreset":"danger-preset"}') });
  assert.equal(verdict.action, 'deny');
  assert.equal(verdict.status, 403);
  assert.match(verdict.reason, /danger-preset/);
});

test('策略：session/create 非 JSON 体拒绝', () => {
  const verdict = policy().decide({ method: 'POST', path: '/api/session/create', body: Buffer.from('not-json') });
  assert.equal(verdict.action, 'deny');
});

test('策略：黑名单——上传默认拒绝', () => {
  const verdict = policy().decide({ method: 'POST', path: '/api/session/uploadFileBinary?sessionId=x' });
  assert.equal(verdict.action, 'deny');
  assert.equal(policy({ allowUpload: true }).decide({ method: 'POST', path: '/api/session/uploadFileBinary' }).action, 'allow');
});

test('策略：黑名单——终端写类默认拒绝，读类放行', () => {
  for (const endpoint of ['create', 'write', 'resize', 'rename', 'close', 'environment']) {
    const verdict = policy().decide({ method: 'POST', path: `/api/terminal/${endpoint}` });
    assert.equal(verdict.action, 'deny', `terminal/${endpoint} 应拒绝`);
    assert.match(verdict.reason, /terminal\//);
  }
  assert.equal(policy().decide({ method: 'POST', path: '/api/terminal/list' }).action, 'allow');
  assert.equal(policy().decide({ method: 'POST', path: '/api/terminal/follow' }).action, 'allow');
  assert.equal(policy({ allowTerminal: true }).decide({ method: 'POST', path: '/api/terminal/write' }).action, 'allow');
});

test('策略：未知终端方法默认拒绝', () => {
  const verdict = policy().decide({ method: 'POST', path: '/api/terminal/some-new-method' });
  assert.equal(verdict.action, 'deny');
});

test('策略：plugin 写操作拒绝；插件静态资产 GET 放行；HMR 事件一律拒绝', () => {
  assert.equal(policy().decide({ method: 'GET', path: '/plugins/dsh-quote-followup/index.js' }).action, 'allow');
  assert.equal(policy().decide({ method: 'POST', path: '/plugins/anything' }).action, 'deny');
  assert.equal(policy().decide({ method: 'POST', path: '/api/plugin-manager/install' }).action, 'deny');
  assert.equal(policy().decide({ method: 'GET', path: '/plugins/events' }).action, 'deny', 'HMR 事件通道白名单优先');
  assert.equal(policy().decide({ method: 'GET', path: '/plugins/contains/../traversal' }).action, 'deny', '目录遍历拒绝');
});

test('策略：★DSH 客户端模块合并请求放行（??/&rev= 形式，真机事故）', () => {
  // 这是 DSH 前端加载客户端模块的核心路径；拒绝会导致整个界面 Failed to load plugins
  for (const path of [
    '/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=18d5ad4570b7',
    '/plugins/??@deepseek-ai/dsh-client-ui-chat/client.js&rev=abc',
    '/plugins/@deepseek-ai/dsh-client-modules/client.js',
    '/plugins/?modules=a,b',
    '/plugins/not-an-asset',
  ]) {
    assert.equal(policy().decide({ method: 'GET', path }).action, 'allow', `应放行：${path}`);
  }
  assert.equal(policy().decide({ method: 'HEAD', path: '/plugins/??x.js' }).action, 'allow');
  assert.equal(policy().decide({ method: 'POST', path: '/plugins/??x.js' }).action, 'deny', '写操作仍拒绝');
});

test('策略：社区市场一律拒绝；管理面前缀 reserved', () => {
  assert.equal(policy().decide({ method: 'GET', path: '/api/community-market/list' }).action, 'deny');
  assert.equal(policy().decide({ method: 'GET', path: '/kite/api/status' }).action, 'deny');
});

test('策略：普通读路径放行', () => {
  assert.equal(policy().decide({ method: 'GET', path: '/' }).action, 'allow');
  assert.equal(policy().decide({ method: 'GET', path: '/manifest.webmanifest' }).action, 'allow');
  assert.equal(policy().decide({ method: 'POST', path: '/api/session/list', body: Buffer.from('{}') }).action, 'allow');
});

test('safeProxyPath：拒绝 absolute-form / 控制字符 / 反斜杠', () => {
  assert.equal(safeProxyPath('/api/x?y=1'), true);
  assert.equal(safeProxyPath('http://evil/x'), false);
  assert.equal(safeProxyPath('/x y'), false);
  assert.equal(safeProxyPath('/x\\y'), false);
  assert.equal(safeProxyPath('/x\ny'), false);
  assert.equal(safeProxyPath(''), false);
});

test('safeProxyPath：★放行逗号（DSH 多模块合并请求）与长路径', () => {
  // 逗号形式：/plugins/??pkg-a/client.js,pkg-b/client.js&rev=x
  const merged = '/plugins/??@deepseek-ai/dsh-client-ui-open-in-app/client.js,@deepseek-ai/dsh-client-ui-shortcuts/client.js&rev=abc';
  assert.equal(safeProxyPath(merged), true, '逗号是合法路径字符');
  // 大量模块合并时路径很长（>2048 曾经被拒）
  const many = '/plugins/??' + Array.from({ length: 200 }, (_, i) => `@scope/pkg-with-long-name-${i}/client.js`).join(',') + '&rev=x';
  assert.ok(many.length > 2048, '构造超长路径');
  assert.equal(safeProxyPath(many), true, '长合并请求应放行');
  // 仍然拒绝真正的非法输入
  assert.equal(safeProxyPath('/x'.repeat(9000)), false, '超上限仍拒绝');
  assert.equal(safeProxyPath('http://evil/a,b'), false);
});

test('sealed 内层 open 的 create 语义等价（rewriteSealedOpen）', () => {
  const ok = rewriteSealedOpen({ path: '/api/session/create', bodyRef: Buffer.from('{}').toString('base64url') }, policy().config);
  assert.equal(ok.ok, true);
  assert.equal(JSON.parse(Buffer.from(ok.body, 'base64url').toString()).agentPreset, 'default');
  const denied = rewriteSealedOpen({ path: '/api/session/create', bodyRef: Buffer.from('{"agentPreset":"x"}').toString('base64url') }, policy().config);
  assert.equal(denied.ok, false);
});
