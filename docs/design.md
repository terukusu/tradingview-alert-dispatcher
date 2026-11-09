# 設計（tradingview-alert-dispatcher）

TradingView のアラート（webhook）を受けて複数の経路（第一弾は LINE）に送る中継サーバーを、GCP の Cloud Run で本番運用するための設計。受け口・送信のタイミング・シークレット・GCP の構成・ログなど、後続の実装（コンテナ・bootstrap・Cloud Run・通し確認）が判断基準にする決定をまとめる。

- この文書が **決定事項の正**。実装が設計と違うときは、同じ PR でこの文書を更新する
- 論点は `### <論点>` の見出しと、その直下の `- 状態: 決定` か `- 状態: 判断待ち` の 1 行で書く（`### ` は論点だけに使う）。マージの時点で判断待ちは残さない
- 決定日: 2026-11-09（オーナー判断）
- 「#N で反映」などと書いた決定は、その Issue が終わるまでコードと食い違う。反映したら、その記述を反映済みの事実に書き換える
- 「未確認」と書いた事実は、公式ドキュメントで確かめていない。断定せず、確かめる Issue を書いておく

## 前提（外部の仕様）

- TradingView の webhook: 送り先のポートは 80 / 443 だけ、応答を 3 秒待って打ち切る、送信元の IPv4 は 4 つの固定、再送の記載なし、webhook を使うには 2 段階認証が必須、IPv6 は非対応 — https://www.tradingview.com/support/solutions/43000529348-about-webhooks/
- TradingView のアラートの設定には URL とメッセージの欄だけがあり、任意のヘッダを付ける欄が無い（上のページには記載なし。設定画面の観察）。認証の情報は URL か本文で渡すしかない
- このリポジトリの実装の値:
  - LINE 経路の 1 チャネルの送信全体の締め切り 8 秒（multicast の全分割・再試行・待ちを含む。1 回の試行のタイムアウト 5 秒、再試行 2 回、待ち 0.5 秒・1 秒。`src/notifiers/line.ts` の `SEND_DEADLINE_MS`・`ATTEMPT_TIMEOUT_MS`・`MAX_RETRIES`・`retryDelayMs`）
  - 停止時に処理中の配信を待つ上限 9 秒（`src/server.ts` の `SHUTDOWN_TIMEOUT_MS`）
  - 本文の上限 64 KiB（`src/server.ts` の `MAX_BODY_BYTES`。超えたら 413）
- 観測（2026-11-09、読み取りのみ。値はリポジトリに書かない）:
  - 同じ GCP プロジェクトの既存 3 サービスに `allUsers` の `roles/run.invoker` は 0 件。このサービスがプロジェクトで最初の未認証で呼べるサービスになる
  - Cloud Run のリクエストログの `httpRequest.requestUrl` にはクエリ文字列が残る（既存サービスのリクエストログで確認。件数のみ）
  - プロジェクトは組織に属さない
  - 既存 3 サービスのリージョンは asia-northeast1

## 公開の受け口と認証

### 公開方式（invoker_iam_disabled）
- 状態: 決定
- 決定: Cloud Run の Invoker の IAM チェックを無効化する（`invoker_iam_disabled = true`）。ingress は `all`（TradingView はインターネットから来る）。プロジェクトで初めての未認証で呼べるサービスにすることはオーナーが承認済み
- 理由: Google の推奨の方式で、IAM ポリシーに `allUsers` が載らない（既存サービスの `allUsers` 0 件という比較を崩さない）。TradingView は任意のヘッダを付けられないので、IAM や IAP の後ろには置けない。認証はアプリの共有シークレットで行う
- 退けた案: `allUsers` に `roles/run.invoker` を付ける（IAM ポリシーに公開が残り、棚卸しで紛れる）。IAP（TradingView が通れない）
- 注: Terraform の Google プロバイダが `invoker_iam_disabled` を持つ版かは **未確認**。#4 で公式ドキュメントで確かめる
- 出典: https://docs.cloud.google.com/run/docs/authenticating/public

### シークレットの渡し方（?key= と secret）
- 状態: 決定
- 決定: 本番の TradingView のアラートは JSON の `secret` で共有シークレットを渡す。`?key=` はコードに残す（後方互換・ローカルでの確認用）が、本番の手順では使わない
- 理由: Cloud Run のリクエストログにはクエリ文字列が残る（前提の観測）ので、`?key=` だとシークレットがリクエストログに載る。本文はアプリもログに出さない
- 制約: 本番ではテキストのアラートは使えない（JSON が必須）
- 退けた案: 本番も `?key=`（リクエストログにシークレットが載る）。本番で `?key=` を拒む設定をコードに足す（コードが増える。必要になれば別 Issue）
- #5 の手順書と README の TradingView の例は JSON の `secret` で書く（README は JSON の `secret` の例にした）

### 送信元 IP の許可リスト
- 状態: 決定
- 決定: 置かない
- 理由: 共有シークレット（定数時間で比較）と最大インスタンス数の上限で足りる。送信元 IP の変更に追従する保守が要らない
- 退けた案: アプリで `X-Forwarded-For` を見る（別 Issue が要り、保守が増える）。ロードバランサ + Cloud Armor（EPIC のスコープ外）
- 再検討の条件: 不正なリクエスト（`unauthorized` のログ）が目立って増えたとき。TradingView の送信元 IPv4 は 4 つの固定とされているが、将来も変わらない保証はない
- 出典: https://www.tradingview.com/support/solutions/43000529348-about-webhooks/

### 乱用への備え
- 状態: 決定
- 決定: 本文の上限 64 KiB（実装済み。超えたら 413）、最大インスタンス数を小さくする（値は #4 で決める）、認証に失敗したら 401 を返して配信しない（実装済み）
- 理由: 未認証で呼べる受け口なので、費用と送信数が際限なく増えるのを防ぐ
- 退けた案: アプリにレート制限を入れる（インスタンス間で共有できず、この規模では over-engineering）

## 送信のタイミング

### 送信のタイミング
- 状態: 決定
- 決定: いまの実装どおり **200 を先に返してから送る**。そのうえで Cloud Run を instance-based billing にする（`cpu_idle = false` / `--no-cpu-throttling`。メモリ 512 MiB 以上が条件）
- 数値:
  - TradingView は応答を 3 秒待って打ち切る
  - LINE 経路の送信全体の締め切りは 8 秒（試行 5 秒、再試行 2 回、待ち 0.5 秒・1 秒）
  - インスタンスの停止は SIGTERM から SIGKILL まで 10 秒
- 理由: 既定の request-based billing はリクエストの処理中だけ CPU を割り当て、応答の後の処理（background activity）は CPU が止まるか大きく絞られるので、応答の後の送信が止まりうる。送ってから応答する方式では LINE の締め切り 8 秒が 3 秒に収まらず、同じ `X-Line-Retry-Key` での再試行を削る必要がある
- 費用: instance-based billing はアイドル中のインスタンスにも課金される。料金の数値（単価・無料枠）は **未確認**。#5 の前に https://cloud.google.com/run/pricing で確かめる（この文書には数値を書かない）
- 退けた案: 応答の後に送る + request-based billing（いまの実装のままでは送信が止まりうるので、EPIC の終了条件 3 を満たせない）。送ってから応答する（LINE のタイムアウトと再試行を 3 秒の中に縮める必要があり、再試行の余地がほぼ無くなる）
- 出典: https://docs.cloud.google.com/run/docs/configuring/billing-settings 、https://docs.cloud.google.com/run/docs/tips/general

### 最小インスタンス数
- 状態: 決定
- 決定: 0 で始める。#5 でコールドスタートを含む 10 回の応答がすべて 3 秒未満かを測り、超えたら 1 にするかを再判断する
- 理由: 費用を最小にし、まず実測する
- 退けた案: 最初から 1（実測の前に常時の費用を払う）

### インスタンス停止時の扱い
- 状態: 決定
- 決定: SIGTERM を受けたら新しいリクエストの受付を止め、送信中の配信（本文の読み込みから応答の後の送信と結果のログまで）を待ってから終了する。待ちは SIGKILL までの 10 秒の中に収める: LINE の送信全体の締め切り 8 秒 < 停止時の待ちの上限 9 秒（`SHUTDOWN_TIMEOUT_MS`）< SIGKILL の 10 秒。上限で打ち切ったら残りの件数を `WARNING` のログに出し、終了コードは 0。終了中に既存の接続で届いたリクエストは 503 を返して送らない
- 残るリスク: 猶予を超える配信は欠けうる（再送のキューは EPIC のスコープ外）。最小インスタンス数 0 のアイドルのインスタンスは最長 15 分で停止される
- 退けた案: 再試行の最悪時間（当時 33 秒）を放置する（停止と重なると確実に欠ける）。Cloud Tasks / Pub/Sub で再送のキューを持つ（EPIC のスコープ外）
- 出典: https://docs.cloud.google.com/run/docs/container-contract

## シークレットの置き場

### シークレットの置き場（Secret Manager）
- 状態: 決定
- 決定: Secret Manager に置き、Cloud Run の環境変数として渡す（`secretKeyRef`）。対象は `WEBHOOK_SECRET`・`LINE_CHANNEL_ACCESS_TOKEN`・`LINE_TO`（送り先 ID は秘密ではないが、リポジトリと Terraform の state に置かない値）。実行用の SA にはシークレット単位の `roles/secretmanager.secretAccessor` だけを付ける。値の投入は所有者が手元で行い、Terraform に値を持たせない（state に載せない）。本番では `CONFIG_PATH` の JSON（複数チャネル）を使わず、環境変数だけの LINE の 1 チャネルで始める
- 仕様: シークレットはインスタンスの起動前に解決され、取れなければインスタンスは起動しない
- 理由: 平文の環境変数や state に値が残らない。権限をシークレット単位に絞れる
- 退けた案: 平文の環境変数（Cloud Run の設定に値が見える）。Terraform で値を持つ（state に載る）。ボリュームとしてマウント（いまのコードは環境変数を読むので変更が要る）
- 出典: https://docs.cloud.google.com/run/docs/configuring/services/secrets

### シークレットの版
- 状態: 決定
- 決定: 版は Terraform の変数で指定し、既定は `latest`。ローテーションは新しいリビジョンを作ることで反映する、と手順に書く
- 理由: 運用が簡単（値を更新するたびに apply しなくてよい）
- 注: `latest` も起動時に解決され、取れなければ起動しない。#5 の手順に書く
- 退けた案: 常に版を固定する（Google の推奨だが、値を更新するたびに apply が要る）
- 出典: https://docs.cloud.google.com/run/docs/configuring/services/secrets

### broadcast と LINE の無料枠
- 状態: 決定
- 決定: 本番では `LINE_TO`（送り先）を必須の手順にし、broadcast（送り先 0 件）は使わない
- 事実:
  - 日本のコミュニケーションプランは月 200 通まで無料で、送った人数で数える。上限を超えるとエラーになり送られない（結果は `ok: false` のログになる）
  - 月の上限を超えたときは 429（`message` は `You have reached your monthly limit.`）。429 はレート制限・同時実行数の上限でも返る。公式の再試行のガイドは 5xx・タイムアウトを再試行し、409 と 429 を含む 4xx は再試行しないとしている。これに合わせて LINE 経路は 429 を再試行しない
- 未確認:
  - broadcast が友だちの人数ぶん数えられることは、ページに明記されていない（「送った人数で数える」という記述からの推論）
- 理由: broadcast は友だちになった第三者にも届き、無料枠を人数ぶん消費する
- 退けた案: 本番で broadcast を許す
- 出典: https://developers.line.biz/en/docs/messaging-api/pricing/ 、https://developers.line.biz/en/reference/messaging-api/#status-codes 、https://developers.line.biz/en/reference/messaging-api/#error-responses 、https://developers.line.biz/en/docs/messaging-api/retrying-api-request/

## ヘルスチェックのパス

### ヘルスチェックのパス
- 状態: 決定
- 決定: ヘルスチェックは `GET /health`（200 `ok`）。旧パスの `/healthz` は 404。`/health` は外から呼べる前提で、`ok` 以外を返さない。起動プローブは既定の TCP のままにする
- 理由: Cloud Run は `/_ah/` で始まるパスと、末尾が `z` の一部のパスを予約していて、末尾が `z` のパスは避けるよう推奨している。`/health` は末尾が `z` でも `/_ah/` 始まりでもない
- 未確認: HTTP のプローブがコンテナの中から届くか（`/health` を HTTP の起動プローブに使えるか）はドキュメントに記載がない。使うなら #4 で実機で確かめる
- 退けた案: `/healthz` を残す（外からは 404 になりうる）
- 出典: https://docs.cloud.google.com/run/docs/known-issues 、https://docs.cloud.google.com/run/docs/configuring/healthchecks

## GCP の構成

### WIF・tfstate・Artifact Registry
- 状態: 決定
- 決定: Workload Identity Federation のプール・プロバイダ、tfstate のバケット、Artifact Registry のリポジトリはすべてこのリポジトリ用に新設する。IAM の付与は追加型（`*_iam_member`）だけにし、既存の authoritative な IAM を書き換えない。GCP のプロジェクト ID などは `TF_VAR_*` か未追跡の tfvars で渡し、リポジトリに書かない。bootstrap は所有者が手元で apply し、prod は deploy.yml が GitHub の Environment `prod` の承認を得てから apply する
- 理由: 同じプロジェクトの既存の WIF のプール 2 つのプロバイダは、それぞれ別リポジトリの数値 ID に固定されている。流用すると別リポジトリが管理するリソースの変更になり、他リポジトリの権限に波及する（EPIC の終了条件 6 に触れる）
- 退けた案: 既存の WIF・tfstate のバケット・Artifact Registry を流用する

### リージョン
- 状態: 決定
- 決定: asia-northeast1
- 理由: 既存 3 サービスと同じ。TradingView からの往復の差は 3 秒の打ち切りに対して小さい
- 退けた案: ほかのリージョン（選ぶ根拠が無い）

### API の有効化
- 状態: 決定
- 決定: run・artifactregistry・secretmanager・iamcredentials・sts の API は有効化済み（2026-11-09 に観測）なので、Terraform では有効化しない。足りない API が出たら #3 で追加する（`disable_on_destroy = false`）
- 理由: 既存サービスも使う API を、このリポジトリの destroy で止めないため
- 退けた案: すべての API を Terraform で管理する（destroy で既存サービスが使う API を止めうる）

## ログ

### ログの項目
- 状態: 決定
- 決定: ログは 1 行 JSON（`severity` つき。Cloud Logging がそのまま読む）
  - 出す: `msg=dispatched` とチャネルごとの `ok`・`elapsedMs`・`error`、認証失敗の `msg=unauthorized`（`WARNING`）、停止時の `msg=shutdown` / `msg=shutdown timeout` と残りの件数
  - 出さない: 本文・シークレット・トークン・送信先 ID・アラートの `title`
- Cloud Run のリクエストログのクエリ文字列は、本番で `?key=` を使わない運用（「シークレットの渡し方」）で避ける
- #5 で使う絞り込み: `jsonPayload.msg="dispatched"` の件数と、各チャネルの `ok` の値。認証失敗は `jsonPayload.msg="unauthorized"` の件数
- 理由: `title` には銘柄が入りうるので、ログに残る。#5 でログを要約するときに混じりうる
- 退けた案: `title` を出し続ける

## 後続 Issue への引き継ぎ

- #2（コンテナ・CI・コード変更）:
  - ヘルスチェックを `GET /health` に変える
  - SIGTERM で新しい受付を止め、送信中の配信を待ってから終了する
  - LINE のタイムアウトと再試行の総時間を停止の猶予 10 秒に収める（対象は 1 リクエストではなく 1 チャネルの送信全体。送り先が 501 件以上で multicast を分けて送る場合も含む）
  - ログから `title` を外す
  - LINE の月の上限を超えたときのステータスコードを API リファレンスで確かめ、再試行の対象にするかを決める
  - Dockerfile とイメージの検査（`PORT` の注入、0.0.0.0 で待ち受け）
  - README の TradingView の例を JSON の `secret` にする
- #3（bootstrap）:
  - WIF のプール・プロバイダ、実行用とデプロイ用の SA、Artifact Registry、tfstate のバケット、Secret Manager の入れ物（値は入れない）を新設する
  - IAM は追加型だけ。API は有効化済み
  - `CLAUDE.md`・implement-issue スキルの「`infra/` が無い間はデプロイ対象なし」と、`CLAUDE.md` の「設計は `docs/design.md`（あれば）」を実態に合わせる
- #4（prod の Cloud Run・deploy.yml）:
  - `invoker_iam_disabled = true`（Terraform プロバイダの対応版を確かめる）、ingress `all`
  - instance-based billing（`cpu_idle = false`、メモリ 512 MiB 以上）、最小インスタンス数 0、最大インスタンス数は小さく
  - リージョン asia-northeast1
  - `secretKeyRef`（版は変数、既定 `latest`）
  - HTTP の起動プローブを使うなら、コンテナの中から届くかを実機で確かめる
  - deploy.yml は Environment `prod` の承認を得てから apply する
- #5（通し確認・運用の手順）:
  - コールドスタートを含む 10 回の応答がすべて 3 秒未満か、`msg=dispatched` が 10 件か
  - 誤ったシークレットで 401 になるか（記録は `curl` のステータスだけ。URL は記録しない）
  - LINE の無料枠の消費に注意する。`LINE_TO` を必須にする
  - 料金の数値を確かめる
  - TradingView のアラートのメッセージは JSON で書き、`secret` を入れる（本番ではテキストのアラートは使えない）
  - シークレットの版は `latest` でも起動時に解決され、取れなければ起動しない。値を入れ替えたら新しいリビジョンを作って反映する（ローテーションの手順）

## 出典

- https://docs.cloud.google.com/run/docs/configuring/billing-settings
- https://docs.cloud.google.com/run/docs/tips/general
- https://docs.cloud.google.com/run/docs/known-issues
- https://docs.cloud.google.com/run/docs/configuring/services/secrets
- https://docs.cloud.google.com/run/docs/authenticating/public
- https://docs.cloud.google.com/run/docs/container-contract
- https://docs.cloud.google.com/run/docs/configuring/healthchecks
- https://cloud.google.com/run/pricing（料金。数値は未確認）
- https://www.tradingview.com/support/solutions/43000529348-about-webhooks/
- https://developers.line.biz/en/docs/messaging-api/pricing/
- https://developers.line.biz/en/reference/messaging-api/#status-codes
- https://developers.line.biz/en/reference/messaging-api/#error-responses
- https://developers.line.biz/en/docs/messaging-api/retrying-api-request/
