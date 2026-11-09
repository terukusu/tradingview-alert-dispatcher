# tradeview-alert-dispatcher

TradingView のアラートを webhook で受けて、LINE などの複数の通知先にまとめて送る小さなサーバーです。1 つのアラートを、設定した複数の経路へ並行して届けます（いまの経路は LINE。ほかの経路は順次追加）。

## しくみ

```
TradingView ──POST /webhook──▶ dispatcher ──┬─▶ LINE（push / multicast / broadcast）
                                            └─▶ （今後: Slack・Discord など）
```

- 受け取ったらすぐ 200 を返し、送信は裏で行います（TradingView は応答を 3 秒しか待ちません）
- 1 つの経路が失敗しても、ほかの経路には届きます。結果は 1 行 JSON のログに出ます

## 使い方

### 1. LINE の準備

1. [LINE Developers](https://developers.line.biz/) で Messaging API のチャネルを作る
2. 「チャネルアクセストークン（長期）」を発行する
3. 送り先を決める
   - 友だち全員に送るなら何もしない（broadcast）
   - 特定の人・グループに送るなら、その userId / groupId を控える

### 2. 設定

```sh
cp .env.example .env   # WEBHOOK_SECRET・LINE_CHANNEL_ACCESS_TOKEN・LINE_TO を入れる
```

| 環境変数 | 意味 |
|---|---|
| `WEBHOOK_SECRET` | webhook の共有シークレット（16 文字以上。`openssl rand -hex 24` など） |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE のチャネルアクセストークン |
| `LINE_TO` | 送り先の ID（カンマ区切り）。空なら broadcast |
| `PORT` | 待ち受けるポート（既定 8080） |
| `CONFIG_PATH` | 送り先の設定ファイル（既定 `config.json`。無ければ上の環境変数だけで動く） |

複数のチャネル（例: 個人用とグループ用の LINE、別の公式アカウント）を使い分けるときは `config.example.json` を `config.json` にコピーして書きます。トークンは設定ファイルに書かず、`tokenEnv` で環境変数の名前を指定します。

### 3. 起動

```sh
npm ci
npm start
```

Node 24 が必要です（TypeScript をビルドなしで動かします）。

### 4. TradingView のアラート

アラートの「Webhook URL」に `https://<ホスト>/webhook?key=<WEBHOOK_SECRET>` を入れます。メッセージはテキストでも JSON でもかまいません。

```json
{
  "title": "{{ticker}} シグナル",
  "message": "{{ticker}} が {{close}} で条件に到達（{{interval}}）",
  "channels": ["line-me"]
}
```

| フィールド | 意味 |
|---|---|
| `title` | 見出し（任意） |
| `message` | 本文。無ければ JSON 全体を本文にします |
| `channels` | 送り先のチャネル ID（配列かカンマ区切り。省略すると既定の送り先） |
| `secret` | URL に `?key=` を付けない場合のシークレット（本文には出ません） |

## 開発

```sh
npm ci
npm run typecheck && npm run lint && npm test
.github/scripts/repo-values-check.test.sh   # 個人の値・秘匿情報の形の検査
```

構成と約束ごとは `CLAUDE.md` にあります。

## ライセンス

MIT
