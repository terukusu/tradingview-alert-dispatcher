#!/usr/bin/env bash
# .github/scripts/tf-iam-decl-check.sh のテスト（ci.yml の check で回す。手元でもそのまま動く）。
# infra/prod・infra/bootstrap の *.tf を一時ディレクトリ（名前は prod / bootstrap などにする）に写し、
# IAM のリソース・ログの設定のリソース（google_logging_*）や module を足したときに NG（exit 1）になることを確かめる。
#
#   tf-iam-decl-check.test.sh
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
check="$here/tf-iam-decl-check.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fails=0

# copy <元のディレクトリ> <写し先のディレクトリの名前>: 写し先のパスを出す（$(...) の中で呼ぶので、毎回別の一時ディレクトリにする）
copy() {
  local dst
  dst="$(mktemp -d "$tmp/c.XXXXXX")/$2"
  mkdir -p "$dst"
  cp "$root/$1"/*.tf "$dst/"
  printf '%s\n' "$dst"
}

# run <期待の exit> <名前> <期待の出力（固定文字列）> <ディレクトリ>
run() {
  local want=$1 label=$2 expect=$3 dir=$4 out rc=0
  out=$("$check" "$dir" 2>&1) || rc=$?
  if [ "$rc" -ne "$want" ] || ! printf '%s' "$out" | grep -qF -e "$expect"; then
    echo "FAIL ${label}: exit ${rc}（期待 ${want}）"
    printf '%s\n' "$out" | sed 's/^/    /'
    fails=$((fails + 1))
  else
    echo "ok   ${label}"
  fi
}

run 0 'bootstrap（既定の一覧 8 件）' 'ok: IAM のリソースの宣言 8 件' "$root/infra/bootstrap"
run 0 'bootstrap（ログの設定 1 件）' 'ok: ログの設定のリソースの宣言 1 件' "$root/infra/bootstrap"
run 0 'prod（0 件）' 'ok: IAM のリソースの宣言 0 件' "$root/infra/prod"
run 0 'prod（ログの設定 0 件）' 'ok: ログの設定のリソースの宣言 0 件' "$root/infra/prod"

d=$(copy infra/prod prod)
run 0 'prod の写し（0 件）' 'ok: IAM のリソースの宣言 0 件' "$d"

d=$(copy infra/prod prod)
printf '\nresource "google_cloud_run_v2_service_iam_member" "x" {}\n' >> "$d/run.tf"
run 1 'prod に *_iam_member を足す' 'NG:' "$d"

d=$(copy infra/prod prod)
printf '\n  resource "google_project_iam_binding" "x" {}\n' >> "$d/run.tf"
run 1 'prod に *_iam_binding を足す（字下げあり）' 'NG:' "$d"

d=$(copy infra/prod prod)
printf '\nmodule "m" {\n  source = "./m"\n}\n' >> "$d/run.tf"
run 1 'prod に module を足す' 'NG:' "$d"

d=$(copy infra/bootstrap bootstrap)
printf '\nresource "google_project_iam_member" "extra" {}\n' >> "$d/iam.tf"
run 1 'bootstrap に別の名前の付与を足す' 'NG:' "$d"

d=$(copy infra/bootstrap bootstrap)
printf '\nresource "google_logging_project_sink" "default" {}\n' >> "$d/logging.tf"
run 1 'bootstrap に google_logging_project_sink を足す' 'NG:' "$d"

d=$(copy infra/bootstrap bootstrap)
printf '\nresource "google_logging_project_exclusion" "extra" {}\n' >> "$d/logging.tf"
run 1 'bootstrap に 2 つ目の google_logging_project_exclusion を足す' 'NG:' "$d"

d=$(copy infra/bootstrap bootstrap)
rm "$d/logging.tf"
run 1 'bootstrap からログの除外を消す' 'NG:' "$d"

d=$(copy infra/prod prod)
printf '\nresource "google_logging_project_exclusion" "x" {}\n' >> "$d/run.tf"
run 1 'prod に google_logging_project_exclusion を足す' 'NG:' "$d"

d=$(copy infra/prod staging)
run 1 '期待の一覧が無いディレクトリ' 'NG:' "$d"

if [ "$fails" -gt 0 ]; then
  echo "NG: ${fails} 件"
  exit 1
fi
echo "ok: すべて pass"
