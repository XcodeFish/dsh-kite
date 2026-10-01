import test from 'node:test';
import assert from 'node:assert/strict';
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
