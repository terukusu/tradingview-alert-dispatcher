import type { Alert, DispatchResult, Notifier } from './types.ts';

/**
 * 1 つのアラートを複数の経路に並行して送る。1 つの経路の失敗はほかの経路に影響しない。
 */
export class Dispatcher {
  readonly #notifiers: Map<string, Notifier>;
  readonly #defaultChannels: string[];

  constructor(notifiers: Notifier[], defaultChannels?: string[]) {
    this.#notifiers = new Map(notifiers.map((n) => [n.id, n]));
    this.#defaultChannels = defaultChannels ?? notifiers.map((n) => n.id);
  }

  /** アラートの送り先（alert.channels の指定、無ければ既定）。未知の ID は unknown に入れる */
  resolve(alert: Alert): { targets: Notifier[]; unknown: string[] } {
    const ids = [...new Set(alert.channels ?? this.#defaultChannels)];
    const targets: Notifier[] = [];
    const unknown: string[] = [];
    for (const id of ids) {
      const n = this.#notifiers.get(id);
      if (n) targets.push(n);
      else unknown.push(id);
    }
    return { targets, unknown };
  }

  async dispatch(alert: Alert): Promise<DispatchResult[]> {
    const { targets, unknown } = this.resolve(alert);
    const sent = await Promise.all(targets.map((n) => sendOne(n, alert)));
    const missing = unknown.map(
      (channel): DispatchResult => ({
        channel,
        ok: false,
        error: '未知のチャネル',
        elapsedMs: 0,
      }),
    );
    return [...sent, ...missing];
  }
}

async function sendOne(notifier: Notifier, alert: Alert): Promise<DispatchResult> {
  const start = performance.now();
  try {
    await notifier.send(alert);
    return { channel: notifier.id, ok: true, elapsedMs: elapsed(start) };
  } catch (e) {
    return {
      channel: notifier.id,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      elapsedMs: elapsed(start),
    };
  }
}

function elapsed(start: number): number {
  return Math.round(performance.now() - start);
}
