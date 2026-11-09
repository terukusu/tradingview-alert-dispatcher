import { describe, expect, it } from 'vitest';
import { LINE_MAX_TEXT, LineNotifier } from '../../src/notifiers/line.ts';
import type { Alert } from '../../src/types.ts';

// 架空の ID（実在の userId を書かない）
const U1 = `U${'0'.repeat(32)}`;
const U2 = `U${'1'.repeat(32)}`;
const env = { LINE_CHANNEL_ACCESS_TOKEN: 'test-token' };
const alert: Alert = { title: 'T', message: 'M', channels: undefined, receivedAt: new Date(0) };

interface Call {
  url: string;
  headers: Record<string, string>;
  body: { to?: string | string[]; messages: { type: string; text: string }[] };
}

function fakeFetch(responses: (number | Error)[]) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(init.body as string),
    });
    const r = responses.shift() ?? 200;
    if (r instanceof Error) throw r;
    return new Response(r === 200 ? '{}' : JSON.stringify({ message: `err ${r}` }), { status: r });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function notifier(to: string[] | undefined, responses: (number | Error)[] = []) {
  const f = fakeFetch(responses);
  const config = to
    ? { id: 'line', type: 'line' as const, to }
    : { id: 'line', type: 'line' as const };
  return { n: new LineNotifier(config, env, { fetch: f.fn, retryDelayMs: 0 }), calls: f.calls };
}

describe('LineNotifier', () => {
  it('送り先なしは broadcast', async () => {
    const { n, calls } = notifier(undefined);
    await n.send(alert);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.line.me/v2/bot/message/broadcast');
    expect(calls[0]?.headers.Authorization).toBe('Bearer test-token');
    expect(calls[0]?.body).toEqual({ messages: [{ type: 'text', text: '【T】\nM' }] });
  });

  it('送り先 1 件は push、2 件以上は multicast', async () => {
    const one = notifier([U1]);
    await one.n.send(alert);
    expect(one.calls[0]?.url).toMatch(/\/push$/);
    expect(one.calls[0]?.body.to).toBe(U1);

    const two = notifier([U1, U2]);
    await two.n.send(alert);
    expect(two.calls[0]?.url).toMatch(/\/multicast$/);
    expect(two.calls[0]?.body.to).toEqual([U1, U2]);
  });

  it('multicast は 500 件ずつに分ける', async () => {
    const to = Array.from({ length: 1001 }, (_, i) => `U${i.toString(16).padStart(32, '0')}`);
    const { n, calls } = notifier(to);
    await n.send(alert);
    expect(calls.map((c) => (c.body.to as string[]).length)).toEqual([500, 500, 1]);
  });

  it('本文は 5000 文字に切る', async () => {
    const { n, calls } = notifier([U1]);
    await n.send({ ...alert, title: undefined, message: 'あ'.repeat(6000) });
    expect(Array.from(calls[0]?.body.messages[0]?.text ?? '')).toHaveLength(LINE_MAX_TEXT);
  });

  it('5xx・通信エラーは同じ retry key で再試行する', async () => {
    const { n, calls } = notifier([U1], [500, new TypeError('fetch failed'), 200]);
    await n.send(alert);
    expect(calls).toHaveLength(3);
    const keys = new Set(calls.map((c) => c.headers['X-Line-Retry-Key']));
    expect(keys.size).toBe(1);
  });

  it('409（受理済み）は成功', async () => {
    const { n, calls } = notifier([U1], [409]);
    await n.send(alert);
    expect(calls).toHaveLength(1);
  });

  it('4xx は再試行せず失敗、メッセージにトークンを含まない', async () => {
    const { n, calls } = notifier([U1], [400]);
    await expect(n.send(alert)).rejects.toThrow('LINE push: 400 err 400');
    expect(calls).toHaveLength(1);
    await expect(notifier([U1], [401]).n.send(alert)).rejects.not.toThrow(/test-token/);
  });

  it('再試行を使い切ったら失敗', async () => {
    const { n, calls } = notifier([U1], [503, 503, 503]);
    await expect(n.send(alert)).rejects.toThrow('LINE push: 503');
    expect(calls).toHaveLength(3);
  });

  it('トークンが無ければ作れない', () => {
    expect(() => new LineNotifier({ id: 'x', type: 'line', tokenEnv: 'NOPE' }, {})).toThrow('NOPE');
  });
});
