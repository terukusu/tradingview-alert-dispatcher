import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extractSecret, parseAlert } from './alert.ts';
import { loadConfig } from './config.ts';
import { Dispatcher } from './dispatcher.ts';
import { createNotifier } from './notifiers/index.ts';
import type { Alert, DispatchResult } from './types.ts';

/** 受け付ける本文の上限（TradingView のアラートのメッセージは数 KB） */
export const MAX_BODY_BYTES = 64 * 1024;

export interface AppOptions {
  webhookSecret: string;
  dispatcher: Dispatcher;
  /** 送信結果の受け口（既定は構造化ログ）。テストで差し替える */
  onDispatched?: (alert: Alert, results: DispatchResult[]) => void;
  now?: () => Date;
}

/**
 * 停止時（SIGTERM・SIGINT）に処理中の配信を待つ上限。
 * Cloud Run の SIGTERM から SIGKILL までの 10 秒に収め、LINE の送信の締め切り 8 秒より長くする
 */
export const SHUTDOWN_TIMEOUT_MS = 9_000;

export interface App {
  server: Server;
  /** 受付を止め、処理中のリクエスト（裏の配信と onDispatched まで）を待つ。何度呼んでも同じ Promise */
  shutdown(timeoutMs?: number): Promise<{ remaining: number }>;
}

/**
 * - `POST /webhook`（`?key=<WEBHOOK_SECRET>` か JSON の secret で認証）: 受理したら 200 を即返し、送信は裏で行う
 *   （TradingView は応答を 3 秒しか待たない）
 * - `GET /health`: 200 `ok`
 *
 * 処理中のリクエスト（本文の読み込みから裏の配信・onDispatched まで）を追跡し、`shutdown` で待つ。
 */
export function createApp(options: AppOptions): App {
  const now = options.now ?? (() => new Date());
  const onDispatched = options.onDispatched ?? logResults;
  const inflight = new Set<Promise<void>>();
  let shuttingDown: Promise<{ remaining: number }> | undefined;

  const server = createServer((req, res) => {
    if (shuttingDown) {
      // 終了中に既存の接続で届いたものは受けない（配信の締め切りが停止の猶予を超えうる）
      res.setHeader('Connection', 'close');
      return send(res, 503, 'shutting down');
    }
    const task = handle(req, res)
      .catch((e: unknown) => {
        log('error', { msg: 'handler failed', error: e instanceof Error ? e.name : 'unknown' });
        if (!res.headersSent) send(res, 500, 'internal error');
      })
      .finally(() => inflight.delete(task));
    inflight.add(task);
  });

  return {
    server,
    shutdown(timeoutMs = SHUTDOWN_TIMEOUT_MS) {
      shuttingDown ??= shutdown(timeoutMs);
      return shuttingDown;
    },
  };

  async function shutdown(timeoutMs: number): Promise<{ remaining: number }> {
    server.close();
    server.closeIdleConnections();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<true>((r) => {
      timer = setTimeout(() => r(true), timeoutMs);
    });
    const timedOut = await Promise.race([Promise.all(inflight).then(() => false), timeout]);
    clearTimeout(timer);
    const remaining = timedOut ? inflight.size : 0;
    if (timedOut) {
      log('warn', { msg: 'shutdown timeout', remaining });
    } else {
      log('info', { msg: 'shutdown', remaining });
    }
    server.closeAllConnections();
    return { remaining };
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/health' && req.method === 'GET') return send(res, 200, 'ok');
    if (url.pathname !== '/webhook') return send(res, 404, 'not found');
    if (req.method !== 'POST') return send(res, 405, 'method not allowed');

    const body = await readBody(req, MAX_BODY_BYTES);
    if (body === undefined) return send(res, 413, 'payload too large');

    const given = url.searchParams.get('key') ?? extractSecret(body);
    if (given === undefined || !safeEqual(given, options.webhookSecret)) {
      log('warn', { msg: 'unauthorized' });
      return send(res, 401, 'unauthorized');
    }

    const alert = parseAlert(body, now());
    if (alert.message === '') return send(res, 400, 'empty message');

    send(res, 200, 'accepted');
    const results = await options.dispatcher.dispatch(alert);
    onDispatched(alert, results);
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) over = true;
      if (!over) chunks.push(chunk);
    });
    req.on('end', () => resolve(over ? undefined : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 長さを漏らさず定数時間で比べる（SHA-256 にそろえてから timingSafeEqual） */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

function send(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

/** 構造化ログ（Cloud Logging が severity を読む）。本文・シークレットは出さない */
const SEVERITY = { info: 'INFO', warn: 'WARNING', error: 'ERROR' } as const;

function log(severity: keyof typeof SEVERITY, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ severity: SEVERITY[severity], ...fields }));
}

/** 送信結果のログ。title・本文・送り先 ID は出さない（銘柄・売買条件が分かるため） */
function logResults(_alert: Alert, results: DispatchResult[]): void {
  const failed = results.filter((r) => !r.ok);
  log(failed.length > 0 ? 'error' : 'info', { msg: 'dispatched', results });
}

function main(): void {
  const config = loadConfig(process.env);
  const notifiers = config.channels.map((c) => createNotifier(c, { env: process.env }));
  const dispatcher = new Dispatcher(notifiers, config.defaultChannels);
  const app = createApp({ webhookSecret: config.webhookSecret, dispatcher });
  // Cloud Run は 0.0.0.0 の PORT に届ける
  app.server.listen(config.port, '0.0.0.0', () => {
    log('info', { msg: 'listening', port: config.port, channels: notifiers.map((n) => n.id) });
  });
  // 受付を止めて処理中の配信を待つ（上限 SHUTDOWN_TIMEOUT_MS）。打ち切りでも 0 で終わる（取りこぼしは WARNING のログ）
  const shutdown = () => void app.shutdown().then(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (import.meta.main) main();
