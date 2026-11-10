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
| `ALLOWED_SOURCE_IPS` | 送信元 IP の許可リスト（カンマ区切りの IPv4。既定は空 = 制限なし）。設定すると `GET /health` 以外は一覧に無い送信元を 403 で退けます。送信元は `X-Forwarded-For` の末尾（無ければ接続元）で判定するので、Cloud Run のように `X-Forwarded-For` を付け足すフロントの後ろでだけ使います（直接公開すると偽装できます） |

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

アラートの「Webhook URL」に `https://<ホスト>/webhook` を入れ、メッセージを JSON にして `"secret"` にシークレットを入れます（例と本番の手順は下の「本番（Cloud Run）」の後の節）。

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
- 本番の TradingView のアラートは JSON の `"secret"` でシークレットを渡します（手順は下の節）
- 本番は送信元 IP の許可リストを TradingView の webhook の送信元 4 つ（公開の値。`infra/prod` の変数 `allowed_source_ips`）にしています。ほかの送信元からのリクエストは本文を読む前に 403 で、そのログ（`forbidden` とリクエストログの 401・403）は保存しません（`docs/design.md`「送信元 IP の許可リスト」「弾いたリクエストのログ」）。TradingView の送信元 IP が変わったら `allowed_source_ips` を直します
- 手順（GitHub の設定・初回デプロイ・更新・切り戻し）は `infra/README.md`、設計の判断は `docs/design.md` にあります

## TradingView のアラートの設定

本番（Cloud Run のサービス `tvad`）へ送るアラートの作り方です。URL とシークレットは手元で取り出してシェルの変数にだけ入れ、画面・Issue・PR に出しません。

1. TradingView のアカウントで **2 段階認証** を有効にする（webhook を使う条件です）
2. Webhook URL とシークレットを取り出してクリップボードに入れる（gcloud の認証済みの手元で。`pbcopy` は macOS、Linux は `wl-copy` か `xclip -selection clipboard`）

   ```bash
   URL=$(gcloud run services describe tvad --region=asia-northeast1 --format='value(status.url)')   # 表示しない
   SECRET=$(gcloud secrets versions access latest --secret=tvad-webhook-secret)                       # 表示しない
   printf '%s/webhook' "$URL" | pbcopy   # 3. の Webhook URL に貼る
   printf '%s' "$SECRET" | pbcopy        # 3. のメッセージの "secret" の値に貼る
   unset URL SECRET
   ```

3. アラートを作る: 「通知」で Webhook URL を有効にして `https://<SERVICE_URL>/webhook` を入れ（ポートは https の 443。TradingView は 80 / 443 にしか送りません）、「メッセージ」に JSON を書く

   ```json
   {
     "secret": "<WEBHOOK_SECRET の値>",
     "title": "{{ticker}} シグナル",
     "message": "{{ticker}} が {{close}} で条件に到達（{{interval}}）"
   }
   ```

   - `{{ticker}}`・`{{close}}`・`{{interval}}`・`{{exchange}}`・`{{time}}` などのプレースホルダは、TradingView が発火のときに値に置き換えます
   - `channels` は省略します（本番は環境変数だけの LINE の 1 チャネル `line`。書くなら `"channels": ["line"]`。設定に無い ID には送らず、ログに `未知のチャネル` が出ます）
   - 「メッセージを編集」で、プレースホルダ入りの JSON に次の 2 行の警告（データ形式をよく確認してください、という趣旨）が出ることがあります
     - 「JSON形式で入力している場合、データ形式が正しいかご確認ください。」
     - 「Expected ',' or '}' after property value in JSON at position …」

     この警告が出ても、プレースホルダが `"…"` の中にあれば保存・送信は正しく動きます。そのまま適用して保存して構いません（上の形の JSON で、プレースホルダが値に置き換わって LINE に届くことを確認済みです）。示される位置はプレースホルダ（`{{ticker}}` など）の中で、保存のときの検査がプレースホルダを仮の値に置き換えてから JSON として読んでいるためとみられます（推測。TradingView の公式の説明は見つかっていません）
   - 書き方の注意:
     - プレースホルダは `"…"` の文字列の中に入れる（`{{close}}` のような数値も `"…"` の中）
     - 引用符がスマートクォート（`“ ”`）になっていないか。チャット・メモ帳・入力の自動置換からコピーすると置き換わることがあります
     - `{{strategy.order.comment}}`・`{{strategy.order.alert_message}}`・`{{plot("…")}}` など、値に `"`・改行が入りうるプレースホルダは発火のときに JSON を壊すことがあります
   - 確かめ方: 手元で `JSON.parse` できるかを見ます。**シークレットを外部の検査サービス（Web の JSON バリデータなど）に貼らない** でください。エラーの内容（入力の断片 = シークレットを含みうる）を出さない形で確かめます（`pbpaste` は macOS、Linux は `wl-paste` か `xclip -o -selection clipboard`）。`jq` なら `jq empty`（`jq .` は全文 = シークレットを表示するので使わない）

     ```bash
     pbpaste | node -e 'try{JSON.parse(require("fs").readFileSync(0,"utf8"));console.log("ok")}catch{console.log("NG")}'
     ```

   - JSON が壊れていても（値に `"` が入る、スマートクォート、カンマの抜けなど）、`"secret": "…"` の形（引用符で囲んだキー・コロン・引用符で囲んだ値）が 1 つだけ読めれば認証し、`secret` の部分を除いた本文をテキストのまま送ります（見出しの `title` は付かず、JSON の形のまま届きます）。`secret` が読めない（2 つある・空・閉じの引用符が無い）と 401 で送られず、ログは `unauthorized` です。TradingView は再送しません
   - **本番のメッセージは `"secret"` のキーと値を含む JSON にします**（`secret` の無いテキストのアラートは使えません）。URL の `?key=` で渡すと Cloud Run のリクエストログに URL（クエリ文字列）ごと残るためです
4. 届いたかを確かめる: TradingView の「アラートのログ」の **Webhook status**（送れたか）と、下の「運用」のログの `dispatched`（各経路に送れたか）。確かめのアラートの本文は架空の内容にします（LINE の送信数を 1 通使います）
   - トリガーが「毎回」だと、条件（価格の交差など）を満たすたびに発火し、そのたびに LINE の無料枠（月 200 通。ほかの通知と共用ならその分も合算）を 1 通ずつ使います。確かめが済んだらテストのアラートを停止・削除します

## 運用

### ログの見方

アプリのログは 1 行 JSON です（本文・`title`・シークレット・トークン・送り先 ID は出しません）。1 つのアラートにつき `msg=dispatched` が 1 件出て、`results` にチャネルごとの `channel`・`ok`・`elapsedMs`・`error` が入ります。絞り込みは `jsonPayload.msg="dispatched"`（配信の結果）と `jsonPayload.msg="unauthorized"`（認証の失敗）です。本番では送信元 IP の許可リストがあるので、`unauthorized` は TradingView の送信元から来てシークレットが違うもの（アラートのメッセージの誤りなど）です。許可リストで弾いた `forbidden` の行と、401・403 のリクエストログは保存しません（件数は下の指標で見ます）。

```bash
F='resource.type="cloud_run_revision" AND resource.labels.service_name="tvad"'
# 配信の結果（直近 1 日）
gcloud logging read "$F AND jsonPayload.msg=\"dispatched\"" --freshness=1d --format=json \
  | jq -c '.[] | {t: .timestamp, results: .jsonPayload.results}'
# 失敗した経路（どれかの経路が ok: false だと severity は ERROR。LINE の月の上限の 429 もここ）
gcloud logging read "$F AND jsonPayload.msg=\"dispatched\" AND severity>=ERROR" --freshness=7d --format=json \
  | jq -c '.[] | {t: .timestamp, failed: [.jsonPayload.results[] | select(.ok == false) | {channel, error}]}'
# 認証の失敗（TradingView の送信元からのシークレットなし・違い）の件数。あればアラートのメッセージの "secret" を確かめる
gcloud logging read "$F AND jsonPayload.msg=\"unauthorized\"" --freshness=1d --format='value(timestamp)' | wc -l
# アプリ以外も含めたエラー
gcloud logging read "$F AND severity>=ERROR AND NOT jsonPayload.msg=\"dispatched\"" --freshness=1d --format='value(timestamp,jsonPayload.msg)'
```

許可リストで弾いた件数（403）は、Cloud Monitoring の Metrics Explorer で指標 `run.googleapis.com/request_count`（Cloud Run Revision の Request Count）を `service_name=tvad`・`response_code=403` で絞って見ます（ログの除外と無関係で、指標は無料です）。

TradingView の Webhook status が失敗なのに `dispatched` も `unauthorized` も無いときは、URL の誤りか、リクエストが届いていないか、許可リストで 403 になっています（TradingView の送信元 IP が変わった可能性。上の指標の 403 と、TradingView の公式ページの IP を `infra/prod` の `allowed_source_ips` と照らす。403 のリクエストログは保存しないので、200 などほかのステータスは `httpRequest.status` で見る）。

### LINE の無料枠

LINE の送信数は月ごとに数えられ、上限を超えると 429 で送られません（`docs/design.md`「broadcast と LINE の無料枠」）。同じチャネルをほかの通知と共用しているときは、その分も数に入ります。今月の送信数と上限は次で見ます（トークンは変数にだけ入れ、ヘッダは標準入力で渡してコマンドラインの引数にも出しません）。

```bash
T=$(gcloud secrets versions access latest --secret=tvad-line-channel-access-token)   # 表示しない
printf 'Authorization: Bearer %s' "$T" | curl -s -H @- https://api.line.me/v2/bot/message/quota/consumption; echo   # {"totalUsage":<今月の送信数>}
printf 'Authorization: Bearer %s' "$T" | curl -s -H @- https://api.line.me/v2/bot/message/quota; echo               # {"type":"limited","value":<上限>}（上限なしは "none"）
unset T
```

### シークレットの入れ替え

1. 所有者が Secret Manager に新しい版を足す（標準入力から。値を表示しない）
2. `infra/prod` の変数 `secret_version` をその版の番号にする PR を出し、`deploy.yml` で反映する（承認の後の apply で新しいリビジョンができ、すべてのインスタンスが新しい値になる）。`gcloud run services update` は使わない
3. webhook のシークレットなら、新しいリビジョンに切り替わってから TradingView のアラートのメッセージの `"secret"` を書き換える（その間は 401 で送られないので、アラートが出ない時間帯に行う）

版の番号は 3 つのシークレットに共通です。番号のそろえ方と確かめ方を含む手順は `infra/README.md`「シークレットの値の入れ替え」にあります。

### 切り戻し

デプロイの切り戻しは `infra/README.md`「切り戻し」（revert の PR を同じ経路でデプロイ。急ぐときは前のリビジョンに traffic を移す）。

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
