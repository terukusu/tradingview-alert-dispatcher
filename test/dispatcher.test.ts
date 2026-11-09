import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../src/dispatcher.ts';
import type { Alert, Notifier } from '../src/types.ts';

function alert(channels?: string[]): Alert {
  return { title: undefined, message: 'm', channels, receivedAt: new Date(0) };
}

function fake(id: string, fail = false): Notifier & { sent: Alert[] } {
  const sent: Alert[] = [];
  return {
    id,
    type: 'fake',
    sent,
    async send(a) {
      if (fail) throw new Error(`${id} down`);
      sent.push(a);
    },
  };
}

describe('Dispatcher', () => {
  it('指定が無ければ全チャネルに送る', async () => {
    const a = fake('a');
    const b = fake('b');
    const results = await new Dispatcher([a, b]).dispatch(alert());
    expect(results.map((r) => [r.channel, r.ok])).toEqual([
      ['a', true],
      ['b', true],
    ]);
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
  });

  it('defaultChannels があればそれだけに送る', async () => {
    const a = fake('a');
    const b = fake('b');
    await new Dispatcher([a, b], ['b']).dispatch(alert());
    expect(a.sent).toHaveLength(0);
    expect(b.sent).toHaveLength(1);
  });

  it('alert.channels が既定より優先し、重複は 1 回', async () => {
    const a = fake('a');
    const b = fake('b');
    await new Dispatcher([a, b], ['b']).dispatch(alert(['a', 'a']));
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(0);
  });

  it('1 つの経路の失敗はほかの経路を止めない', async () => {
    const a = fake('a', true);
    const b = fake('b');
    const results = await new Dispatcher([a, b]).dispatch(alert());
    expect(results.find((r) => r.channel === 'a')).toMatchObject({ ok: false, error: 'a down' });
    expect(b.sent).toHaveLength(1);
  });

  it('未知のチャネルは失敗として返す', async () => {
    const results = await new Dispatcher([fake('a')]).dispatch(alert(['nope']));
    expect(results).toEqual([
      { channel: 'nope', ok: false, error: '未知のチャネル', elapsedMs: 0 },
    ]);
  });
});
