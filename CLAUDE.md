# tradeview-alert-dispatcher

TradingView のアラート（webhook）を受けて、**1 つのアラートを複数の経路に送る** 中継サーバー。第一弾の経路は LINE（Messaging API のチャネルアクセストークン）。動かす先は GCP（Cloud Run の予定）。設計は `docs/design.md`（あれば。決定事項と判断待ちが正）。

## 作り

- `src/server.ts`: HTTP の入口（`node:http`、依存なし）。`POST /webhook` は共有シークレット（`?key=` か JSON の `secret`。TradingView は任意のヘッダを付けられないため）を定数時間で比べ、本文の上限（64 KiB）を超えたら 413。受理したら **200 を先に返してから** 送る（TradingView は応答を 3 秒しか待たない）。`GET /healthz`。ログは 1 行 JSON（`severity` つき。Cloud Logging がそのまま読む）で、本文・シークレット・トークンを出さない
- `src/alert.ts`: 本文 → `Alert`（JSON なら `title` / `message` / `channels`、それ以外はテキスト）と通知文の整形。**純関数**
- `src/dispatcher.ts`: 送り先の解決（`alert.channels` → 設定の `defaultChannels` → 全チャネル）と並行送信。1 つの経路の失敗はほかを止めない
- `src/notifiers/`: 経路ごとの実装。共通の口は `src/types.ts` の `Notifier`（`id` / `type` / `send(alert)`）。設定から作るのは `src/notifiers/index.ts` の `createNotifier`（経路を足すときは `ChannelConfig` の union・`createNotifier`・`src/config.ts` の検証の 3 か所）
  - `line.ts`: 送り先 0 件 = broadcast、1 件 = push、2 件以上 = multicast（500 件ずつ）。本文は 5000 文字で切る。5xx・429・通信エラーは同じ `X-Line-Retry-Key` で 2 回まで再試行し、409（受理済み）は成功扱い
- `src/config.ts`: シークレット・トークンは **環境変数だけ**（`WEBHOOK_SECRET`・`LINE_CHANNEL_ACCESS_TOKEN` など）。送り先は `CONFIG_PATH`（既定 `config.json`、gitignore）の JSON。ファイルが無ければ環境変数（`LINE_TO`）だけで LINE の 1 チャネルを作る。例は `config.example.json`・`.env.example`
- `test/`: vitest。経路のテストは偽の `fetch` で行い、**実際の LINE API を呼ばない**。HTTP はポート 0 で立てて確かめる

## 開発

- Node は 24（`.node-version`）。TypeScript は Node の型の除去でそのまま動かす（ビルドなし。`import` は `.ts` の拡張子つき、enum・引数プロパティなど消せない構文は使わない = `erasableSyntaxOnly`）。依存はバージョン固定（`package-lock.json` をコミット）。実行時の依存は足さない方針（足すなら Issue で理由を書く）
- 手元の Node が 24 でなければ `mise exec node@24 -- <コマンド>`
- 確認: `npm ci && npm run typecheck && npm run lint && npm test && .github/scripts/repo-values-check.test.sh`（CI と同じ。lint は Biome、整形は `npm run format`）
- 起動: `cp .env.example .env` で値を入れて `npm start`（`npm run dev` は watch）。送信の確認は `curl -X POST "localhost:8080/webhook?key=$WEBHOOK_SECRET" -d 'テスト'`（実際に LINE に届く）

## Issue と実装の進め方

`.claude/skills/` のスキルで進める: 起票 `/create-issue`、EPIC `/create-epic`、実装 `/implement-issue`（フルフロー）・`/implement-issue-lite`（ユーザーが明示したときだけ）、EPIC の子を順に `/implement-epic`。

- GitHub の操作はリポジトリのオーナーのアカウントで行う。gh のプロファイル（`GH_CONFIG_DIR`）は `.claude/settings.local.json` の `env`、git の remote は ssh の Host の別名で手元に設定する（どちらもリポジトリに書かない）
- GCP のプロジェクトは option-simulator と同じものを使う（ID はリポジトリに書かない。`gcloud config get-value project` か `GCP_PROJECT_ID`）
- 本番を変える操作（デプロイ・`terraform apply`・IAM・Secret Manager の値・GitHub の設定）はユーザーの明示承認を得てから

## リポジトリに置くもの / 置かないもの

誰でも clone して自分の環境で使える **汎用の作り** にする（公開しても困らない内容だけを置く）。

**置かないもの**（コミットにも Issue / PR 本文にも入れない）:

- LINE のチャネルアクセストークン・チャネルシークレット、webhook のシークレット、そのほかのトークン・鍵
- LINE の実際の userId / groupId / roomId（`U` / `C` / `R` + 16 進 32 桁）。テスト・docs は `U<32 桁の 16 進>` などのプレースホルダか、コードで組み立てた架空の値
- 実際のアラートの本文（自分の銘柄・売買条件が分かるもの）。例は架空の銘柄・値
- 特定の利用者の値（GCP プロジェクト ID・番号、GitHub のオーナー名・リポジトリ名、Cloud Run の URL、メールアドレス、ホームディレクトリのパス）。例外は `LICENSE` の著作権表示の 1 行
- `.env`・`config.json`・`.claude/settings.local.json`・作業用ファイル（`.claude/handoff/`、`.claude/worktrees/`）

`.github/scripts/repo-values-check.sh` が形で検査する（CI の check）。コミット前に `git status --porcelain` を見て、`git add -A` / `git add .` は使わず個別に `git add` する。
