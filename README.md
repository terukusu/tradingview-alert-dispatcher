# tradingview-alert-dispatcher

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

Node 24 が必要です（TypeScript をビルドなしで動かします）。手元での送信の確認は次のとおりです（実際に LINE に届きます）。

```sh
curl -X POST "localhost:8080/webhook?key=$WEBHOOK_SECRET" -d 'テスト'
```

コンテナで動かすときは次のとおりです（実行時の依存が無いので、イメージには `package.json` と `src/` だけが入ります。`config.json` を使うなら `-v "$PWD/config.json:/app/config.json:ro"` を足します）。

```sh
docker build -t dispatcher:local .
docker run --rm -p 8080:8080 --env-file .env dispatcher:local
.github/scripts/image-check.sh dispatcher:local   # イメージの検査（非 root・中身・/health・未認証 401・SIGTERM での終了）
```

`GET /health` が 200 `ok` を返します。SIGTERM・SIGINT を受けると新しい受付を止め、送信中の配信が終わるのを待ってから（最大 9 秒）終了します。

### 4. TradingView のアラート

アラートの「Webhook URL」に `https://<ホスト>/webhook` を入れ、メッセージを JSON にして `"secret"` にシークレットを入れます（URL にシークレットを入れると、URL が残る場所から漏れやすいため）。

```json
{
  "secret": "<WEBHOOK_SECRET>",
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
| `secret` | webhook の共有シークレット（本文には出ません） |

テキストのメッセージと URL の `?key=<WEBHOOK_SECRET>` での認証も受け付けますが、手元での確認用です（「3. 起動」の curl）。

## 本番（Cloud Run）

GCP の Cloud Run で動かす構成を `infra/`（Terraform）と `.github/workflows/deploy.yml` に置いています。

- 土台（WIF・SA・Artifact Registry・tfstate・Secret Manager の入れ物）は `infra/bootstrap` を所有者が手元で 1 回 apply します。シークレットの値は Secret Manager に入れ、Terraform・リポジトリには持たせません
- サービスは `infra/prod`。main へのマージごとに `deploy.yml` が plan し、ジョブの要約（アドレスと操作だけ）を確かめて GitHub の Environment `prod` を承認すると、イメージのビルド・push と apply が走ります。差分が無いマージ（ドキュメントだけ）では承認待ちは出ません
- 本番の TradingView のアラートは JSON の `"secret"` でシークレットを渡します（`?key=` は使わない。Cloud Run のリクエストログに URL が残るため）
- 手順（GitHub の設定・初回デプロイ・更新・切り戻し）は `infra/README.md`、設計の判断は `docs/design.md` にあります

## 開発

```sh
npm ci
npm run typecheck && npm run lint && npm test
.github/scripts/repo-values-check.test.sh   # 個人の値・秘匿情報の形の検査
docker build -t dispatcher:ci . && .github/scripts/image-check.sh dispatcher:ci   # イメージのビルドと検査（CI と同じ）
```

構成と約束ごとは `CLAUDE.md` にあります。

## ライセンス

MIT
