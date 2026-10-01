import test from 'node:test';
import assert from 'node:assert/strict';
import { LoopbackCredential } from '../proxy/loopback-credential.js';

function withFetch(stub, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.fetch = original;
    });
}

function fakeAdapter(port) {
  return {
    webServerPort: () => port,
    authenticatedUrl: (base) => `${base}?token=launch-token`
  };
}

function response303(cookie) {
  return new Response(null, { status: 303, headers: { location: './', 'set-cookie': cookie } });
}

test('凭据：303 交换成功，取第一个 cookie 对', async () => {
  const credential = new LoopbackCredential(fakeAdapter(60658), console);
  await withFetch(async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return response303('dsh-auth-abc123=v1.x.y; Max-Age=100; Path=/; HttpOnly');
    };
    const { base, cookie } = await credential.acquire();
    assert.equal(base, 'http://127.0.0.1:60658');
    assert.equal(cookie, 'dsh-auth-abc123=v1.x.y');
    assert.equal(calls, 1);
    // 二次 acquire 不再发请求（内存缓存）
    await credential.acquire();
    assert.equal(calls, 1);
  });
});

test('凭据：非 303 必须抛错而非静默继续', async () => {
  const credential = new LoopbackCredential(fakeAdapter(1), console);
  await withFetch(async () => {
    globalThis.fetch = async () => new Response('unauthorized', { status: 401 });
    await assert.rejects(() => credential.acquire(), /HTTP 401/);
  });
  await withFetch(async () => {
    globalThis.fetch = async () => new Response(null, { status: 200 });
    await assert.rejects(() => credential.acquire(), /HTTP 200/);
  });
});

test('凭据：303 但无 dsh-auth cookie 必须抛错', async () => {
  const credential = new LoopbackCredential(fakeAdapter(2), console);
  await withFetch(async () => {
    globalThis.fetch = async () => response303('other-cookie=x; Path=/');
    await assert.rejects(() => credential.acquire(), /no dsh-auth cookie/);
  });
});

test('凭据：webServer 端口缺失必须抛错（扩展点探针失败面）', async () => {
  const credential = new LoopbackCredential({ webServerPort: () => undefined, authenticatedUrl: (b) => b }, console);
  await withFetch(async () => {
    await assert.rejects(() => credential.acquire(), /port unavailable/);
  });
});

test('凭据：authenticatedUrl 不可用必须抛错（connection 服务缺失面）', async () => {
  const credential = new LoopbackCredential({ webServerPort: () => 3, authenticatedUrl: () => undefined }, console);
  await withFetch(async () => {
    await assert.rejects(() => credential.acquire(), /authenticatedUrl/);
  });
});

test('凭据：invalidate 后重新交换', async () => {
  const credential = new LoopbackCredential(fakeAdapter(4), console);
  await withFetch(async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return response303(`dsh-auth-k${calls}=v1; Path=/`);
    };
    await credential.acquire();
    credential.invalidate();
    await credential.acquire();
    assert.equal(calls, 2);
  });
});
