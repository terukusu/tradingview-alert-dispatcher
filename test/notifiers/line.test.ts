import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_TIMEOUT_MS,
  LINE_MAX_TEXT,
  LineNotifier,
  type LineNotifierOptions,
  MAX_RETRIES,
  SEND_DEADLINE_MS,
} from '../../src/notifiers/line.ts';
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

/** 偽の応答: ステータス・例外・`hang`（signal が中断するまで応答しない）・`{ delayMs, status }`（遅れて応答。signal で中断できる） */
type FakeResponse = number | Error | 'hang' | { delayMs: number; status: number };

function fakeFetch(responses: FakeResponse[], fallback: FakeResponse = 200) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(init.body as string),
    });
    const r = responses.shift() ?? fallback;
    if (r instanceof Error) throw r;
    let status: number;
    if (r === 'hang') {
      await waitAbort(init.signal);
      throw new Error('unreachable');
    } else if (typeof r === 'number') {
      status = r;
    } else {
      await delay(r.delayMs, init.signal);
      status = r.status;
    }
    const body =
      status === 200
        ? '{}'
        : JSON.stringify({
            message: status === 429 ? 'You have reached your monthly limit.' : `err ${status}`,
          });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

/** signal が中断したら signal.reason で reject する（fetch の振る舞いをまねる） */
function waitAbort(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) return;
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

function delay(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return Promise.race([new Promise<void>((r) => setTimeout(r, ms)), waitAbort(signal)]);
}

function notifier(
  to: string[] | undefined,
  responses: FakeResponse[] = [],
  options: LineNotifierOptions = {},
  fallback?: FakeResponse,
) {
  const f = fakeFetch(responses, fallback);
  const config = to
    ? { id: 'line', type: 'line' as const, to }
    : { id: 'line', type: 'line' as const };
  return {
    n: new LineNotifier(config, env, { fetch: f.fn, retryDelayMs: 0, ...options }),
    calls: f.calls,
  };
}

/** 架空の送り先 ID を n 件組み立てる */
function fakeIds(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `U${i.toString(16).padStart(32, '0')}`);
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
    const { n, calls } = notifier(fakeIds(1001));
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

  it('429 は再試行せず失敗する（月の上限）', async () => {
    const { n, calls } = notifier([U1], [429, 200]);
    await expect(n.send(alert)).rejects.toThrow(
      'LINE push: 429 You have reached your monthly limit.',
    );
    expect(calls).toHaveLength(1);
  });

  it('1 回の試行がタイムアウトしたら同じ retry key で再試行する', async () => {
    const { n, calls } = notifier([U1], ['hang', 200], {
      attemptTimeoutMs: 20,
      sendDeadlineMs: 1000,
    });
    await n.send(alert);
    expect(calls).toHaveLength(2);
    const keys = new Set(calls.map((c) => c.headers['X-Line-Retry-Key']));
    expect(keys.size).toBe(1);
  });

  it('再試行の待ちは 0.5 秒・1 秒', async () => {
    const waits: number[] = [];
    const f = fakeFetch([500, 500, 200]);
    const n = new LineNotifier({ id: 'line', type: 'line', to: [U1] }, env, {
      fetch: f.fn,
      sleep: async (ms) => void waits.push(ms),
    });
    await n.send(alert);
    expect(f.calls).toHaveLength(3);
    expect(waits).toEqual([500, 1000]);
  });

  it('送信全体が締め切りを超えたら打ち切って失敗する', async () => {
    const { n, calls } = notifier([U1], [], { sendDeadlineMs: 50, attemptTimeoutMs: 1000 }, 'hang');
    const started = performance.now();
    const err = await n.send(alert).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    const elapsed = performance.now() - started;
    expect(err?.message).toBe('LINE push: 送信の締め切り 50 ms を超えた');
    expect(err?.message).not.toMatch(/test-token/);
    expect(err?.message).not.toContain(U1);
    expect(elapsed).toBeGreaterThanOrEqual(45);
    expect(elapsed).toBeLessThan(500);
    expect(calls).toHaveLength(1);
  });

  it('multicast の分割も含めて締め切りは送信全体で 1 つ', async () => {
    const { n, calls } = notifier(
      fakeIds(1001),
      [],
      { sendDeadlineMs: 50, attemptTimeoutMs: 1000 },
      { delayMs: 30, status: 200 },
    );
    await expect(n.send(alert)).rejects.toThrow('LINE multicast: 送信の締め切り 50 ms を超えた');
    expect(calls.length).toBeLessThan(3);
  });

  it('時間の既定値（締め切り 8 秒・試行 5 秒・再試行 2 回）', () => {
    expect([SEND_DEADLINE_MS, ATTEMPT_TIMEOUT_MS, MAX_RETRIES]).toEqual([8_000, 5_000, 2]);
  });

  it('トークンが無ければ作れない', () => {
    expect(() => new LineNotifier({ id: 'x', type: 'line', tokenEnv: 'NOPE' }, {})).toThrow('NOPE');
  });
});
