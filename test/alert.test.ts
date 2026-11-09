import { describe, expect, it } from 'vitest';
import { extractSecret, formatText, parseAlert, truncate } from '../src/alert.ts';

const at = new Date('2026-01-02T03:04:05Z');

describe('parseAlert', () => {
  it('プレーンテキストはそのまま本文', () => {
    const a = parseAlert('  BTCUSD crossing 100000  \n', at);
    expect(a).toEqual({
      title: undefined,
      message: 'BTCUSD crossing 100000',
      channels: undefined,
      receivedAt: at,
    });
  });

  it('JSON の title / message / channels を読む', () => {
    const a = parseAlert(
      '{"title":"上抜け","message":"XYZ 123.4","channels":["line","slack"]}',
      at,
    );
    expect(a.title).toBe('上抜け');
    expect(a.message).toBe('XYZ 123.4');
    expect(a.channels).toEqual(['line', 'slack']);
  });

  it('channels はカンマ区切りの文字列でもよい', () => {
    expect(parseAlert('{"message":"m","channels":" line , ,slack"}', at).channels).toEqual([
      'line',
      'slack',
    ]);
  });

  it('message が無い JSON は secret を除いた全体を本文にする', () => {
    const a = parseAlert('{"secret":"s3cr3t","ticker":"XYZ","price":1.5}', at);
    expect(a.message).not.toContain('s3cr3t');
    expect(JSON.parse(a.message)).toEqual({ ticker: 'XYZ', price: 1.5 });
  });

  it('壊れた JSON はテキストとして扱う', () => {
    expect(parseAlert('{"message": ', at).message).toBe('{"message":');
  });
});

describe('extractSecret', () => {
  it('JSON の secret を返す', () => expect(extractSecret('{"secret":"abc"}')).toBe('abc'));
  it('テキストや数値の secret は undefined', () => {
    expect(extractSecret('secret=abc')).toBeUndefined();
    expect(extractSecret('{"secret":123}')).toBeUndefined();
  });
});

describe('formatText / truncate', () => {
  it('title があれば見出しを付ける', () => {
    expect(formatText({ title: 'T', message: 'M', channels: undefined, receivedAt: at })).toBe(
      '【T】\nM',
    );
  });
  it('上限ちょうどは切らない、超えたら … で上限の長さ', () => {
    expect(truncate('abcde', 5)).toBe('abcde');
    expect(truncate('abcdef', 5)).toBe('abcd…');
  });
  it('サロゲートペアを壊さない', () => {
    expect(truncate('😀😀😀', 2)).toBe('😀…');
  });
});
