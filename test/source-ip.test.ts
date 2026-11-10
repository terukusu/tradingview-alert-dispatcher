import { describe, expect, it } from 'vitest';
import { sourceIp } from '../src/source-ip.ts';

// 値は文書用の架空の IP（RFC 5737・RFC 3849）
describe('sourceIp', () => {
  it.each([
    ['192.0.2.1', '127.0.0.1', '192.0.2.1'],
    ['203.0.113.9, 192.0.2.1', '127.0.0.1', '192.0.2.1'],
    ['192.0.2.1, 203.0.113.9', '127.0.0.1', '203.0.113.9'],
    ['  192.0.2.1  ', undefined, '192.0.2.1'],
    ['192.0.2.1:443', undefined, '192.0.2.1:443'],
    ['2001:db8::1', undefined, '2001:db8::1'],
  ])('X-Forwarded-For %j は末尾の要素を返す（接続元 %j は見ない）', (xff, remote, want) => {
    expect(sourceIp(xff, remote)).toBe(want);
  });

  it.each(['192.0.2.1,', '192.0.2.1, ', '', ' '])(
    'X-Forwarded-For %j は末尾が空なので undefined（接続元にフォールバックしない）',
    (xff) => {
      expect(sourceIp(xff, '127.0.0.1')).toBeUndefined();
    },
  );

  it('X-Forwarded-For が 1 行の配列ならその末尾の要素、2 行以上・0 行なら undefined（拒否）', () => {
    expect(sourceIp(['203.0.113.9, 192.0.2.1'], '127.0.0.1')).toBe('192.0.2.1');
    expect(sourceIp(['203.0.113.9', '192.0.2.1'], '127.0.0.1')).toBeUndefined();
    expect(sourceIp(['192.0.2.1', '192.0.2.1'], '127.0.0.1')).toBeUndefined();
    expect(sourceIp([], '127.0.0.1')).toBeUndefined();
  });

  it.each([
    ['::ffff:127.0.0.1', '127.0.0.1'],
    ['127.0.0.1', '127.0.0.1'],
    ['::1', '::1'],
    ['::ffff:abcd', '::ffff:abcd'],
  ])('X-Forwarded-For が無ければ接続元 %j → %j', (remote, want) => {
    expect(sourceIp(undefined, remote)).toBe(want);
  });

  it('どちらも無ければ undefined', () => {
    expect(sourceIp(undefined, undefined)).toBeUndefined();
  });
});
