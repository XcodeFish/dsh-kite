/**
 * 丢帧观测（P0，2026-10-01）。
 *
 * 背景：客户端报「session assistant stream skipped revision N」时，中继侧**零证据** ——
 * send() 的 false 被忽略、超大入站帧被静默 return、maxPayload 错误无人接、
 * 积压断桥只打一行日志不计数。诊断「差一帧」缺的就是这些计数。
 *
 * 本测试刻意只断言**外部可观测面**（/healthz 与 /metrics），不碰内部结构：
 * 真子进程 + 真 WebSocket，把中继当成一个黑盒。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RELAY_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'relay', 'server.mjs');
const TOKEN = 'ra-test-token-0123456789abcdef';
const FRAME_LIMIT = 1024 * 1024;

let port = 0;

function startRelay() {
  const child = spawn(process.execPath, [RELAY_SCRIPT], {
    env: { ...process.env, PORT: '0', RELAY_TOKENS: TOKEN },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return new Promise((resolve, reject) => {
    // 超时必须杀掉子进程：孤儿 relay 会钉住 stdio 管道，让 runner 永不退出。
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('relay start timeout'));
    }, 8000);
    child.stdout.on('data', (chunk) => {
      const match = /listening on [^ ]+:(\d+)/.exec(String(chunk));
      if (match) {
        port = Number(match[1]);
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.stderr.on('data', (chunk) => process.stderr.write(`[relay] ${chunk}`));
    child.on('exit', (code) => reject(new Error(`relay exited early: ${code}`)));
  });
}

async function health() {
  const res = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(res.status, 200);
  return res.json();
}

async function metricsText() {
  return await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
}

function connectConnector(id = 'test-connector') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/connector?c=${id}`, ['ra.v1', `ra-bearer.${TOKEN}`]);
    const timer = setTimeout(() => reject(new Error('connector handshake timeout')), 5000);
    ws.onmessage = (event) => {
      const frame = JSON.parse(String(event.data));
      if (frame.kind === 'hello-ack') {
        clearTimeout(timer);
        resolve(ws);
      }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('connector ws error')); };
  });
}

test('丢帧观测：观测面孔径齐全，且空闲时为 0', async () => {
  const relay = await startRelay();
  try {
    const h = await health();
    assert.equal(h.dropped, 0, '空闲中继不该有丢帧');
    assert.deepEqual(h.droppedByReason, {});
    assert.equal(h.largestFrameBytes, 0);
    assert.equal(h.frameLimitBytes, FRAME_LIMIT);

    const text = await metricsText();
    assert.match(text, /ra_relay_dropped_total 0/);
    assert.match(text, /ra_relay_largest_frame_bytes 0/);
    assert.match(text, /ra_relay_frame_limit_bytes \d+/);
  } finally {
    relay.kill('SIGKILL');
  }
});

test('丢帧观测：干净握手不产生任何丢帧（防埋点假阳性）', async () => {
  const relay = await startRelay();
  try {
    const connector = await connectConnector('clean-connector');
    // 一条正常的小帧：走通往返但不该被记为丢帧。
    connector.send(JSON.stringify({ kind: 'connector-route', deviceIds: [] }));
    await new Promise((resolve) => setTimeout(resolve, 150));

    const h = await health();
    assert.equal(h.dropped, 0, `干净握手后不该有丢帧，实际 ${JSON.stringify(h.droppedByReason)}`);
    assert.equal(h.connectors, 1);

    // 正常关闭（1000/1001）不计入 dropped，只进 closesByCode。
    connector.close(1000, 'done');
    await new Promise((resolve) => setTimeout(resolve, 200));
    const after = await health();
    assert.equal(after.dropped, 0, '正常关闭不该被算成丢帧');
  } finally {
    relay.kill('SIGKILL');
  }
});

test('丢帧观测：超大入站帧不再无声 —— 被计数，且中继存活', async () => {
  const relay = await startRelay();
  try {
    const connector = await connectConnector('oversize-connector');

    // 超过 MAX_FRAME_BYTES 但远小于 maxPayload：现在会走到应用层被处理。
    //
    // ★ 这一条同时是「maxPayload 与应用层上限解耦」的回归门：
    //   两者相等时（旧实现），这个帧会在 ws 解析层被拒 → 连接以 1009 掐断
    //   → connectors 掉到 0、dropped 记成 ws_error（连体积都记不下来）。
    //   解耦后，连接活着、被计成 inbound_frame_too_large、体积也记得下来。
    //   真机事故 2026-10-01：大会话 snapshot 过中继 935KB（上限 89.2%），
    //   一旦越界就是这个「整条连接死」的路径。
    connector.send('x'.repeat(FRAME_LIMIT + 4096));
    await new Promise((resolve) => setTimeout(resolve, 400));

    const h = await health();
    assert.ok(h.dropped >= 1, `超大帧必须被计数，实际 dropped=${h.dropped}`);
    assert.ok(
      h.droppedByReason.inbound_frame_too_large >= 1,
      `必须归因到应用层的 inbound_frame_too_large，实际 ${JSON.stringify(h.droppedByReason)}`
    );
    assert.equal(h.ok, true, '中继必须存活（可用性组件不能因一帧死掉）');
    assert.equal(h.connectors, 1, '★ 超大帧不得掐断连接（maxPayload 必须大于应用层上限）');
    assert.equal(h.largestFrameBytes >= FRAME_LIMIT, true, '应用层必须能看到超限帧的真实体积');

    const text = await metricsText();
    assert.match(text, /ra_relay_dropped_by_reason_total\{reason="[a-z_]+"\} \d+/);
    assert.match(text, new RegExp(`ra_relay_wire_frame_limit_bytes ${16 * 1024 * 1024}`));
  } finally {
    relay.kill('SIGKILL');
  }
});

test('丢帧观测：/metrics 输出是合法 Prometheus 文本（含已有丢帧样本时）', async () => {
  const relay = await startRelay();
  try {
    // ★ 必须制造**两个不同 reason** 再检查：
    //   初版把 `# TYPE` 行写在 per-reason 循环里 —— 只有一个 reason 时完全看不出问题，
    //   两个才会出现重复 TYPE 行。这就是「测试必须有能力失败」的具体含义。
    const oversize = await connectConnector('metrics-shape-a');
    oversize.send('x'.repeat(FRAME_LIMIT + 4096));           // → reason=ws_error
    await new Promise((resolve) => setTimeout(resolve, 200));
    const badJson = await connectConnector('metrics-shape-b');
    badJson.send('这不是 JSON');                              // → reason=bad_json
    await new Promise((resolve) => setTimeout(resolve, 300));

    const text = await metricsText();
    const reasons = [...text.matchAll(/ra_relay_dropped_by_reason_total\{reason="([a-z_]+)"\}/g)].map((m) => m[1]);
    assert.ok(reasons.length >= 2, `应已产生至少两个不同 reason，实际 ${JSON.stringify(reasons)}`);
    for (const line of text.split('\n')) {
      if (!line || line.startsWith('#')) continue;
      assert.match(line, /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})? -?\d+(\.\d+)?$/, `非法指标行: ${line}`);
    }
    const typeLines = text.split('\n').filter((l) => l.startsWith('# TYPE'));
    assert.equal(new Set(typeLines).size, typeLines.length, 'TYPE 行有重复');
  } finally {
    relay.kill('SIGKILL');
  }
});
