/** TradingView から受け取ったアラートを正規化したもの */
export interface Alert {
  /** 任意のタイトル（JSON の title） */
  title: string | undefined;
  /** 通知の本文 */
  message: string;
  /** 送り先チャネル ID の指定（JSON の channels）。undefined なら既定の送り先 */
  channels: string[] | undefined;
  /** 受け取った時刻 */
  receivedAt: Date;
}

/** 通知の経路（LINE / Slack / Discord ...）の共通の口 */
export interface Notifier {
  /** チャネル ID（設定の channels[].id） */
  readonly id: string;
  /** 種類（line など） */
  readonly type: string;
  /** 送る。失敗したら例外を投げる */
  send(alert: Alert): Promise<void>;
}

export interface DispatchResult {
  channel: string;
  ok: boolean;
  error?: string;
  elapsedMs: number;
}
