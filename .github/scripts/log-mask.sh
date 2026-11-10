#!/usr/bin/env bash
# 公開リポジトリの Actions のログに GCP の値を出さないための補助。deploy.yml・ci.yml で使う。手元でもそのまま動く。
# テストは log-mask.test.sh。
#
#   log-mask.sh register   # 環境変数 GCP_WIF_PROVIDER（projects/<番号>/...）からプロジェクト番号を取り出し ::add-mask:: を 1 行出す
#   log-mask.sh filter     # 標準入力の行から GCP の値を伏せて標準出力に出す
#
# - GCP_PROJECT_ID は secret なので Actions が自動で伏せる（それを含む SA のメール・バケット名・AR のパスも）。
#   プロジェクト番号は secret の GCP_WIF_PROVIDER の一部としてしか伏せられないので register で足す
# - filter は terraform・gcloud・docker の出力（失敗時の末尾など）を出す前に必ず通す。自動のマスクに頼らない 2 枚目:
#   run.app の URL → <run-url>、メールアドレス（SA を含む）→ <email>、<region>-docker.pkg.dev/<id> → <region>-docker.pkg.dev/<project>、
#   projects/<id> → projects/<project>、<id>-tvad-tfstate… → <bucket>、9 桁以上の数字 → <num>、
#   環境変数 GCP_PROJECT_ID（空でなければ）→ <project>
set -euo pipefail

case "${1:-}" in
  register)
    v="${GCP_WIF_PROVIDER:-}"
    if [[ $v =~ ^projects/([0-9]+)/ ]]; then
      echo "::add-mask::${BASH_REMATCH[1]}"
    fi
    ;;
  filter)
    # プロジェクト ID の値は正規表現に入れず、awk の index で置き換える（ENVIRON で渡す）
    sed -E \
      -e 's#(https?://)?[A-Za-z0-9.-]+\.run\.app[^[:space:]"'"'"'<>]*#<run-url>#g' \
      -e 's#[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}#<email>#g' \
      -e 's#([a-z0-9-]+-docker\.pkg\.dev)/[A-Za-z0-9._-]+#\1/<project>#g' \
      -e 's#projects/[^/[:space:]"'"'"'<>]+#projects/<project>#g' \
      -e 's#[A-Za-z0-9._-]*-tvad-tfstate[A-Za-z0-9._-]*#<bucket>#g' \
      -e 's#[0-9]{9,}#<num>#g' \
      | LOG_MASK_PID="${GCP_PROJECT_ID:-}" awk '{
          p = ENVIRON["LOG_MASK_PID"]
          if (p != "") {
            out = ""; s = $0
            while ((i = index(s, p)) > 0) { out = out substr(s, 1, i - 1) "<project>"; s = substr(s, i + length(p)) }
            $0 = out s
          }
          print
        }'
    ;;
  *)
    echo "usage: log-mask.sh {register|filter}" >&2
    exit 2
    ;;
esac
