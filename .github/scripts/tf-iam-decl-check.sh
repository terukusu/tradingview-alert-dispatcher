#!/usr/bin/env bash
# infra/bootstrap・infra/prod の IAM のリソースとログの設定のリソース（google_logging_*）の宣言（種類と名前）が
# 決めた一覧と同じかの検査。ci.yml の check で使う。
# 手元でもそのまま動く（infra/README.md「資格情報なしの検証」）。テストは tf-iam-decl-check.test.sh。
#
#   tf-iam-decl-check.sh [dir]   # dir の既定は infra/bootstrap。一覧はディレクトリの名前（bootstrap / prod）で選ぶ
#
# terraform test の assert は「そのリソースの中」の件数（for_each の数）しか見られず、別の名前・別の種類の
# IAM のリソース（*_iam_member / *_iam_binding / *_iam_policy）を足しても気づかない。ここで宣言の一覧を固定し、
# 増減があれば落とす。付与を増やすときは、この一覧と tests/bootstrap.tftest.hcl と docs/design.md「SA と権限」を一緒に直す。
# infra/prod は 0 件（IAM のリソースを置かない。plan SA の読み取りの権限で plan できるように）。
# 実際のプロジェクトの IAM の差分は、所有者の apply の後に infra/README.md「6. 事後の確認」で確かめる。
#
# ログの設定（#16）: bootstrap は _Default シンクへの除外 1 つ（google_logging_project_exclusion.tvad_rejected）だけ、
# prod は 0 件。google_logging_project_sink（_Default 全体を管理し、ほかの除外・包含フィルタを書き換えうる）や
# 2 つ目の除外を足したら落とす。terraform test の assert は宣言済みのアドレスしか見られないため、ここで固定する。
set -euo pipefail

dir="${1:-infra/bootstrap}"

case "$(basename "${dir%/}")" in
  bootstrap)
    want='resource "google_artifact_registry_repository_iam_member" "apply_writer"
resource "google_artifact_registry_repository_iam_member" "plan_reader"
resource "google_project_iam_member" "ci"
resource "google_secret_manager_secret_iam_member" "run_accessor"
resource "google_service_account_iam_member" "tf_apply_act_as_run"
resource "google_service_account_iam_member" "tf_apply_wif"
resource "google_service_account_iam_member" "tf_plan_wif"
resource "google_storage_bucket_iam_member" "prod_state"'
    want_logging='resource "google_logging_project_exclusion" "tvad_rejected"'
    ;;
  prod)
    want=''
    want_logging=''
    ;;
  *)
    echo "NG: $dir の期待の一覧が無いディレクトリ（bootstrap / prod だけ）"
    exit 1
    ;;
esac

# decls <種類の正規表現>: 宣言の一覧（整形して並べる）。
# .terraform（取ってきたモジュール・プロバイダ）は対象外。tests/ の .tftest.hcl は *.tf でないので入らない
decls() {
  find "$dir" -name '.terraform' -prune -o -type f -name '*.tf' -print0 \
    | xargs -0 grep -hoE "^[[:space:]]*resource[[:space:]]+\"$1\"[[:space:]]+\"[^\"]+\"" \
    | sed -E 's/^[[:space:]]*//; s/[[:space:]]+/ /g' | LC_ALL=C sort || true
}

# module を使うと宣言がこのディレクトリの外に出て数えられないので、使っていないことも確かめる
if find "$dir" -name '.terraform' -prune -o -type f -name '*.tf' -print0 | xargs -0 grep -qE '^[[:space:]]*module[[:space:]]+"'; then
  echo "NG: $dir に module がある（宣言を数えられない）"
  exit 1
fi

# check <名前> <期待の一覧> <実際の一覧>
check() {
  local label=$1 want got=$3
  want="$(printf '%s\n' "$2" | LC_ALL=C sort)"
  if [ "$got" != "$want" ]; then
    echo "NG: $dir の${label}のリソースの宣言が決めた一覧と違う"
    diff <(printf '%s\n' "$want") <(printf '%s\n' "$got") || true
    exit 1
  fi
}

got="$(decls 'google_[a-z0-9_]*_iam_[a-z_]+')"
got_logging="$(decls 'google_logging_[a-z0-9_]+')"
check ' IAM ' "$want" "$got"
check 'ログの設定' "$want_logging" "$got_logging"

# 0 件のとき printf | wc -l は 1 になるので、空でない行を数える
echo "ok: IAM のリソースの宣言 $(printf '%s\n' "$got" | grep -c . || true) 件"
echo "ok: ログの設定のリソースの宣言 $(printf '%s\n' "$got_logging" | grep -c . || true) 件"
