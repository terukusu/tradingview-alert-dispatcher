import { describe, expect, it } from 'vitest';
import { extractSecret, formatText, parseAlert, truncate } from '../src/alert.ts';
import { MAX_BODY_BYTES } from '../src/server.ts';

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

// 壊れた本文（JSON.parse できない）の secret。値はすべて架空
describe('壊れた本文の secret', () => {
  it('壊れた JSON の secret を取り出す', () => {
    const bodies = [
      '{"secret":"s","message":"m",}', // 末尾のカンマ
      '{"secret":"s","message":"m"', // 閉じ括弧の欠落
      '{\n  "secret": "s",\n  "message": "m",\n}', // 整形・先頭
      '{\n  "message": "m",\n  "secret": "s"\n', // 整形・末尾・閉じ括弧の欠落
    ];
    for (const body of bodies) {
      expect(() => JSON.parse(body)).toThrow();
      expect(extractSecret(body)).toBe('s');
    }
  });

  it('スマートクォートの JSON の secret を取り出す', () => {
    for (const body of [
      '{“secret”: “s”, “message”: “m”}',
      '{“secret”: "s", "message": "m"}', // キーだけ
      '{"secret": “s”, "message": "m"}', // 値だけ
      '{"secret”: ”s“, "message": "m"}', // 開きと閉じの組み合わせは問わない
    ]) {
      expect(extractSecret(body)).toBe('s');
    }
  });

  it('プレースホルダの値の " で壊れた JSON の secret を取り出す', () => {
    const body = '{"secret":"s","title":"t","message":"XYZ "test" 1.5"}';
    expect(() => JSON.parse(body)).toThrow();
    expect(extractSecret(body)).toBe('s');
  });

  it('secret が 2 つある壊れた本文からは取り出さない', () => {
    for (const body of [
      '{"secret":"s","secret":"s","message":"m"', // 同じ値
      '{"secret":"s","secret":"t","message":"m"', // 違う値
      '{"secret":"s","message":"m","secret": x', // 片方が値の形を満たさない
      '{"secret":"s","message":"see "secret":"t""', // message の中の形も数える
    ]) {
      expect(extractSecret(body)).toBeUndefined();
    }
  });

  it('空の secret・閉じの引用符が無い secret は取り出さない', () => {
    for (const body of [
      '{"secret":"","m":"x', // 空
      '{"secret":"abc', // 本文の終わり
      '{"secret":"abc\n,"m":"x"', // 改行
      '{"secret": abc, "m":"x"', // 引用符なし
      '{"secret":"a\tb","m":"x"', // 制御文字（JSON の文字列として読めない）
    ]) {
      expect(extractSecret(body)).toBeUndefined();
    }
  });

  it('壊れた JSON の本文は secret を除いて送る', () => {
    const cases: [string, string][] = [
      ['{"secret":"s","message":"m",}', '{"message":"m",}'],
      ['{"secret":"s","message":"m"', '{"message":"m"'],
      ['{"a":"1", "secret":"s", "b":"2"', '{"a":"1", "b":"2"'],
      ['{"a":"1","secret":"s"', '{"a":"1"'],
      [
        '{"secret":"s","title":"t","message":"XYZ "test" 1.5"}',
        '{"title":"t","message":"XYZ "test" 1.5"}',
      ],
      ['{“secret”: “s”, “message”: “m”}', '{“message”: “m”}'],
      ['{\n  "secret": "s",\n  "message": "m",\n}', '{\n  "message": "m",\n}'],
      ['{\n  "message": "m",\n  "secret": "s"\n', '{\n  "message": "m"'],
      ['{\n  "a": "1",\n  "secret": "s",\n  "b": "2"\n', '{\n  "a": "1",\n  "b": "2"'],
      // 閉じの引用符が無い・引用符の無い値は行の終わりまで除く（値の断片を残さない）
      ['{\n  "secret": "secret-fragment\n  "message": "m"\n', '{\n  "message": "m"'],
      ['{"m":"x", "secret": secret-fragment, "n":"y"', '{"m":"x"'],
      // 2 つ以上あっても全部除く（?key= の経路）
      ['{"secret":"s1","message":"m","secret":"s2"', '{"message":"m"'],
    ];
    for (const [body, expected] of cases) {
      const a = parseAlert(body, at);
      expect(a.message).toBe(expected);
      expect(a.title).toBeUndefined();
      expect(a.channels).toBeUndefined();
      expect(a.message).not.toMatch(/["“”]secret["“”]/);
      expect(a.message).not.toMatch(/["“”]s[12]?["“”]|secret-fragment/);
    }
  });

  it('エスケープを含む secret は JSON と同じに読む', () => {
    const body = String.raw`{"secret":"a\"b\\c\u0041","m":"x`;
    expect(extractSecret(body)).toBe('a"b\\cA');
    expect(parseAlert(body, at).message).toBe('{"m":"x');
  });

  it('JSON として読める本文はいままでどおり', () => {
    expect(extractSecret('{"secret":123,"message":"m"}')).toBeUndefined();
    expect(extractSecret('{"message":"\\"secret\\":\\"x\\""}')).toBeUndefined();
    expect(extractSecret('{"secret":"","message":"m"}')).toBe('');
    expect(extractSecret('secret=abc')).toBeUndefined();
    expect(parseAlert('{"message":"\\"secret\\":\\"x\\""}', at).message).toBe('"secret":"x"');
  });

  it('64 KiB の悪意ある本文でも secret の取り出しが 1 秒以内に終わる', () => {
    const fill = (head: string, unit: string, tail = '') =>
      head +
      unit.repeat(Math.floor((MAX_BODY_BYTES - head.length - tail.length) / unit.length)) +
      tail;
    const bodies = [
      fill('{"secret":"', '\\'), // \ の連続
      fill('{"secret":"', '\\a'), // \ と文字の交互
      fill('{"secret":"', 'a'), // 閉じの無い長い値
      fill('{"secret"', ' '), // キーの後の長い空白
      fill('{"a":"b"', ' ', ','), // 長い空白とカンマ
      fill('{"a":"b",', ' '), // カンマ＋長い空白
      fill('', ' '), // 空白だけ
      fill('{', '"secret":'), // キーの反復
      fill('{', ',"secret":'), // , とキーの反復
      fill('{', '"secret": "a'), // キー＋閉じの無い値の反復
      fill('{', ', '), // カンマと空白の反復
    ];
    for (const body of bodies) {
      expect(body.length).toBeGreaterThan(MAX_BODY_BYTES - 16);
      expect(body.length).toBeLessThanOrEqual(MAX_BODY_BYTES);
      const started = performance.now();
      extractSecret(body);
      parseAlert(body, at);
      expect(performance.now() - started).toBeLessThan(1000);
    }
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
