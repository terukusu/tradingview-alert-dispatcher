import { type AddressInfo, connect } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dispatcher } from '../src/dispatcher.ts';
import { type App, type AppOptions, createApp, MAX_BODY_BYTES } from '../src/server.ts';
import type { Alert, DispatchResult, Notifier } from '../src/types.ts';

const SECRET = 'test-secret-0123456789';
// 架空の銘柄（実際のアラートの本文を書かない）
const FAKE_TITLE = 'EXAMPLE-TICKER-XYZ';
let app: App | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  app?.server.close();
  app?.server.closeAllConnections();
  app = undefined;
});

async function start(
  notifier?: Notifier,
  onDispatched: AppOptions['onDispatched'] | null = undefined,
  extra: Partial<Pick<AppOptions, 'allowedSourceIps'>> = {},
) {
  const sent: Alert[] = [];
  const n: Notifier = notifier ?? {
    id: 'fake',
    type: 'fake',
    send: async (a) => void sent.push(a),
  };
  let resolveDone: (r: DispatchResult[]) => void = () => {};
  const done = new Promise<DispatchResult[]>((r) => {
    resolveDone = r;
  });
  const options: AppOptions = { webhookSecret: SECRET, dispatcher: new Dispatcher([n]) };
  // null = 既定のログを使う
  if (onDispatched !== null) {
    options.onDispatched = onDispatched ?? ((_a, results) => resolveDone(results));
  }
  app = createApp({ ...options, ...extra });
  const { server } = app;
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { app, base, sent, done };
}

/** send が外から終わらせられるまで終わらない偽の経路 */
function pendingNotifier() {
  let release = () => {};
  let markStarted = () => {};
  const started = new Promise<void>((r) => {
    markStarted = r;
  });
  const notifier: Notifier = {
    id: 'slow',
    type: 'fake',
    send: () =>
      new Promise<void>((r) => {
        release = r;
        markStarted();
      }),
  };
  return { notifier, started, release: () => release() };
}

function logLines(spy: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return spy.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('POST /webhook', () => {
  it('?key= で認証して 200、裏で送る', async () => {
    const { base, sent, done } = await start();
    const res = await fetch(`${base}/webhook?key=${SECRET}`, { method: 'POST', body: 'hello' });
    expect(res.status).toBe(200);
    expect(await done).toEqual([expect.objectContaining({ channel: 'fake', ok: true })]);
    expect(sent[0]?.message).toBe('hello');
  });

  it('JSON の secret でも認証できる', async () => {
    const { base, done } = await start();
    const body = JSON.stringify({ secret: SECRET, message: 'hi' });
    const res = await fetch(`${base}/webhook`, { method: 'POST', body });
    expect(res.status).toBe(200);
    await done;
  });

  it('シークレット違い・無しは 401', async () => {
    const { base } = await start();
    expect((await fetch(`${base}/webhook?key=wrong`, { method: 'POST', body: 'x' })).status).toBe(
      401,
    );
    expect((await fetch(`${base}/webhook`, { method: 'POST', body: 'x' })).status).toBe(401);
  });

  it('上限を超える本文は 413', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/webhook?key=${SECRET}`, {
      method: 'POST',
      body: 'a'.repeat(MAX_BODY_BYTES + 1),
    });
    expect(res.status).toBe(413);
  });

  it('空の本文は 400、GET は 405、ほかのパスは 404', async () => {
    const { base } = await start();
    expect(
      (await fetch(`${base}/webhook?key=${SECRET}`, { method: 'POST', body: ' ' })).status,
    ).toBe(400);
    expect((await fetch(`${base}/webhook`)).status).toBe(405);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});

// 壊れた JSON（JSON.parse できない本文）。値はすべて架空
describe('壊れた JSON の本文', () => {
  const OTHER = 'other-secret-value';
  const broken = (secret: string) =>
    `{"secret":"${secret}","title":"${FAKE_TITLE}","message":"XYZ "test" 1.5"}`;

  it('壊れた JSON の secret でも認証して 200、LINE に secret を送らない', async () => {
    const { base, sent, done } = await start();
    const body = broken(SECRET);
    expect(() => JSON.parse(body)).toThrow();
    const res = await fetch(`${base}/webhook`, { method: 'POST', body });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('accepted');
    expect(await done).toEqual([expect.objectContaining({ channel: 'fake', ok: true })]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.title).toBeUndefined();
    expect(sent[0]?.message).toContain('XYZ "test" 1.5');
    expect(sent[0]?.message).not.toContain(SECRET);
    expect(sent[0]?.message).not.toContain('"secret"');
  });

  it('壊れた JSON の secret が違えば 401 で送らない', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { base, sent } = await start();
    for (const secret of [OTHER, `${SECRET}x`, SECRET.slice(0, -1)]) {
      const res = await fetch(`${base}/webhook`, { method: 'POST', body: broken(secret) });
      expect(res.status).toBe(401);
      expect(await res.text()).toBe('unauthorized');
    }
    await sleep(20);
    expect(sent).toEqual([]);
  });

  it('?key= で認証した壊れた JSON でも secret を送らない', async () => {
    const { base, sent, done } = await start();
    const res = await fetch(`${base}/webhook?key=${SECRET}`, {
      method: 'POST',
      body: broken(OTHER),
    });
    expect(res.status).toBe(200);
    await done;
    expect(sent[0]?.message).toContain('XYZ "test" 1.5');
    expect(sent[0]?.message).not.toContain(OTHER);
    expect(sent[0]?.message).not.toContain('"secret"');
  });

  it('壊れた JSON のときもログに本文・secret を出さない', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { app, base } = await start(undefined, null);
    const ok = await fetch(`${base}/webhook`, { method: 'POST', body: broken(SECRET) });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('accepted');
    const ng = await fetch(`${base}/webhook`, { method: 'POST', body: broken(OTHER) });
    expect(ng.status).toBe(401);
    expect(await ng.text()).toBe('unauthorized');
    await app.shutdown();
    const lines = logLines(spy);
    const dispatched = lines.filter((l) => l.msg === 'dispatched');
    expect(dispatched).toHaveLength(1);
    expect(Object.keys(dispatched[0] ?? {}).sort()).toEqual(['msg', 'results', 'severity']);
    expect(lines).toContainEqual({ severity: 'WARNING', msg: 'unauthorized' });
    for (const call of spy.mock.calls) {
      for (const v of [SECRET, OTHER, FAKE_TITLE, '1.5']) expect(String(call[0])).not.toContain(v);
    }
  });
});

describe('GET /health', () => {
  it('GET /health は 200 で本文 ok', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('GET /healthz は 404', async () => {
    const { base } = await start();
    expect((await fetch(`${base}/healthz`)).status).toBe(404);
    expect((await fetch(`${base}/health`, { method: 'POST' })).status).toBe(404);
  });
});

describe('ログ', () => {
  it('dispatched のログに title を出さない', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { app, base } = await start(undefined, null);
    const body = JSON.stringify({ secret: SECRET, title: FAKE_TITLE, message: 'price 123.45' });
    expect((await fetch(`${base}/webhook`, { method: 'POST', body })).status).toBe(200);
    await app.shutdown();
    const dispatched = logLines(spy).filter((l) => l.msg === 'dispatched');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).not.toHaveProperty('title');
    expect(Object.keys(dispatched[0] ?? {}).sort()).toEqual(['msg', 'results', 'severity']);
    for (const call of spy.mock.calls) {
      expect(String(call[0])).not.toContain(FAKE_TITLE);
      expect(String(call[0])).not.toContain('123.45');
      expect(String(call[0])).not.toContain(SECRET);
    }
  });

  it('unauthorized のログは severity WARNING', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { base } = await start();
    expect((await fetch(`${base}/webhook`, { method: 'POST', body: 'x' })).status).toBe(401);
    expect(logLines(spy)).toContainEqual({ severity: 'WARNING', msg: 'unauthorized' });
  });
});

// 値は文書用の架空の IP（RFC 5737・RFC 3849）
describe('送信元 IP の許可リスト', () => {
  const ALLOWED = '192.0.2.1';
  const ATTACKER = '203.0.113.9';
  const allow = { allowedSourceIps: [ALLOWED] };
  const post = (base: string, xff: string | undefined, query = `?key=${SECRET}`, body = 'hello') =>
    fetch(`${base}/webhook${query}`, {
      method: 'POST',
      body,
      headers: xff === undefined ? {} : { 'X-Forwarded-For': xff },
    });

  it('許可リスト外の送信元 IP は正しいシークレットでも 403 で LINE に送らない', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    let dispatched = 0;
    const { app, base, sent } = await start(undefined, () => void dispatched++, allow);
    const res = await post(base, ATTACKER);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('forbidden');
    await app.shutdown();
    expect(sent).toHaveLength(0);
    expect(dispatched).toBe(0);
  });

  it('許可リスト内の送信元 IP は従来どおり 200 で送る', async () => {
    const { base, sent, done } = await start(undefined, undefined, allow);
    const res = await post(base, ALLOWED);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('accepted');
    await done;
    expect(sent).toHaveLength(1);
    expect(sent[0]?.message).toBe('hello');
  });

  it('許可リスト内の送信元 IP でもシークレット違いは 401', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { app, base, sent } = await start(undefined, undefined, allow);
    const res = await post(base, ALLOWED, '?key=wrong');
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('unauthorized');
    expect((await post(base, ALLOWED, '')).status).toBe(401);
    await app.shutdown();
    expect(sent).toHaveLength(0);
  });

  it('X-Forwarded-For の先頭の偽装は無視し末尾の値で判定する', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { base, sent, done } = await start(undefined, undefined, allow);
    expect((await post(base, `${ALLOWED}, ${ATTACKER}`)).status).toBe(403);
    expect((await post(base, `${ATTACKER}, ${ALLOWED}`)).status).toBe(200);
    await done;
    expect(sent).toHaveLength(1);
  });

  it('X-Forwarded-For の末尾が空なら 403', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { app, base, sent } = await start(undefined, undefined, allow);
    for (const xff of [`${ALLOWED},`, `${ALLOWED}, `, '']) {
      expect((await post(base, xff)).status).toBe(403);
    }
    await app.shutdown();
    expect(sent).toHaveLength(0);
  });

  it('X-Forwarded-For が 2 行で届いたら、末尾が許可リストの IP でも 403', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { app, base, sent } = await start(undefined, undefined, allow);
    const { port } = new URL(base);
    // fetch はヘッダを 1 行にまとめるので、生の HTTP で 2 行のヘッダを送る
    const socket = connect(Number(port), '127.0.0.1');
    await new Promise((r) => socket.once('connect', r));
    let received = '';
    socket.setEncoding('utf8');
    socket.on('data', (d: string) => {
      received += d;
    });
    const closed = new Promise((r) => socket.once('close', r));
    socket.end(
      `POST /webhook?key=${SECRET} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n` +
        `X-Forwarded-For: ${ATTACKER}\r\nX-Forwarded-For: ${ALLOWED}\r\n` +
        'Content-Length: 5\r\n\r\nhello',
    );
    await closed;
    expect(received).toMatch(/^HTTP\/1\.1 403 /);
    await app.shutdown();
    expect(sent).toHaveLength(0);
  });

  it('X-Forwarded-For が無いときは接続元のアドレスで判定する', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const a = await start(undefined, undefined, { allowedSourceIps: ['127.0.0.1'] });
    expect((await post(a.base, undefined)).status).toBe(200);
    await a.done;
    expect(a.sent).toHaveLength(1);
    a.app.server.close();
    a.app.server.closeAllConnections();

    const b = await start(undefined, undefined, allow);
    expect((await post(b.base, undefined)).status).toBe(403);
    await b.app.shutdown();
    expect(b.sent).toHaveLength(0);
  });

  it('IPv6 の送信元は 403', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { app, base, sent } = await start(undefined, undefined, allow);
    expect((await post(base, '2001:db8::1')).status).toBe(403);
    await app.shutdown();
    expect(sent).toHaveLength(0);
  });

  it('許可リストが空なら送信元 IP で制限しない', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { base, sent, done } = await start(undefined, undefined, { allowedSourceIps: [] });
    expect((await post(base, ATTACKER)).status).toBe(200);
    await done;
    expect(sent).toHaveLength(1);
    expect((await post(base, ATTACKER, '')).status).toBe(401);
  });

  it('GET /health は許可リスト外の送信元 IP でも 200', async () => {
    const { base } = await start(undefined, undefined, allow);
    const res = await fetch(`${base}/health`, { headers: { 'X-Forwarded-For': ATTACKER } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('許可リスト外の送信元 IP は本文を読む前に 403', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { app, base, sent } = await start(undefined, undefined, allow);
    const res = await post(base, ATTACKER, `?key=${SECRET}`, 'a'.repeat(MAX_BODY_BYTES + 1));
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('forbidden');
    await app.shutdown();
    expect(sent).toHaveLength(0);
  });

  it('許可リスト外の送信元 IP はほかのパス・メソッドも 403', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { base } = await start(undefined, undefined, allow);
    const headers = { 'X-Forwarded-For': ATTACKER };
    expect((await fetch(`${base}/webhook`, { headers })).status).toBe(403);
    expect((await fetch(`${base}/other`, { method: 'POST', body: 'x', headers })).status).toBe(403);
    expect((await fetch(`${base}/health`, { method: 'POST', body: 'x', headers })).status).toBe(
      403,
    );
  });

  it('forbidden のログは severity WARNING で送信元 IP・本文・シークレットを出さない', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { app, base } = await start(undefined, undefined, allow);
    const body = JSON.stringify({ secret: SECRET, title: FAKE_TITLE, message: 'price 123.45' });
    expect((await post(base, ATTACKER, `?key=${SECRET}`, body)).status).toBe(403);
    await app.shutdown();
    const lines = logLines(spy);
    expect(lines).toContainEqual({ severity: 'WARNING', msg: 'forbidden' });
    for (const call of spy.mock.calls) {
      for (const v of [ATTACKER, FAKE_TITLE, '123.45', SECRET]) {
        expect(String(call[0])).not.toContain(v);
      }
    }
  });
});

describe('終了の処理', () => {
  it('終了の処理は新しい接続を受けず、送信中の配信を待ってから終わる', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const order: string[] = [];
    const slow = pendingNotifier();
    const { app, base } = await start(slow.notifier, () => void order.push('onDispatched'));
    const res = await fetch(`${base}/webhook?key=${SECRET}`, {
      method: 'POST',
      body: 'hello',
      headers: { Connection: 'close' },
    });
    expect(res.status).toBe(200);
    await slow.started;

    const p = app.shutdown().then((r) => {
      order.push('shutdown');
      return r;
    });
    expect(app.shutdown()).toBe(app.shutdown()); // 何度呼んでも同じ Promise
    await sleep(50);
    expect(order).toEqual([]); // 配信が終わるまで終わらない
    await expect(fetch(`${base}/health`)).rejects.toThrow(); // 新しい接続を受けない

    slow.release();
    expect(await p).toEqual({ remaining: 0 });
    expect(order).toEqual(['onDispatched', 'shutdown']);
    expect(logLines(spy)).toContainEqual({ severity: 'INFO', msg: 'shutdown', remaining: 0 });
  });

  it('終了の処理は待ちの上限で打ち切り、残りの件数をログに出す', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const never: Notifier = { id: 'never', type: 'fake', send: () => new Promise(() => {}) };
    const { app, base } = await start(never, null);
    const body = JSON.stringify({ secret: SECRET, title: FAKE_TITLE, message: 'price 123.45' });
    const res = await fetch(`${base}/webhook`, {
      method: 'POST',
      body,
      headers: { Connection: 'close' },
    });
    expect(res.status).toBe(200);

    const started = performance.now();
    expect(await app.shutdown(50)).toEqual({ remaining: 1 });
    expect(performance.now() - started).toBeLessThan(1000);
    expect(logLines(spy)).toContainEqual({
      severity: 'WARNING',
      msg: 'shutdown timeout',
      remaining: 1,
    });
    for (const call of spy.mock.calls) {
      expect(String(call[0])).not.toContain(FAKE_TITLE);
      expect(String(call[0])).not.toContain('123.45');
    }
  });

  it('終了中に既存の接続で届いたリクエストは 503 で配信しない', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const slow = pendingNotifier();
    let dispatched = 0;
    const { app } = await start(slow.notifier, () => void dispatched++);
    const { port } = app.server.address() as AddressInfo;
    // 1 本の keep-alive の接続で、1 件目の本文を送っている途中に終了の処理を始め、続けて 2 件目を送る
    const socket = connect(port, '127.0.0.1');
    await new Promise((r) => socket.once('connect', r));
    const closed = new Promise((r) => socket.once('close', r));
    let received = '';
    socket.setEncoding('utf8');
    socket.on('data', (d: string) => {
      received += d;
    });
    const head = (body: string) =>
      `POST /webhook?key=${SECRET} HTTP/1.1\r\nHost: x\r\nContent-Length: ${body.length}\r\n\r\n`;
    const firstArrived = new Promise((r) => app.server.once('request', r));
    socket.write(`${head('first')}fir`);
    await firstArrived; // 1 件目のヘッダが届いて request が始まるのを待つ（時間に頼らない）
    const p = app.shutdown(1000);
    socket.write(`st${head('second')}second`);
    await closed; // 503 の Connection: close で閉じる
    slow.release();
    expect(await p).toEqual({ remaining: 0 });
    expect(received).toMatch(/^HTTP\/1\.1 200 [\s\S]*HTTP\/1\.1 503 /);
    expect(dispatched).toBe(1);
  });
});
