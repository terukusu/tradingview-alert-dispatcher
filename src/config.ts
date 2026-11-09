import { existsSync, readFileSync } from 'node:fs';
import type { ChannelConfig } from './notifiers/index.ts';

export interface AppConfig {
  port: number;
  /** webhook の共有シークレット。URL の ?key= か JSON の secret で受ける */
  webhookSecret: string;
  channels: ChannelConfig[];
  /** alert に channels の指定が無いときの送り先。省略なら全チャネル */
  defaultChannels: string[] | undefined;
}

interface FileConfig {
  channels?: unknown;
  defaultChannels?: unknown;
}

/**
 * 設定を読む。
 *
 * - シークレット・トークンは環境変数だけ（WEBHOOK_SECRET・LINE_CHANNEL_ACCESS_TOKEN など）
 * - 送り先は CONFIG_PATH（既定 config.json）の JSON。ファイルが無ければ環境変数だけで
 *   LINE の 1 チャネル（id: "line"、送り先 LINE_TO（カンマ区切り。空なら broadcast））を作る
 */
export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const webhookSecret = env.WEBHOOK_SECRET ?? '';
  if (webhookSecret.length < 16) {
    throw new Error('環境変数 WEBHOOK_SECRET を 16 文字以上で設定する');
  }
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('環境変数 PORT が不正');
  }

  const path = env.CONFIG_PATH ?? 'config.json';
  if (!existsSync(path)) {
    if (env.CONFIG_PATH) throw new Error(`CONFIG_PATH のファイルが無い: ${path}`);
    const to = (env.LINE_TO ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      port,
      webhookSecret,
      channels: [{ id: 'line', type: 'line', to }],
      defaultChannels: undefined,
    };
  }

  const file = JSON.parse(readFileSync(path, 'utf8')) as FileConfig;
  return {
    port,
    webhookSecret,
    channels: parseChannels(file.channels),
    defaultChannels: parseIdList(file.defaultChannels, 'defaultChannels'),
  };
}

export function parseChannels(v: unknown): ChannelConfig[] {
  if (!Array.isArray(v) || v.length === 0) {
    throw new Error('設定の channels は 1 件以上の配列にする');
  }
  const seen = new Set<string>();
  return v.map((c: unknown, i) => {
    if (c === null || typeof c !== 'object') throw new Error(`channels[${i}] がオブジェクトでない`);
    const { id, type, tokenEnv, to } = c as Record<string, unknown>;
    if (typeof id !== 'string' || id === '') throw new Error(`channels[${i}].id が無い`);
    if (seen.has(id)) throw new Error(`channels の id が重複: ${id}`);
    seen.add(id);
    if (type !== 'line') throw new Error(`channels[${i}].type が未対応: ${String(type)}`);
    const config: ChannelConfig = { id, type };
    if (tokenEnv !== undefined) {
      if (typeof tokenEnv !== 'string') throw new Error(`channels[${i}].tokenEnv が文字列でない`);
      config.tokenEnv = tokenEnv;
    }
    const toList = parseIdList(to, `channels[${i}].to`);
    if (toList) config.to = toList;
    return config;
  });
}

function parseIdList(v: unknown, name: string): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((s) => typeof s === 'string' && s !== '')) {
    throw new Error(`${name} は文字列の配列にする`);
  }
  return v as string[];
}
