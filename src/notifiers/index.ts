import type { Notifier } from '../types.ts';
import { type LineChannelConfig, LineNotifier, type LineNotifierOptions } from './line.ts';

/** 設定の channels[] の 1 件。経路を足すときはここに union で足す */
export type ChannelConfig = LineChannelConfig;

export interface NotifierDeps {
  env: NodeJS.ProcessEnv;
  line?: LineNotifierOptions;
}

/** 設定から Notifier を作る */
export function createNotifier(config: ChannelConfig, deps: NotifierDeps): Notifier {
  switch (config.type) {
    case 'line':
      return new LineNotifier(config, deps.env, deps.line);
    default: {
      const unknown: { type?: unknown; id?: unknown } = config;
      throw new Error(`[${String(unknown.id)}] 未対応の type: ${String(unknown.type)}`);
    }
  }
}
