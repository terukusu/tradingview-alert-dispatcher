import type { Alert } from './types.ts';

/**
 * TradingView の webhook の本文を Alert にする（純関数）。
 *
 * - JSON のとき: `{ "title"?, "message"?, "channels"?, "secret"?, ...任意 }`。
 *   message が無ければ secret を除いた JSON 全体を本文にする
 * - それ以外（プレーンテキスト、壊れた JSON）: 本文そのまま
 */
export function parseAlert(body: string, receivedAt: Date): Alert {
  const payload = parseObject(body);
  if (payload) {
    const { secret: _secret, ...rest } = payload;
    return {
      title: typeof rest.title === 'string' && rest.title !== '' ? rest.title : undefined,
      message: typeof rest.message === 'string' ? rest.message : JSON.stringify(rest, null, 2),
      channels: toChannelList(rest.channels),
      receivedAt,
    };
  }
  return { title: undefined, message: body.trim(), channels: undefined, receivedAt };
}

/** JSON の本文の secret（無ければ undefined）。認証に使う */
export function extractSecret(body: string): string | undefined {
  const secret = parseObject(body)?.secret;
  return typeof secret === 'string' ? secret : undefined;
}

/** 通知のテキストにする */
export function formatText(alert: Alert): string {
  return alert.title ? `【${alert.title}】\n${alert.message}` : alert.message;
}

/** 文字数（コードポイント）で切る。超えたら末尾を … にする */
export function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

function parseObject(body: string): Record<string, unknown> | undefined {
  const trimmed = body.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    const v: unknown = JSON.parse(trimmed);
    return v !== null && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** "a,b" / ["a","b"] → ["a","b"]。空なら undefined */
function toChannelList(v: unknown): string[] | undefined {
  const list =
    typeof v === 'string'
      ? v.split(',')
      : Array.isArray(v)
        ? v.filter((s): s is string => typeof s === 'string')
        : [];
  const ids = list.map((s) => s.trim()).filter(Boolean);
  return ids.length > 0 ? ids : undefined;
}
