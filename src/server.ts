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
 * - `POST /webhook`（`?key=<WEBHOOK_SECRET>` か JSON の secret で認証）: 受理したら 200 を即返し、送信は裏で行う
 *   （TradingView は応答を 3 秒しか待たない）
 * - `GET /healthz`: 200
 */
export function createApp(options: AppOptions): Server {
  const now = options.now ?? (() => new Date());
  const onDispatched = options.onDispatched ?? logResults;

  return createServer((req, res) => {
    void handle(req, res).catch((e: unknown) => {
      log('error', { msg: 'handler failed', error: e instanceof Error ? e.name : 'unknown' });
      if (!res.headersSent) send(res, 500, 'internal error');
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/healthz' && req.method === 'GET') return send(res, 200, 'ok');
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
function log(severity: 'info' | 'warn' | 'error', fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ severity: severity.toUpperCase(), ...fields }));
}

function logResults(alert: Alert, results: DispatchResult[]): void {
  const failed = results.filter((r) => !r.ok);
  log(failed.length > 0 ? 'error' : 'info', {
    msg: 'dispatched',
    title: alert.title,
    results,
  });
}

function main(): void {
  const config = loadConfig(process.env);
  const notifiers = config.channels.map((c) => createNotifier(c, { env: process.env }));
  const dispatcher = new Dispatcher(notifiers, config.defaultChannels);
  const server = createApp({ webhookSecret: config.webhookSecret, dispatcher });
  server.listen(config.port, () => {
    log('info', { msg: 'listening', port: config.port, channels: notifiers.map((n) => n.id) });
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (import.meta.main) main();
