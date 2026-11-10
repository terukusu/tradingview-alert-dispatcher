# tradingview-alert-dispatcher

TradingView のアラート（webhook）を受けて、**1 つのアラートを複数の経路に送る** 中継サーバー。第一弾の経路は LINE（Messaging API のチャネルアクセストークン）。動かす先は GCP（Cloud Run の予定）。設計は `docs/design.md`（決定事項の正）。

## 作り

- `src/server.ts`: HTTP の入口（`node:http`、依存なし）。送信元 IP の許可リスト（`ALLOWED_SOURCE_IPS`）が空でなければ、`GET /health` 以外は一覧に無い送信元を本文を読む前・認証の前に 403 `forbidden`（ログは `forbidden` だけで IP を出さない）。`POST /webhook` は共有シークレット（`?key=` か本文の `secret`。壊れた JSON も `"secret": "…"` の形を読む。TradingView は任意のヘッダを付けられないため）を定数時間で比べ、本文の上限（64 KiB）を超えたら 413。受理したら **200 を先に返してから** 送る（TradingView は応答を 3 秒しか待たない）。`GET /health`（200 `ok`）。`0.0.0.0` の `PORT` で待ち受ける。処理中のリクエスト（裏の配信と `onDispatched` まで）を追跡し、SIGTERM・SIGINT で受付を止めてそれを待ってから exit 0（上限 `SHUTDOWN_TIMEOUT_MS` = 9 秒。超えたら残りの件数を `WARNING` のログに出す。終了中に届いたリクエストは 503）。ログは 1 行 JSON（`severity` つき。Cloud Logging がそのまま読む）で、本文・`title`・シークレット・トークン・送り先 ID を出さない
- `src/source-ip.ts`: 送信元 IP（`X-Forwarded-For` が 1 行ならその末尾、2 行以上なら拒否、無ければ接続元。`::ffff:` の IPv4 は直す）。**純関数**
- `src/alert.ts`: 本文 → `Alert`（JSON なら `title` / `message` / `channels`、それ以外はテキスト（`secret` の部分を除く））と通知文の整形。**純関数**
- `src/dispatcher.ts`: 送り先の解決（`alert.channels` → 設定の `defaultChannels` → 全チャネル）と並行送信。1 つの経路の失敗はほかを止めない
- `src/notifiers/`: 経路ごとの実装。共通の口は `src/types.ts` の `Notifier`（`id` / `type` / `send(alert)`）。設定から作るのは `src/notifiers/index.ts` の `createNotifier`（経路を足すときは `ChannelConfig` の union・`createNotifier`・`src/config.ts` の検証の 3 か所）
  - `line.ts`: 送り先 0 件 = broadcast、1 件 = push、2 件以上 = multicast（500 件ずつ）。本文は 5000 文字で切る。5xx・通信エラー・試行のタイムアウト（5 秒）は同じ `X-Line-Retry-Key` で 2 回まで再試行し（待ち 0.5 秒・1 秒）、429（月の上限・レート制限）を含む 4xx は再試行しない。409（受理済み）は成功扱い。送信全体（multicast の全分割・再試行・待ち）に締め切り 8 秒（`SEND_DEADLINE_MS`）を 1 つ持ち、過ぎたら打ち切って失敗する
- `src/config.ts`: シークレット・トークンは **環境変数だけ**（`WEBHOOK_SECRET`・`LINE_CHANNEL_ACCESS_TOKEN` など）。送信元 IP の許可リストも環境変数（`ALLOWED_SOURCE_IPS`。カンマ区切りの IPv4、未設定・空 = 制限なし、IPv4 でない要素で起動時に失敗）。送り先は `CONFIG_PATH`（既定 `config.json`、gitignore）の JSON。ファイルが無ければ環境変数（`LINE_TO`）だけで LINE の 1 チャネルを作る。例は `config.example.json`・`.env.example`
- `Dockerfile`・`.dockerignore`: `node:24.x.y-slim` をタグと digest で固定し、`package.json` と `src/` だけを `/app` に入れる（`.dockerignore` は許可リスト。実行時の依存が無いので依存のインストールもしない）。非 root（`USER node`）、exec 形式の `CMD` で node が SIGTERM を直接受ける。`.github/scripts/image-check.sh <image>` がイメージを検査する（非 root・`/app` の中身・`dependencies` なし・`/health` 200・未認証 401・`docker stop` で終了コード 0。架空の値で起動し、認証の通るリクエストは送らない）
- `test/`: vitest。経路のテストは偽の `fetch` で行い、**実際の LINE API を呼ばない**。HTTP はポート 0 で立てて確かめる
- `infra/`: 本番の Terraform（手順は `infra/README.md`）
  - `bootstrap/`: WIF のプール・プロバイダ、SA 3 つ（実行用・CI の apply 用・plan 用）と追加型の付与、Artifact Registry、tfstate のバケット 2 つ、Secret Manager の入れ物 3 つ（値は持たない）、`_Default` シンクへのログの除外 1 つ（`tvad` の 401・403 のリクエストログと `forbidden`）。**所有者が手元で apply**（CI は apply しない）。プロジェクト ID・リポジトリ名・GitHub の数値 ID は `TF_VAR_*` で渡す。`tests/*.tftest.hcl` はモックのプロバイダの `terraform test`（値は架空）
  - `prod/`: Cloud Run のサービス `tvad` 1 つ（未認証で呼べる・instance-based billing・最小 0 最大 2・秘密の環境変数は Secret Manager の参照だけ。平文は公開の値の `ALLOWED_SOURCE_IPS`（変数 `allowed_source_ips`、既定は TradingView の 4 つ）だけ）。IAM のリソース・data source・output を持たない。**本番を変えるのは `deploy.yml` だけ**（Environment `prod` の承認の後に apply）。`tests/*.tftest.hcl` はモック
- `.github/workflows/`: `ci.yml`（`check` = 検査・テスト・Terraform の検証・イメージのビルドと検査。`terraform-plan` = 同じリポジトリの PR で plan SA の `plan -lock=false` の要約）、`deploy.yml`（main への push で plan → 差分があれば Environment `prod` の承認 → ビルド・push・apply・再 plan）。リポジトリは public なので、ログ・要約に plan / apply の全文・プロジェクト ID・番号・SA のメール・URL を出さない（`docs/design.md`「公開リポジトリの CI のログ」）
- `.github/scripts/`: `repo-values-check.sh`（置かないものの検査）、`image-check.sh`（イメージの検査）、`tf-iam-decl-check.sh`（IAM のリソースの宣言の固定。bootstrap 8 件・prod 0 件。ログの設定（`google_logging_*`）の宣言も固定。bootstrap 1 件・prod 0 件）、`image.sh`（イメージのタグ = 入力のハッシュと digest の解決）、`tf-plan-summary.sh`（plan のアドレスと操作だけ）、`log-mask.sh`（ログのマスク）。`*.test.sh` がそれぞれのテスト

## 開発

- Node は 24（`.node-version`）。TypeScript は Node の型の除去でそのまま動かす（ビルドなし。`import` は `.ts` の拡張子つき、enum・引数プロパティなど消せない構文は使わない = `erasableSyntaxOnly`）。依存はバージョン固定（`package-lock.json` をコミット）。実行時の依存は足さない方針（足すなら Issue で理由を書く）
- 手元の Node が 24 でなければ `mise exec node@24 -- <コマンド>`
- 確認: `npm ci && npm run typecheck && npm run lint && npm test && .github/scripts/repo-values-check.test.sh && docker build -t dispatcher:ci . && .github/scripts/image-check.sh dispatcher:ci`（CI と同じ。lint は Biome、整形は `npm run format`）
- Terraform の確認（CI と同じ。資格情報なし）: `terraform fmt -check -recursive infra`、`bootstrap`・`prod` それぞれ `terraform -chdir=infra/<dir> init -backend=false -input=false && terraform -chdir=infra/<dir> validate && terraform -chdir=infra/<dir> test`、`.github/scripts/tf-iam-decl-check.sh && .github/scripts/tf-iam-decl-check.sh infra/prod`（IAM のリソースの宣言の一覧の固定）、`.github/scripts/tf-iam-decl-check.test.sh && .github/scripts/log-mask.test.sh`。Terraform は 1.16.4（手元に無ければ `mise exec terraform@1.16.4 -- terraform …`）
- 起動: `cp .env.example .env` で値を入れて `npm start`（`npm run dev` は watch）。送信の確認は `curl -X POST "localhost:8080/webhook?key=$WEBHOOK_SECRET" -d 'テスト'`（実際に LINE に届く）

## Issue と実装の進め方

`.claude/skills/` のスキルで進める: 起票 `/create-issue`、EPIC `/create-epic`、実装 `/implement-issue`（フルフロー）・`/implement-issue-lite`（ユーザーが明示したときだけ）、EPIC の子を順に `/implement-epic`。

- GitHub の操作はリポジトリのオーナーのアカウントで行う。gh のプロファイル（`GH_CONFIG_DIR`）は `.claude/settings.local.json` の `env`、git の remote は ssh の Host の別名で手元に設定する（どちらもリポジトリに書かない）
- GCP のプロジェクトは option-simulator と同じものを使う（ID はリポジトリに書かない。`gcloud config get-value project` か `GCP_PROJECT_ID`）
- 本番を変える操作（デプロイ・`terraform apply`（`infra/bootstrap` の所有者の手元の apply を含む）・IAM・Secret Manager の値・GitHub の設定）はユーザーの明示承認を得てから

## リポジトリに置くもの / 置かないもの

誰でも clone して自分の環境で使える **汎用の作り** にする（公開しても困らない内容だけを置く）。

**置かないもの**（コミットにも Issue / PR 本文にも入れない）:

- LINE のチャネルアクセストークン・チャネルシークレット、webhook のシークレット、そのほかのトークン・鍵
- LINE の実際の userId / groupId / roomId（`U` / `C` / `R` + 16 進 32 桁）。テスト・docs は `U<32 桁の 16 進>` などのプレースホルダか、コードで組み立てた架空の値
- 実際のアラートの本文（自分の銘柄・売買条件が分かるもの）。例は架空の銘柄・値
- 特定の利用者の値（GCP プロジェクト ID・番号、GitHub のオーナー名・リポジトリ名、Cloud Run の URL、メールアドレス、ホームディレクトリのパス）。例外は `LICENSE` の著作権表示の 1 行
- `.env`・`config.json`・`.claude/settings.local.json`・作業用ファイル（`.claude/handoff/`、`.claude/worktrees/`）
- Terraform の state・plan・変数の実物（`*.tfstate`・`*.tfplan`・`*.tfvars`・`.terraform/`。gitignore。例は `*.tfvars.example`。`.terraform.lock.hcl` はコミットする）。state・plan の全文を Issue / PR に貼らない

`.github/scripts/repo-values-check.sh` が形で検査する（CI の check）。コミット前に `git status --porcelain` を見て、`git add -A` / `git add .` は使わず個別に `git add` する。
