#!/usr/bin/env bash
# terraform の plan ファイルから「アドレスと操作」だけを出す（値 = before / after は一切出さない）。deploy.yml・ci.yml で使う。
# 公開リポジトリのジョブの要約（$GITHUB_STEP_SUMMARY）に plan の全文を出さないため（docs/design.md「公開リポジトリの CI のログ」）。
#
#   tf-plan-summary.sh [--ops] <plan ファイル | ->
#
# - 既定: Markdown（操作ごとの件数の表と、`アドレス`: 操作 の一覧。差分が無ければ「差分なし（No changes）」）
# - --ops: 「アドレス<TAB>操作」を sort した行（差分が無ければ何も出さない）。承認した plan と apply の直前の plan の
#   操作が同じかを比べる指紋に使う（sha256sum に通す）
# - plan ファイルは init 済みのディレクトリで terraform show -json する（-chdir=<ファイルのディレクトリ>）。
#   - なら標準入力から terraform show -json の出力を読む（テスト用）。terraform は環境変数 TERRAFORM（既定 terraform）
# - 操作: create / update / delete / replace（delete+create・create+delete）、import の取り込みは import（+ 操作）。
#   no-op・read は出さない
set -euo pipefail

ops_only=false
if [ "${1:-}" = "--ops" ]; then
  ops_only=true
  shift
fi
plan="${1:?usage: tf-plan-summary.sh [--ops] <plan ファイル | ->}"

if [ "$plan" = "-" ]; then
  json=$(cat)
else
  # terraform のエラー出力も GCP の値を伏せてから出す（log-mask.sh filter を必ず通す）
  err=$(mktemp)
  if ! json=$(${TERRAFORM:-terraform} -chdir="$(dirname "$plan")" show -json -no-color "$(basename "$plan")" 2>"$err"); then
    "$(dirname "$0")/log-mask.sh" filter <"$err" >&2
    rm -f "$err"
    exit 1
  fi
  rm -f "$err"
fi

ops=$(printf '%s' "$json" | jq -r '
  [.resource_changes[]? | {
      address,
      op: (.change.actions as $a
        | (if ($a | sort) == ["create", "delete"] then "replace"
           elif $a == ["no-op"] or $a == ["read"] then ""
           else ($a | join("+")) end) as $op
        | if .change.importing then (if $op == "" then "import" else "import+" + $op end) else $op end)
    } | select(.op != "")]
  | .[] | "\(.address)\t\(.op)"' | LC_ALL=C sort)

if $ops_only; then
  if [ -n "$ops" ]; then printf '%s\n' "$ops"; fi
  exit 0
fi

if [ -z "$ops" ]; then
  echo "差分なし（No changes）"
  exit 0
fi
echo "| 操作 | 件数 |"
echo "|---|---|"
printf '%s\n' "$ops" | cut -f2 | LC_ALL=C sort | uniq -c | awk '{ printf "| %s | %s |\n", $2, $1 }'
echo
printf '%s\n' "$ops" | awk -F '\t' '{ printf "- `%s`: %s\n", $1, $2 }'
