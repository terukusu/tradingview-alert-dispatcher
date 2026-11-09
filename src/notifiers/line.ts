import { randomUUID } from 'node:crypto';
import { formatText, truncate } from '../alert.ts';
import type { Alert, Notifier } from '../types.ts';

/** 設定の channels[] のうち type: "line" のもの */
export interface LineChannelConfig {
  id: string;
  type: 'line';
  /** チャネルアクセストークンを読む環境変数の名前（既定 LINE_CHANNEL_ACCESS_TOKEN）。トークンの値は設定ファイルに書かない */
  tokenEnv?: string;
  /** 送り先の userId / groupId / roomId。空・省略なら broadcast（友だち全員） */
  to?: string[];
}

export interface LineNotifierOptions {
  fetch?: typeof fetch;
  /** 再試行の待ち時間（ミリ秒）。テストでは 0 にする */
  retryDelayMs?: number;
}

const API_BASE = 'https://api.line.me/v2/bot/message';
/** テキストメッセージの上限（文字） */
export const LINE_MAX_TEXT = 5000;
/** multicast の 1 リクエストの宛先の上限 */
export const LINE_MULTICAST_LIMIT = 500;
/** 再試行の回数（初回を除く） */
const MAX_RETRIES = 2;
const TIMEOUT_MS = 10_000;

/**
 * LINE Messaging API で送る。送り先が 0 件なら broadcast、1 件なら push、2 件以上なら multicast。
 *
 * 5xx・429・通信エラーは同じ X-Line-Retry-Key で再試行する（LINE 側で重複が除かれる）。
 * 409（同じ retry key を受理済み）は送信済みとして成功扱いにする。
 */
export class LineNotifier implements Notifier {
  readonly type = 'line';
  readonly id: string;
  readonly #token: string;
  readonly #to: string[];
  readonly #fetch: typeof fetch;
  readonly #retryDelayMs: number;

  constructor(
    config: LineChannelConfig,
    env: NodeJS.ProcessEnv,
    options: LineNotifierOptions = {},
  ) {
    this.id = config.id;
    const envName = config.tokenEnv ?? 'LINE_CHANNEL_ACCESS_TOKEN';
    const token = env[envName];
    if (!token) {
      throw new Error(`[${config.id}] 環境変数 ${envName} にチャネルアクセストークンがない`);
    }
    this.#token = token;
    this.#to = config.to ?? [];
    this.#fetch = options.fetch ?? fetch;
    this.#retryDelayMs = options.retryDelayMs ?? 1000;
  }

  async send(alert: Alert): Promise<void> {
    const messages = [{ type: 'text', text: truncate(formatText(alert), LINE_MAX_TEXT) }];
    const [first, ...rest] = this.#to;
    if (first === undefined) {
      await this.#post('broadcast', { messages });
    } else if (rest.length === 0) {
      await this.#post('push', { to: first, messages });
    } else {
      for (let i = 0; i < this.#to.length; i += LINE_MULTICAST_LIMIT) {
        await this.#post('multicast', {
          to: this.#to.slice(i, i + LINE_MULTICAST_LIMIT),
          messages,
        });
      }
    }
  }

  async #post(endpoint: string, body: unknown): Promise<void> {
    const retryKey = randomUUID();
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) await sleep(this.#retryDelayMs * 2 ** (attempt - 1));
      let res: Response;
      try {
        res = await this.#fetch(`${API_BASE}/${endpoint}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.#token}`,
            'X-Line-Retry-Key': retryKey,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (e) {
        lastError = new Error(`LINE ${endpoint}: 通信エラー ${(e as Error).name}`);
        continue;
      }
      if (res.ok || res.status === 409) return;
      const detail = await readErrorMessage(res);
      lastError = new Error(`LINE ${endpoint}: ${res.status}${detail ? ` ${detail}` : ''}`);
      if (res.status !== 429 && res.status < 500) break;
    }
    throw lastError ?? new Error(`LINE ${endpoint}: 失敗`);
  }
}

/** LINE のエラー応答の message だけを取る（本文を丸ごとログに出さない） */
async function readErrorMessage(res: Response): Promise<string> {
  try {
    const json = (await res.json()) as { message?: unknown };
    return typeof json.message === 'string' ? json.message.slice(0, 200) : '';
  } catch {
    return '';
  }
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}
