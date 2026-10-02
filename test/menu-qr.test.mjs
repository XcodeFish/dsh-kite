import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { qrMatrix, pickVersion, buildDataCodewords, VERSION_TABLE, CAPACITY_M } from '../admin/qr.js';
import { menuEntryRows, CLIENT_SOURCE } from '../admin/menu-entry.js';
import { deviceCookie } from '../identity/pairing.js';

test('QR：选版边界与容量表一致', () => {
  assert.equal(pickVersion(1), 1);
  assert.equal(pickVersion(14), 1, 'v1-M 恰好 14 字符');
  assert.equal(pickVersion(15), 2);
  assert.equal(pickVersion(26), 2);
  assert.equal(pickVersion(213), 10);
  assert.throws(() => pickVersion(214), /too large/);
});

test('QR：容量表 = 数据码字 − 头部开销（mode+count 位按字节进位）', () => {
  for (let v = 1; v <= 10; v += 1) {
    const [, g1, g2, ecPerBlock] = VERSION_TABLE[v - 1];
    const dataTotal = g1[0] * g1[1] + (g2 ? g2[0] * g2[1] : 0);
    const blocks = g1[0] + (g2 ? g2[0] : 0);
    const countBits = v <= 9 ? 8 : 16;
    assert.equal(dataTotal + blocks * ecPerBlock, VERSION_TABLE[v - 1][0], `v${v} 总码字自洽`);
    const expectedCap = dataTotal - Math.ceil((4 + countBits) / 8);
    assert.equal(CAPACITY_M[v], expectedCap, `v${v} 容量`);
    assert.equal(pickVersion(CAPACITY_M[v]), v);
  }
});

test('QR：尺寸公式 4v+17 与 finder/timing/dark module 结构', () => {
  const sample = 'https://relay.example.com/kite/pair?token=AbCdEf123456&name=phone&c=0123456789abcdef0123456789abcdef';
  const qr = qrMatrix(sample);
  assert.equal(qr.size, 4 * qr.version + 17);
  for (let i = 0; i < 7; i += 1) {
    assert.equal(qr.get(i, 0), true, `top edge (${i},0)`);
    assert.equal(qr.get(0, i), true, `left edge (0,${i})`);
    assert.equal(qr.get(i, 6), true, 'finder row 6');
    assert.equal(qr.get(6, i), true, 'finder col 6');
  }
  // 次圈（ring 2）为亮：行 1 / 列 1 的 (1..5,1)/(1,1..5)
  for (let i = 2; i <= 4; i += 1) {
    assert.equal(qr.get(i, 1), false, `finder white ring (${i},1)`);
    assert.equal(qr.get(1, i), false, `finder white ring (1,${i})`);
  }
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) assert.equal(qr.get(3 + dx, 3 + dy), true, 'finder center');
  }
  // timing：只查 [8,16) 段（最小对齐图案从 col/row 16 起，之后 timing 被对齐图案合法覆盖）
  for (const x of [8, 10, 12, 14]) {
    assert.equal(qr.get(x, 6), true, `timing col ${x}`);
    assert.equal(qr.get(6, x), true, `timing row ${x}`);
  }
  assert.equal(qr.get(8, qr.size - 8), true, 'dark module');
});

test('QR：alignment 图案结构（v2 中心 (18,18)）', () => {
  const qr = qrMatrix('https://relay.example.com/'); // 26 字符 → v2
  assert.equal(qr.version, 2);
  assert.equal(qr.size, 25);
  assert.equal(qr.get(18, 18), true, 'alignment center dark');
  assert.equal(qr.get(17, 18), false, 'alignment inner ring light');
  assert.equal(qr.get(19, 18), false, 'alignment inner ring light');
  assert.equal(qr.get(18, 17), false, 'alignment inner ring light');
  assert.equal(qr.get(16, 18), true, 'alignment outer ring dark');
  assert.equal(qr.get(20, 18), true, 'alignment outer ring dark');
  assert.equal(qr.get(18, 16), true, 'alignment outer ring dark');
  assert.equal(qr.get(18, 20), true, 'alignment outer ring dark');
});

test('QR：finder 分隔符全亮（ring=4 的 7px 环绕为亮）', () => {
  const qr = qrMatrix('hello-world');
  // 左上 finder 左侧/上侧 separator（x=-1 不存在，检查 ring 边界内側外的行/列亮带）
  for (let i = 0; i < 8; i += 1) {
    assert.equal(qr.get(7, i), false, `separator col7 row${i}`);
    assert.equal(qr.get(i, 7), false, `separator row7 col${i}`);
  }
});

test('QR：确定性 —— 同输入同矩阵', () => {
  const url = 'https://relay.example.com/kite/pair?token=x'.repeat(3);
  const a = qrMatrix(url);
  const b = qrMatrix(url);
  assert.equal(a.size, b.size);
  for (let y = 0; y < a.size; y += 1) {
    for (let x = 0; x < a.size; x += 1) {
      assert.equal(a.get(x, y), b.get(x, y), `(${x},${y})`);
    }
  }
});

test('QR：UTF-8 中文配对链接可编码', () => {
  const cn = 'https://r.example.com/pair?token=' + 'x'.repeat(60) + '&name=' + encodeURIComponent('我的手机');
  const qr = qrMatrix(cn);
  assert.ok(qr.size >= 25);
});

test('QR：v1 数据码字手工核对（2 字符样例）', () => {
  // 'AB'：0100(mode) 00000010(count8) 01000001('A') 01000010('B') 0000(term)
  // → 01000000 00100100 00010100 00100000 = 0x40 0x24 0x14 0x20；v1-M 16 数据码字按 EC/11 填充
  const words = buildDataCodewords([0x41, 0x42], 1);
  assert.deepEqual(words.slice(0, 4), [0x40, 0x24, 0x14, 0x20]);
  assert.equal(words.length, 16);
  assert.deepEqual(words.slice(4), [0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11]);
});

test('菜单入口：注入 global(入口URL) + 内联面板客户端脚本', () => {
  const rows = menuEntryRows({ authedUrl: '/kite?kite_token=t' });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, 'global');
  assert.equal(rows[0].name, '__DSH_KITE_AUTH__');
  assert.equal(rows[0].value.url, '/kite?kite_token=t');
  assert.equal(rows[1].kind, 'script');
  assert.equal(rows[1].placement, 'body');
  assert.match(rows[1].text, /dsh-ra-menu-entry/);
  assert.match(rows[1].text, /__DSH_KITE_AUTH__/);
});

/**
 * 侧栏半包（admin/sidebar-entry.js）的执行夹具。
 *
 * 它是经典脚本，必须自行调用 `window.__ModuleLoader__.load({ id: <包名>, factory })`；
 * 宿主侧 graph row 的 id 取自 Loader 行的包名，arrive() 校验的正是它 —— 所以这里
 * 用一个假的 __ModuleLoader__ 捕获注册，再手动执行工厂，模拟真实物化过程。
 */
function loadSidebarBundle() {
  const registered = [];
  const sandbox = {
    window: { __ModuleLoader__: { load: (reg) => registered.push(reg) } },
    document: {
      getElementById: () => null,
      createElement: () => ({ id: '', textContent: '' }),
      head: { appendChild: () => {} },
      documentElement: { appendChild: () => {} }
    },
    require: () => {
      throw new Error('unexpected require');
    }
  };
  const source = readFileSync(new URL('../admin/sidebar-entry.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, sandbox, { filename: 'admin/sidebar-entry.js' });
  return { registered, sandbox };
}

/** 最小 React 替身：只记录元素树，足以断言宽/窄两态的渲染结果。 */
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.filter((c) => c !== null && c !== undefined) })
};

/** 物化侧栏半包并完成一次槽位注册，返回 { component, calls, sandbox }。 */
function mountSidebarEntry() {
  const { registered, sandbox } = loadSidebarBundle();
  const face = registered[0].factory((spec) => {
    if (spec === 'react') return reactStub;
    throw new Error(`unexpected require: ${spec}`);
  });
  const calls = [];
  face.apply({ slots: { inject: (key, cb) => calls.push({ key, cb }), register: (opts, component) => ({ opts, component }) } });
  return { face, component: calls[0].cb().component, calls, sandbox };
}

test('侧栏入口：以包名 dsh-kite 注册模块工厂（id 必须是包名，否则宿主报 not-registered）', () => {
  const { registered } = loadSidebarBundle();
  assert.equal(registered.length, 1, '恰好注册一个模块');
  assert.equal(registered[0].id, 'dsh-kite', '注册 id = 包名（graph row id 的来源）');
  assert.equal(typeof registered[0].factory, 'function');
});

test('侧栏入口：注册 sidebar.footer.action 槽，order 20 落在上下文洞察（10）下方', () => {
  const { face, component, calls } = mountSidebarEntry();
  // 逐元素断言：face 来自 vm 沙箱，其数组原型与宿主 realm 不同，deepStrictEqual 会误报。
  assert.equal(face.inject.length, 1, '只注入 slots');
  assert.equal(face.inject[0], 'slots');

  assert.equal(calls.length, 1, '恰好注册一个槽位');
  assert.equal(calls[0].key, 'sidebar.footer.action', '槽位名 = 侧栏底部 action 槽');
  const entry = calls[0].cb();
  assert.equal(entry.opts.name, 'sidebar.footer.action');
  assert.equal(entry.opts.id, 'kite-entry', 'list 槽必须有 id');
  assert.equal(entry.opts.order, 20, 'order 必须 > 10（上下文洞察）');
  assert.ok(!('priority' in entry.opts), '不得改 priority：会遮蔽其它插件的条目');
  assert.equal(component, entry.component);
});

test('侧栏入口：宽/窄两态渲染 —— 窄态只出图标且带 aria-label', () => {
  const { component } = mountSidebarEntry();

  const wide = component({ wide: true });
  assert.equal(wide.type, 'button');
  assert.equal(wide.props.className, 'dsh-kite-entry', '宽态用带标签的样式');
  assert.equal(wide.props['aria-label'], '手机远程访问');
  assert.equal(wide.children.length, 2, '宽态 = 图标 + 文案');
  assert.equal(wide.children[1].children[0], '手机远程');

  const rail = component({ wide: false });
  assert.equal(rail.props.className, 'dsh-kite-entry dsh-kite-entry-rail', '窄态退化为 36px 圆形');
  assert.equal(rail.children.length, 1, '窄态只出图标');
  assert.equal(rail.props['aria-label'], '手机远程访问', '窄态仍可被读屏定位');
});

test('侧栏入口：点击三级回退，且绝不做顶层导航', () => {
  const { component, sandbox } = mountSidebarEntry();

  // ① 优先调用 panel-client 暴露的全局
  let opened = 0;
  sandbox.window.__DSH_KITE_OPEN__ = () => { opened += 1; };
  component({ wide: true }).props.onClick();
  assert.equal(opened, 1, '① 全局存在时优先走它');

  // ② 全局缺失 → 退化为点击右下角悬浮按钮
  let clicked = 0;
  sandbox.document.getElementById = (id) => (id === 'dsh-ra-menu-entry' ? { click: () => { clicked += 1; } } : null);
  delete sandbox.window.__DSH_KITE_OPEN__;
  component({ wide: true }).props.onClick();
  assert.equal(clicked, 1, '② 全局缺失时点击悬浮按钮');

  // ③ 两者都不可用 → 静默，不抛错
  sandbox.document.getElementById = () => null;
  assert.doesNotThrow(() => component({ wide: true }).props.onClick(), '③ 全不可用时静默');

  // 源码级：任何情况下都不得顶层导航（webview 顶层导航不带宿主 cookie → 401 白页）
  const code = stripComments(readFileSync(new URL('../admin/sidebar-entry.js', import.meta.url), 'utf8'));
  assert.doesNotMatch(code, /location\.href\s*=/, '不得做顶层导航');
  assert.doesNotMatch(code, /location\.assign|location\.replace|window\.open/, '不得用导航或 popup');
});

/** 去掉注释行后再断言，避免注释里的历史教训文本造成误报。 */
function stripComments(source) {
  return source.split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
}

test('面板客户端：零 iframe / 零顶层导航（只依赖父页面 fetch）', () => {
  const code = stripComments(CLIENT_SOURCE);
  assert.doesNotMatch(code, /createElement\(\s*['"]iframe['"]/, '不得使用 iframe');
  assert.doesNotMatch(code, /location\.href\s*=/, '不得做顶层导航');
  assert.doesNotMatch(code, /window\.open/, '不得用 popup');
  assert.match(code, /fetch\(/, '必须走父页面 fetch');
  assert.match(code, /kite\/api/, 'API 基准路径');
});

test('面板客户端：中文文案与关键控件齐备', () => {
  for (const needle of ['手机远程', '生成配对二维码', '撤销全部设备', '紧急停用', '运行探针', '等待手机提交']) {
    assert.ok(CLIENT_SOURCE.includes(needle), `缺少文案/控件：${needle}`);
  }
});

test('设备 cookie：secure 开关（ws:// 本地联调不发 Secure）', () => {
  assert.match(deviceCookie('ra-device', 'v1.a.b', 3600, true), /; Secure$/);
  assert.doesNotMatch(deviceCookie('ra-device', 'v1.a.b', 3600, false), /Secure/);
  assert.match(deviceCookie('ra-device', 'v1.a.b', 3600, false), /HttpOnly; SameSite=Lax/);
});
