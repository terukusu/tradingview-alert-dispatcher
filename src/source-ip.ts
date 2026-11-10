import { isIPv4 } from 'node:net';

/**
 * 送信元 IP（docs/design.md「送信元 IP の許可リスト」）。**純関数**
 *
 * - `X-Forwarded-For` が 1 行だけならその末尾の要素（2 行以上なら `undefined` = 拒否）（前段のフロント（Cloud Run の GFE）が付け足した接続元）。
 *   先頭の側は相手が自由に書けるので見ない。末尾が空なら `undefined`（接続元にはフォールバックしない）
 * - 無ければ接続元のアドレス（`::ffff:` + IPv4 は IPv4 に直す）
 * - 取れなければ `undefined`。ポート付き・角括弧の IPv6 は加工しない（許可リストと一致しない）
 */
export function sourceIp(
  forwardedFor: string | string[] | undefined,
  remoteAddress: string | undefined,
): string | undefined {
  if (forwardedFor !== undefined) {
    // ヘッダが複数行で届いたら、行の順序と前段のフロントの付け足し方に依存するので信用しない（拒否）。
    // 呼び出し側は req.headersDistinct で行ごとの配列を渡す（req.headers は行をカンマでつないでしまう）
    if (Array.isArray(forwardedFor) && forwardedFor.length !== 1) return undefined;
    const line = Array.isArray(forwardedFor) ? (forwardedFor[0] ?? '') : forwardedFor;
    const last = line.split(',').at(-1)?.trim();
    return last === '' ? undefined : last;
  }
  if (remoteAddress === undefined) return undefined;
  const v4 = remoteAddress.startsWith('::ffff:') ? remoteAddress.slice('::ffff:'.length) : '';
  return isIPv4(v4) ? v4 : remoteAddress;
}
