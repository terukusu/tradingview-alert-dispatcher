import { randomUUID } from 'node:crypto';
import { setTimeout as sleepWithSignal } from 'node:timers/promises';
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
  /** 再試行の待ちの基準（ミリ秒。n 回目の待ちは retryDelayMs × 2^(n-1)）。テストでは 0 にする */
  retryDelayMs?: number;
  /** 送信全体の締め切り（ミリ秒。既定 SEND_DEADLINE_MS） */
  sendDeadlineMs?: number;
  /** 1 回の試行のタイムアウト（ミリ秒。既定 ATTEMPT_TIMEOUT_MS） */
  attemptTimeoutMs?: number;
  /** 再試行の待ち。signal が中断したら reject する。テストで待ちの長さを観察する */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const API_BASE = 'https://api.line.me/v2/bot/message';
/** テキストメッセージの上限（文字） */
export const LINE_MAX_TEXT = 5000;
/** multicast の 1 リクエストの宛先の上限 */
export const LINE_MULTICAST_LIMIT = 500;
/**
 * 1 チャネルの送信全体の締め切り（multicast の全分割・全試行・全待ちを含む）。
 * Cloud Run の SIGTERM から SIGKILL までの 10 秒（停止時の待ちの上限 9 秒）に収める
 */
export const SEND_DEADLINE_MS = 8_000;
/** 1 回の試行のタイムアウト（締め切りまでの残りが短ければ残りまで） */
export const ATTEMPT_TIMEOUT_MS = 5_000;
/** 再試行の回数（初回を除く） */
export const MAX_RETRIES = 2;
/** 再試行の待ちの基準の既定（500 ms・1000 ms） */
const RETRY_DELAY_MS = 500;

/**
 * LINE Messaging API で送る。送り先が 0 件なら broadcast、1 件なら push、2 件以上なら multicast。
 *
 * 5xx・通信エラー・試行のタイムアウトは同じ X-Line-Retry-Key で再試行する（LINE 側で重複が除かれる）。
 * 429（月の上限・レート制限）を含む 4xx は再試行しない。409（同じ retry key を受理済み）は送信済みとして成功扱いにする。
 * 送信全体に締め切りを 1 つ持ち、過ぎたら進行中の試行・待ちを打ち切って失敗する（送り済みの分割分は送り直さない）。
 */
export class LineNotifier implements Notifier {
  readonly type = 'line';
  readonly id: string;
  readonly #token: string;
  readonly #to: string[];
  readonly #fetch: typeof fetch;
  readonly #retryDelayMs: number;
  readonly #sendDeadlineMs: number;
  readonly #attemptTimeoutMs: number;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;

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
    this.#retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
    this.#sendDeadlineMs = options.sendDeadlineMs ?? SEND_DEADLINE_MS;
    this.#attemptTimeoutMs = options.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  async send(alert: Alert): Promise<void> {
    const messages = [{ type: 'text', text: truncate(formatText(alert), LINE_MAX_TEXT) }];
    // 送信全体で 1 つの締め切り（multicast の分割・再試行・待ちで共有する）
    const deadline = AbortSignal.timeout(this.#sendDeadlineMs);
    const [first, ...rest] = this.#to;
    if (first === undefined) {
      await this.#post('broadcast', { messages }, deadline);
    } else if (rest.length === 0) {
      await this.#post('push', { to: first, messages }, deadline);
    } else {
      for (let i = 0; i < this.#to.length; i += LINE_MULTICAST_LIMIT) {
        await this.#post(
          'multicast',
          { to: this.#to.slice(i, i + LINE_MULTICAST_LIMIT), messages },
          deadline,
        );
      }
    }
  }

  async #post(endpoint: string, body: unknown, deadline: AbortSignal): Promise<void> {
    const retryKey = randomUUID();
    const deadlineError = () =>
      new Error(`LINE ${endpoint}: 送信の締め切り ${this.#sendDeadlineMs} ms を超えた`);
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const ms = this.#retryDelayMs * 2 ** (attempt - 1);
        try {
          if (ms > 0) await this.#sleep(ms, deadline);
        } catch {
          if (deadline.aborted) throw deadlineError();
        }
      }
      if (deadline.aborted) throw deadlineError();
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
          signal: AbortSignal.any([deadline, AbortSignal.timeout(this.#attemptTimeoutMs)]),
        });
      } catch (e) {
        if (deadline.aborted) throw deadlineError();
        // 通信エラー・試行のタイムアウト → 同じ retry key で再試行
        lastError = new Error(`LINE ${endpoint}: 通信エラー ${(e as Error).name}`);
        continue;
      }
      if (res.ok || res.status === 409) return;
      const detail = await readErrorMessage(res);
      lastError = new Error(`LINE ${endpoint}: ${res.status}${detail ? ` ${detail}` : ''}`);
      // 429（月の上限・レート制限）を含む 4xx は再試行しない
      if (res.status < 500) break;
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

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return sleepWithSignal(ms, undefined, { signal });
}
