import type { Alert } from './types.ts';

/**
 * TradingView の webhook の本文を Alert にする（純関数）。
 *
 * - JSON のとき: `{ "title"?, "message"?, "channels"?, "secret"?, ...任意 }`。
 *   message が無ければ secret を除いた JSON 全体を本文にする
 * - それ以外（プレーンテキスト、壊れた JSON）: 本文から secret の部分（`"secret": "…"` の形）を
 *   除いたテキスト。title / channels は取り出さない
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
  return {
    title: undefined,
    message: body.replace(LOOSE_SECRET_STRIP, '').trim(),
    channels: undefined,
    receivedAt,
  };
}

/**
 * 本文の secret（無ければ undefined）。認証に使う。
 *
 * - JSON の object として読めるとき: その secret（string のときだけ）
 * - 読めないとき（壊れた JSON・スマートクォート・プレースホルダの値の `"` など）: 引用符で囲んだ
 *   `"secret": "…"` の形を探す。キーがちょうど 1 つで、値が閉じの引用符まであり、JSON の文字列として
 *   読めて空でないときだけ返す
 */
export function extractSecret(body: string): string | undefined {
  const payload = parseObject(body);
  if (payload) return typeof payload.secret === 'string' ? payload.secret : undefined;
  return findLooseSecret(body);
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

// 壊れた本文の secret の形。数える・取り出す・除くの 3 つの式で共有し、認識する形を食い違わせない。
// 入れ子の量指定子を持たない（値の中の 2 つの選択肢は先頭の文字で排他）ので、本文の長さに線形で終わる
/** 引用符: `"`・`“`・`”`（開きと閉じの組み合わせは問わない） */
const Q = '["“”]';
/** キーとコロン（大文字小文字を区別。JSON の経路と同じ） */
const KEY = `${Q}secret${Q}\\s*:\\s*`;
/** 引用符で囲んだ値。中は引用符・`\`・改行以外の文字か、`\` + 改行以外の 1 文字（JSON のエスケープ） */
const QVAL = `${Q}((?:[^"“”\\\\\\n]|\\\\.)*)${Q}`;
const LOOSE_SECRET_KEY = new RegExp(KEY, 'g');
const LOOSE_SECRET = new RegExp(KEY + QVAL);
/**
 * 除く範囲: 前にカンマがあればそのカンマと間の空白から、無ければキーから後ろの空白・カンマまで。
 * 値が引用符の形を満たさないときは行の終わりまで（値の断片を残さない）
 */
const LOOSE_SECRET_STRIP = new RegExp(
  `,\\s*${KEY}(?:${QVAL}|[^\\n]*)|${KEY}(?:${QVAL}|[^\\n]*)\\s*(?:,\\s*)?`,
  'g',
);

function findLooseSecret(body: string): string | undefined {
  if (body.match(LOOSE_SECRET_KEY)?.length !== 1) return undefined;
  const raw = LOOSE_SECRET.exec(body)?.[1];
  if (raw === undefined) return undefined;
  try {
    const secret: unknown = JSON.parse(`"${raw}"`);
    return typeof secret === 'string' && secret !== '' ? secret : undefined;
  } catch {
    return undefined;
  }
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
