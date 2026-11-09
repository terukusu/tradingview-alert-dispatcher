import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Dispatcher } from '../src/dispatcher.ts';
import { createApp, MAX_BODY_BYTES } from '../src/server.ts';
import type { Alert, DispatchResult, Notifier } from '../src/types.ts';

const SECRET = 'test-secret-0123456789';
let close: (() => void) | undefined;
afterEach(() => close?.());

async function start() {
  const sent: Alert[] = [];
  const notifier: Notifier = { id: 'fake', type: 'fake', send: async (a) => void sent.push(a) };
  let resolveDone: (r: DispatchResult[]) => void = () => {};
  const done = new Promise<DispatchResult[]>((r) => {
    resolveDone = r;
  });
  const server = createApp({
    webhookSecret: SECRET,
    dispatcher: new Dispatcher([notifier]),
    onDispatched: (_a, results) => resolveDone(results),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  close = () => server.close();
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, sent, done };
}

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

describe('GET /healthz', () => {
  it('200', async () => {
    const { base } = await start();
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });
});
