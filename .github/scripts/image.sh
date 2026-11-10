#!/usr/bin/env bash
# 本番のコンテナイメージのタグと参照を決める。deploy.yml・ci.yml で使う。手元でもそのまま動く（infra/README.md「手元の plan（所有者）」）。
#
#   image.sh paths     # イメージの入力のパス（1 行 1 つ）
#   image.sh tag       # 入力のパスの git のハッシュ（HEAD の blob / tree）から決めたタグ src-<20 桁>
#   image.sh resolve   # Artifact Registry を引き、tag= / exists= / image= の 3 行を出す（要 gcloud の認証）
#
# - タグはイメージの入力（Dockerfile・.dockerignore・.dockerignore の許可リスト）だけから決める。ドキュメントだけのマージでは
#   タグが変わらず、Cloud Run の差分も承認待ちも出ない（docs/design.md「イメージのタグ」）。HEAD から求めるので、
#   コミットしていない変更は含まない
# - 入力のパスはここに固定で書く。.dockerignore の許可リストとの一致は ci.yml の check が diff で確かめる（片方だけ直すと落ちる）
# - resolve: 環境変数 GCP_PROJECT_ID（必須）・GCP_REGION（既定 asia-northeast1）。イメージは
#   <region>-docker.pkg.dev/<project>/tvad/dispatcher。Artifact Registry にタグがあれば image=…@sha256:<digest>・exists=true、
#   無ければ image=…:<tag>・exists=false。それ以外のエラーは log-mask.sh filter を通した末尾を出して exit 1
#   （image= の行はプロジェクト ID を含む。$GITHUB_ENV に書き、ログ・ジョブの出力・要約に出さない）
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)

paths() {
  printf '%s\n' Dockerfile .dockerignore package.json src
}

tag() {
  local p h lines=""
  # パスとハッシュの組を並べた sha256 の先頭 20 桁（HEAD にパスが無ければ失敗する）
  while IFS= read -r p; do
    if ! h=$(git rev-parse --verify --quiet "HEAD:$p"); then
      echo "NG: HEAD に $p が無い" >&2
      exit 1
    fi
    lines+="$p $h"$'\n'
  done < <(paths)
  printf 'src-%s\n' "$(printf '%s' "$lines" | sha256sum | cut -c1-20)"
}

resolve() {
  local pid="${GCP_PROJECT_ID:?GCP_PROJECT_ID が空}" region="${GCP_REGION:-asia-northeast1}" t ref digest err rc=0
  t=$(tag)
  ref="${region}-docker.pkg.dev/${pid}/tvad/dispatcher"
  err=$(mktemp)
  digest=$(gcloud artifacts docker images describe "${ref}:${t}" --format='value(image_summary.digest)' 2>"$err") || rc=$?
  if [ "$rc" -eq 0 ] && [[ $digest =~ ^sha256:[0-9a-f]{64}$ ]]; then
    printf 'tag=%s\nexists=true\nimage=%s@%s\n' "$t" "$ref" "$digest"
  elif [ "$rc" -ne 0 ] && grep -qiE 'not found|NOT_FOUND' "$err"; then
    printf 'tag=%s\nexists=false\nimage=%s:%s\n' "$t" "$ref" "$t"
  else
    echo "NG: イメージの digest を解決できない（exit ${rc}）" >&2
    tail -n 20 "$err" | "$here/log-mask.sh" filter >&2
    rm -f "$err"
    exit 1
  fi
  rm -f "$err"
}

case "${1:-}" in
  paths) paths ;;
  tag) tag ;;
  resolve) resolve ;;
  *)
    echo "usage: image.sh {paths|tag|resolve}" >&2
    exit 2
    ;;
esac
