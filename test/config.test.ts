import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, parseChannels } from '../src/config.ts';

const SECRET = 'x'.repeat(16);

describe('loadConfig', () => {
  it('WEBHOOK_SECRET が短いと失敗', () => {
    expect(() => loadConfig({ WEBHOOK_SECRET: 'short' })).toThrow('WEBHOOK_SECRET');
  });

  it('設定ファイルが無ければ環境変数だけで LINE の 1 チャネル', () => {
    const c = loadConfig({ WEBHOOK_SECRET: SECRET, CONFIG_PATH: undefined, LINE_TO: 'Ua, Ub' });
    expect(c.port).toBe(8080);
    expect(c.channels).toEqual([{ id: 'line', type: 'line', to: ['Ua', 'Ub'] }]);
  });

  it('CONFIG_PATH を指定してファイルが無ければ失敗', () => {
    expect(() =>
      loadConfig({ WEBHOOK_SECRET: SECRET, CONFIG_PATH: '/nonexistent.json' }),
    ).toThrow();
  });

  it('設定ファイルを読む', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    const path = join(dir, 'config.json');
    writeFileSync(
      path,
      JSON.stringify({
        channels: [{ id: 'a', type: 'line', tokenEnv: 'T_A' }],
        defaultChannels: ['a'],
      }),
    );
    const c = loadConfig({ WEBHOOK_SECRET: SECRET, CONFIG_PATH: path, PORT: '3000' });
    expect(c).toEqual({
      port: 3000,
      webhookSecret: SECRET,
      channels: [{ id: 'a', type: 'line', tokenEnv: 'T_A' }],
      defaultChannels: ['a'],
    });
  });
});

describe('parseChannels', () => {
  it('id の重複・未対応の type・空を拒否', () => {
    expect(() => parseChannels([])).toThrow();
    expect(() =>
      parseChannels([
        { id: 'a', type: 'line' },
        { id: 'a', type: 'line' },
      ]),
    ).toThrow('重複');
    expect(() => parseChannels([{ id: 'a', type: 'smtp' }])).toThrow('未対応');
  });
});
