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
- 注: Terraform の Google プロバイダの `google_cloud_run_v2_service.invoker_iam_disabled` は 6.8.0 で追加された（CHANGELOG）。`infra/bootstrap` が固定した 8.9.0 のスキーマにあることを #3 で確かめた
- 出典（プロバイダ）: https://github.com/hashicorp/terraform-provider-google/blob/main/CHANGELOG_v6.md
- 出典: https://docs.cloud.google.com/run/docs/authenticating/public

### シークレットの渡し方（?key= と secret）
- 状態: 決定
- 決定: 本番の TradingView のアラートは JSON の `secret` で共有シークレットを渡す。`?key=` はコードに残す（後方互換・ローカルでの確認用）が、本番の手順では使わない
- 理由: Cloud Run のリクエストログにはクエリ文字列が残る（前提の観測）ので、`?key=` だとシークレットがリクエストログに載る。本文はアプリもログに出さない
- 制約: 本番ではテキストのアラートは使えない（JSON が必須）
- 退けた案: 本番も `?key=`（リクエストログにシークレットが載る）。本番で `?key=` を拒む設定をコードに足す（コードが増える。必要になれば別 Issue）
- 反映済み: README.md「TradingView のアラートの設定」と `infra/README.md`「通し確認」は JSON の `secret` で書いた（#5）

### 送信元 IP の許可リスト
- 状態: 決定
- 決定: 置かない
- 理由: 共有シークレット（定数時間で比較）と最大インスタンス数の上限で足りる。送信元 IP の変更に追従する保守が要らない
- 退けた案: アプリで `X-Forwarded-For` を見る（別 Issue が要り、保守が増える）。ロードバランサ + Cloud Armor（EPIC のスコープ外）
- 再検討の条件: 不正なリクエスト（`unauthorized` のログ）が目立って増えたとき。TradingView の送信元 IPv4 は 4 つの固定とされているが、将来も変わらない保証はない
- 出典: https://www.tradingview.com/support/solutions/43000529348-about-webhooks/

### 乱用への備え
- 状態: 決定
- 決定: 本文の上限 64 KiB（実装済み。超えたら 413）、最大インスタンス数 **2**（`infra/prod` の変数 `max_instance_count`。検査は 1〜5 の整数）、認証に失敗したら 401 を返して配信しない（実装済み）
- 理由: 未認証で呼べる受け口なので、費用と送信数が際限なく増えるのを防ぐ
- 最大 2 の根拠: アラートは低頻度で、1 リクエストは即応答（送信は応答の後、8 秒以内）。1 インスタンスの同時実行は既定の 80 なので 2 台で 160 同時。instance-based billing は起動中のインスタンスすべてに課金されるので、乱用されたときの費用の上限を 2 台分に抑える。1 ではなく 2 にするのは、1 台の停止（リビジョンの切り替え・SIGTERM の 10 秒）と重なったときの余裕。検査の上限 5 は「小さく保つ」の歯止め（超えるなら設計を見直す）
- 残るリスク: 160 を超える同時リクエストは Cloud Run が 429 を返し、TradingView は再送しない（取りこぼす）。この規模では起きない前提
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
- 費用: instance-based billing はアイドル中のインスタンスにも課金される。料金の数値（単価・無料枠）は **未確認**。#5 の実測で最小インスタンス数 0 のままにしたので確かめていない。最小 1 を検討するときに https://cloud.google.com/run/pricing で確かめる（この文書には数値を書かない）
- 退けた案: 応答の後に送る + request-based billing（いまの実装のままでは送信が止まりうるので、EPIC の終了条件 3 を満たせない）。送ってから応答する（LINE のタイムアウトと再試行を 3 秒の中に縮める必要があり、再試行の余地がほぼ無くなる）
- 出典: https://docs.cloud.google.com/run/docs/configuring/billing-settings 、https://docs.cloud.google.com/run/docs/tips/general

### 最小インスタンス数
- 状態: 決定
- 決定: 0 で始める。#5 でコールドスタートを含む 10 回の応答がすべて 3 秒未満かを測り、超えたら 1 にするかを再判断する
- 再判断（#5）: **0 のまま**。下の実測で 10 回すべてが 3 秒未満だった
- 実測（2026-11-10、`infra/README.md`「通し確認」の A）: 前のリクエストから 38 分のアイドルの後、正しいシークレット・`channels` に設定に無い ID だけ（LINE に送らない）で 10 回（1 秒間隔で順に）
  - 10 回とも 200。curl の `time_total` は 1 回目 0.82 秒（コールドスタート。新しいインスタンスの `listening` が 1 件）、2〜10 回目 0.09〜0.10 秒
  - Cloud Run のリクエストログの `httpRequest.latency`: 10 件、最大 0.54 秒・最小 0.002 秒（起動待ちを含むかは公式ドキュメントに記載なし = 未確認。curl の `time_total` は外から見た往復で起動待ちを含む）
  - `msg=dispatched` 10 件（すべて未知のチャネルの `ok: false`。LINE への送信 0）、`dispatched` 以外の ERROR 0 件
  - 実際の LINE への送達（応答の後の送信が止まらないこと）は TradingView のテストのアラート 1 通で確かめる（`infra/README.md`「通し確認」の B）
- 再検討の条件: 再測定（同じ手順）で 3 秒以上が出たとき、または TradingView の Webhook status にタイムアウトが出たとき
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
- 入れ替えの方法（#5 で決定。オーナー判断）: 所有者が新しい版を `gcloud secrets versions add` で足し、`infra/prod` の `secret_version` をその番号にする PR を `deploy.yml` で反映する（新しいリビジョンができる）。`gcloud run services update` は使わない（本番を変えるのは `deploy.yml` だけ）。`secret_version` は 3 つのシークレットに共通なので、ほかのシークレットにはいまの値の複製を足して番号をそろえる。手順は `infra/README.md`「シークレットの値の入れ替え」
- 理由: 運用が簡単（値を更新するたびに apply しなくてよい）。入れ替えのときは番号にすることで、いつ切り替わるかを PR と承認で決められる
- 注: 最初の入れ替えで版を番号にした後は、既定の `latest` は使われなくなる（変数の値が番号のままになる）。いまの変数は 3 つのシークレットに共通の 1 つなので、1 つだけ入れ替えるときもほかの 2 つの版をそろえる必要がある。シークレットごとに版を指定できるようにするのは #12
- 注: `latest` も起動時（リビジョンの作成時ではなく、インスタンスの起動時）に解決され、取れなければ起動しない。`latest` のまま版を足すと、その後に起動したインスタンスだけが新しい値になり、動いているインスタンスと混在する（反映済み: `infra/README.md`「シークレットの値の入れ替え」）
- 退けた案（入れ替え）: `gcloud run services update` で新しいリビジョンを作る（Terraform と食い違い、次の plan に update が出る）。`latest` のままインスタンスの入れ替わりを待つ（いつ切り替わるか決まらず、古い値と新しい値が混在する）
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
- 決定: ヘルスチェックは `GET /health`（200 `ok`）。旧パスの `/healthz` は 404。`/health` は外から呼べる前提で、`ok` 以外を返さない。起動プローブは Cloud Run の既定の TCP のままにし、HTTP のプローブ（起動・liveness）は使わない（`infra/prod` にプローブを書かない）
- 理由: Cloud Run は `/_ah/` で始まるパスと、末尾が `z` の一部のパスを予約していて、末尾が `z` のパスは避けるよう推奨している。`/health` は末尾が `z` でも `/_ah/` 始まりでもない。HTTP のプローブを足すと、コンテナの中から届くかという実機の確認が増える。TCP の起動プローブで、待ち受けを始めたことは分かる
- HTTP のプローブがコンテナの中から届くかは、使わないので確かめない（使うことにしたら実機で確かめる）
- 退けた案: `/healthz` を残す（外からは 404 になりうる）。`/health` の HTTP の起動・liveness プローブ（実機の確認が要り、このアプリでは TCP との差が小さい）
- 出典: https://docs.cloud.google.com/run/docs/known-issues 、https://docs.cloud.google.com/run/docs/configuring/healthchecks

## GCP の構成

### WIF・tfstate・Artifact Registry
- 状態: 決定
- 決定: Workload Identity Federation のプール・プロバイダ、tfstate のバケット、Artifact Registry のリポジトリはすべてこのリポジトリ用に新設する。IAM の付与は追加型（`*_iam_member`）だけにし、既存の authoritative な IAM を書き換えない。GCP のプロジェクト ID などは `TF_VAR_*` か未追跡の tfvars で渡し、リポジトリに書かない。bootstrap は所有者が手元で apply し、prod は deploy.yml が GitHub の Environment `prod` の承認を得てから apply する
- 理由: 同じプロジェクトの既存の WIF のプール 2 つのプロバイダは、それぞれ別リポジトリの数値 ID に固定されている。流用すると別リポジトリが管理するリソースの変更になり、他リポジトリの権限に波及する（EPIC の終了条件 6 に触れる）
- 退けた案: 既存の WIF・tfstate のバケット・Artifact Registry を流用する
- 実装: `infra/bootstrap`（手順は `infra/README.md`）。WIF のプロバイダの `attribute_condition` はこのリポジトリの数値 ID とオーナーの数値 ID の両方を `&&` で固定し、さらに Environment `prod` のトークン（sub の末尾が `:environment:prod`）は `ref == 'refs/heads/main'` のときだけ受け付ける（多層防御。守るのはブランチの制限だけで、承認の欠落は Environment の保護に頼る。`environment` クレームは Environment を参照する job にしか無く、CEL で無いキーを参照すると評価がエラーになり拒否されるので、全トークンにある `sub` で判定する。環境の無い job のトークンは従来どおり通る）。bootstrap の state は所有者が gcloud で先に作る専用のバケットに置き、`import` で管理下に入れる。消せないように SA・プール・プロバイダ・バケット・Artifact Registry・シークレットに `deletion_policy = "PREVENT"`、バケットに `prevent_destroy`
- 出典（条件）: https://docs.cloud.google.com/iam/docs/workload-identity-federation 、https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines 、https://docs.github.com/en/actions/reference/security/oidc 、https://github.com/google/cel-spec/blob/master/doc/langdef.md

### SA と権限
- 状態: 決定
- 決定: SA を 3 つに分け、付与は次の表のものだけ（すべて追加型）

| SA | 借用できるもの | 付与 |
|---|---|---|
| 実行用（Cloud Run のランタイム） | — | 3 つのシークレットそれぞれの `roles/secretmanager.secretAccessor` だけ（プロジェクト単位の付与なし） |
| CI の apply 用 | GitHub の Environment `prod` の job の subject 1 件（`principal://…/subject/repo:<OWNER>@<OWNER_ID>/<REPO>@<REPO_ID>:environment:prod`。不変 ID 入りでない従来の形式も変数で選べる） | プロジェクト単位の `roles/run.admin`（下の「apply SA の Cloud Run の権限」）、実行用 SA 単位の `roles/iam.serviceAccountUser`、Artifact Registry のリポジトリ単位の `roles/artifactregistry.writer`、prod の state のバケット単位の `roles/storage.objectUser` |
| CI の plan 用 | このリポジトリの job（`principalSet://…/attribute.repository_id/<REPO_ID>`） | プロジェクト単位の `roles/run.viewer`、リポジトリ単位の `roles/artifactregistry.reader`、prod の state のバケット単位の `roles/storage.objectViewer` |

- bootstrap の state のバケットには CI の SA の付与を付けない（CI が bootstrap の state を読み書きできない）
- plan SA は prod の state を読むだけ（`objectViewer`）なので、plan SA の plan（`deploy.yml` の plan job・`ci.yml` の `terraform-plan`）は `-lock=false` で行う（ロックのために書き込みの付与を増やさない）
- 付与の宣言（種類と名前）は `.github/scripts/tf-iam-decl-check.sh` で固定する（CI の check）。`terraform test` は各リソースの中の件数しか見られないため。実際のプロジェクトの IAM の差分は apply の後に `infra/README.md` の手順で確かめる
- 理由: 実行用・apply・plan で権限を分け、シークレットを読めるのは実行用 SA だけにする。PR の plan は読み取りの SA で行い、書き込みは承認つきの Environment の job に限る
- 退けた案: 1 つの SA で apply と plan を兼ねる（PR の job に書き込みの権限が渡る）。プロジェクト単位の `serviceAccountUser`・`secretAccessor`（ほかの SA・シークレットに波及する）

### apply SA の Cloud Run の権限
- 状態: 決定
- 決定: apply SA の `roles/run.admin` はプロジェクト単位（条件なし）。GitHub の Environment `prod` の承認（main 限定）で守る。緩和:
  - 借用は Environment `prod` の job の subject 1 件だけ。sub はブランチを含まず、存在しない Environment を参照する job は保護なしの Environment を自動作成するので、**Environment `prod` の保護（required reviewers = 所有者、deployment branches = `main` だけ、管理者の bypass なし）は bootstrap の apply より前に所有者が設定する**（main が承認を得て行う。読み取りの確認は `infra/README.md`「0. 前提」。2026-11-10 のオーナーの決定。required reviewers を使うためにリポジトリは public にした）
  - WIF のプロバイダの条件で、Environment `prod` のトークンは `ref` が `refs/heads/main` のときだけ受け付ける（Environment の保護が外れたときの 2 枚目）
  - `deploy.yml` は承認の前に plan の要約（アドレスと操作）を出し、apply の直前の plan が承認した plan と同じ「アドレスと操作」のときだけ apply する（「デプロイの流れ（deploy.yml）」）
  - bootstrap の apply の後に既存のサービスのリビジョンと IAM が変わっていないことを確かめる（`infra/README.md`）
- 理由: Cloud Run は IAM の条件のリソース属性（`resource.name` など）に対応していない。対応しないサービスでは、その条件は許可として解釈されないので、サービス名で絞った `run.admin` は作成・更新・取得・`setIamPolicy` のどれも許可しない。`invoker_iam_disabled` の設定には `run.services.setIamPolicy` が要り、`roles/run.developer` には無い
- 影響: apply SA は同じプロジェクトの既存の Cloud Run サービス（別リポジトリの管理物）も変更できる
- 退けた案: IAM の条件でサービス名に絞る（効かない）。サービスの作成を bootstrap（所有者）で行い、CI にはサービス単位の権限だけを付ける（#4 の構成が変わる。オーナーの指示はプロジェクト単位へのフォールバック）
- 出典: https://docs.cloud.google.com/iam/docs/conditions-resource-attributes 、https://docs.cloud.google.com/iam/docs/conditions-attribute-reference 、https://docs.cloud.google.com/run/docs/authenticating/public 、https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments （存在しない Environment の参照で自動作成）、https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments （required reviewers の提供範囲）

### リージョン
- 状態: 決定
- 決定: asia-northeast1
- 理由: 既存 3 サービスと同じ。TradingView からの往復の差は 3 秒の打ち切りに対して小さい
- 退けた案: ほかのリージョン（選ぶ根拠が無い）

### API の有効化
- 状態: 決定
- 決定: iam・iamcredentials・sts・artifactregistry・secretmanager・run・cloudresourcemanager・storage の API は有効化済み（2026-11-10 に観測。storage は `storage-api.googleapis.com` の名前で有効）なので、Terraform では有効化しない（`infra/bootstrap` に `google_project_service` を書かない。事前の確認は `infra/README.md`）。足りない API が出たら追加を諮る（`disable_on_destroy = false`）
- 理由: 既存サービスも使う API を、このリポジトリの destroy で止めないため
- 退けた案: すべての API を Terraform で管理する（destroy で既存サービスが使う API を止めうる）

### イメージのタグ
- 状態: 決定
- 決定: 本番のイメージ（Artifact Registry の `tvad/dispatcher`）のタグは、イメージの入力（`Dockerfile`・`.dockerignore`・`.dockerignore` の許可リストの `package.json`・`src/`）の git のハッシュ（HEAD の blob / tree）から決める `src-<sha256 の先頭 20 桁>`（`.github/scripts/image.sh tag`）。入力のパスは `image.sh` に固定で書き、`.dockerignore` の許可リストとの一致を `ci.yml` の check で確かめる。Cloud Run には digest（`@sha256:`）の参照で渡す
- 理由: ドキュメントだけのマージではタグが変わらず、Cloud Run の差分も承認待ちも出ない。同じ入力なら同じタグなので、Artifact Registry にあれば再ビルドしない（タグは不変）
- 退けた案: git のコミットのハッシュ（ドキュメントだけのマージでも毎回新しいイメージ・リビジョン・承認待ちになる）。`latest` などの可変のタグ（何が動いているか分からない。Artifact Registry のタグは不変にしてある）

### デプロイの流れ（deploy.yml）
- 状態: 決定
- 決定: 本番を変えるのは `.github/workflows/deploy.yml` だけ。main への push ごとに plan job（plan SA、`-lock=false`。Artifact Registry にイメージがあれば digest、無ければタグの参照で plan）→ 差分があるときだけ apply job（`environment: prod`。承認の後）→ イメージが無ければ GCP の認証より前にビルドと `image-check.sh` → apply SA で push → digest を解決（`@sha256:` でなければ失敗）→ plan を取り直し、承認した plan と「アドレスと操作」が同じときだけ apply → apply の直後の plan（`-detailed-exitcode`）が差分 0 でなければ失敗。`concurrency` は 1 グループで `cancel-in-progress: false`
  - push は承認の後の apply job で行う（`artifactregistry.writer` は apply SA だけ。「SA と権限」を変えない）
  - `paths` のフィルタは置かない。差分が無ければ apply job が動かない（承認待ちが出ない）ので、毎回の plan で足りる。フィルタの漏れ（新しい入力・参照先）で本番に反映されないことに気づけなくなるのを避け、毎回の plan はドリフトの検出も兼ねる
  - `infra/prod` の traffic は「最新のリビジョンに 100%」を明示する。緊急の `gcloud run services update-traffic` でリビジョンを固定したら plan に差分が出て、次の apply で最新に戻る（書かないと固定が plan に出ず、以後のデプロイが流れないことに気づけない）
  - `deletion_protection = true`（destroy と作り直しを止める）。`deletion_policy` は同じ働きの重複なので付けない
  - `infra/prod` は IAM のリソース・data source を持たない（plan SA の読み取りの権限で plan できるように。実行用 SA のメールは組み立てる。`tf-iam-decl-check.sh` で 0 件を固定）
  - PR では `ci.yml` の `terraform-plan`（同じリポジトリからの PR だけ、plan SA、`-lock=false`）で同じ要約を出す。必須の check にはしない
- 理由: 手作業の `gcloud run deploy` にせず、同じ手順を繰り返せる・切り戻せる・誰が承認したかが残る経路にする。apply SA の権限（プロジェクト単位の `run.admin`）は広いので、承認の後に承認した plan と別の操作をしない
- 退けた案: plan の前にビルドと push（plan SA に AR の writer が要る = 付与の変更）。plan ファイルを artifact で apply job に渡す（公開リポジトリの artifact は誰でも取れる）。`paths` のフィルタ（上）

### 公開リポジトリの CI のログ
- 状態: 決定
- 決定: リポジトリは public で、Actions のログ・ジョブの要約は誰でも読める。プロジェクト ID・番号・SA のメール・`run.app` の URL・plan / apply の全文を出さない:
  - プロジェクト ID は repository variable ではなく **secret**（`GCP_PROJECT_ID`）にする。secret は job の最初から自動で伏せられ、それを含む値（SA のメール・state のバケット名・AR のパス）も伏せられる。variable を job の `env` に置くと各 step のログの見出しにそのまま出て、`::add-mask::` は登録した step より前の行を伏せられない
  - WIF のプロバイダ名（プロジェクト番号を含む）も secret（`GCP_WIF_PROVIDER`）。番号だけの出現は `log-mask.sh register` が `::add-mask::` で伏せる
  - `terraform`・`gcloud`・`docker` の出力はファイルに書き、失敗時だけ `log-mask.sh filter`（9 桁以上の数字・メール・`run.app`・AR のパス・`projects/<id>`・state のバケット名を置き換える）を通した末尾を出す
  - 要約に出すのは「アドレスと操作」・操作ごとの件数・イメージのタグ・digest の先頭 12 桁・差分の有無だけ（`tf-plan-summary.sh`。値 = before / after を出さない）。plan ファイルは artifact にしない。`infra/prod` は output を持たない（URL を出力しない）
  - variables は `TF_STATE_BUCKET`・`GCP_SA_TF_PLAN`・`GCP_SA_TF_APPLY`（どれもプロジェクト ID を含むので secret の自動のマスクで伏せられる）
- 理由: 公開のログから、プロジェクトの特定や攻撃の足がかりになる値を読めないようにする（CLAUDE.md「置かないもの」と同じ方針）
- 未確認: ジョブの要約に secret の自動のマスクが効くか。要約には値を書かない作りにして依存しない
- 退けた案: プロジェクト ID を variable にして `::add-mask::` で伏せる（最初の step の見出しに出る）

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
- #3（bootstrap）: 反映済み。`infra/bootstrap` に WIF のプール・プロバイダ、SA 3 つ（「SA と権限」）、Artifact Registry、tfstate のバケット 2 つ、Secret Manager の入れ物 3 つ（値なし）。apply と値の投入は所有者が `infra/README.md` の手順で行う。apply の前に Environment `prod` を保護する（同 0. 前提）
- #4（prod の Cloud Run・deploy.yml）: 反映済み。`infra/prod`（サービス `tvad`: `invoker_iam_disabled`・ingress `all`・instance-based billing・CPU 1・メモリ `512Mi`・最小 0・最大 2・`secretKeyRef` の版は変数で既定 `latest`・起動プローブは既定の TCP・`deletion_protection`・traffic は最新に 100%）、`.github/workflows/deploy.yml`（「デプロイの流れ（deploy.yml）」）、`ci.yml` の `terraform-plan`（PR の plan。`-lock=false`、`pull_request_target` を使わない）。手順は `infra/README.md`「prod（Cloud Run）」。デプロイの後に確かめる事実（plan SA の `roles/run.viewer` で plan が足りたか、不変 ID 入りの sub の形式が合っていたか）は、確かめたらここに書く
- #5（通し確認・運用の手順）: 反映済み。README.md「TradingView のアラートの設定」（2 段階認証、URL とシークレットの取り出し、JSON の `secret`、本番ではテキストのアラートを使わない）と「運用」（ログの見方・失敗した経路・`unauthorized` の件数・LINE の無料枠・シークレットの入れ替え・切り戻し）、`infra/README.md`「通し確認」「シークレットの値の入れ替え」。10 回の応答と `dispatched` 10 件の実測と最小インスタンス数の再判断は「最小インスタンス数」、入れ替えの方法は「シークレットの版」。誤ったシークレットで 401 は #4 で確認済み。`LINE_TO` の必須は「broadcast と LINE の無料枠」と #4 の手順のまま。料金の数値は最小 0 のままにしたので確かめていない（「送信のタイミング」）。TradingView のテストのアラート 1 通での送達の確認は `infra/README.md`「通し確認」の B

## 出典

- https://docs.cloud.google.com/run/docs/configuring/billing-settings
- https://docs.cloud.google.com/run/docs/tips/general
- https://docs.cloud.google.com/run/docs/known-issues
- https://docs.cloud.google.com/run/docs/configuring/services/secrets
- https://docs.cloud.google.com/run/docs/authenticating/public
- https://docs.cloud.google.com/iam/docs/conditions-resource-attributes
- https://docs.cloud.google.com/iam/docs/conditions-attribute-reference
- https://github.com/hashicorp/terraform-provider-google/blob/main/CHANGELOG_v6.md
- https://docs.cloud.google.com/run/docs/container-contract
- https://docs.cloud.google.com/run/docs/configuring/healthchecks
- https://cloud.google.com/run/pricing（料金。数値は未確認）
- https://www.tradingview.com/support/solutions/43000529348-about-webhooks/
- https://developers.line.biz/en/docs/messaging-api/pricing/
- https://developers.line.biz/en/reference/messaging-api/#status-codes
- https://developers.line.biz/en/reference/messaging-api/#error-responses
- https://developers.line.biz/en/docs/messaging-api/retrying-api-request/
