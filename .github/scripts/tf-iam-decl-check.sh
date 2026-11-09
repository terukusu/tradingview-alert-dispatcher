#!/usr/bin/env bash
# infra/bootstrap の IAM のリソースの宣言（種類と名前）が決めた一覧と同じかの検査。ci.yml の check で使う。
# 手元でもそのまま動く（infra/README.md「資格情報なしの検証」）。
#
#   tf-iam-decl-check.sh [dir]   # dir の既定は infra/bootstrap
#
# terraform test の assert は「そのリソースの中」の件数（for_each の数）しか見られず、別の名前・別の種類の
# IAM のリソース（*_iam_member / *_iam_binding / *_iam_policy）を足しても気づかない。ここで宣言の一覧を固定し、
# 増減があれば落とす。付与を増やすときは、この一覧と tests/bootstrap.tftest.hcl と docs/design.md「SA と権限」を一緒に直す。
# 実際のプロジェクトの IAM の差分は、所有者の apply の後に infra/README.md「6. 事後の確認」で確かめる。
set -euo pipefail

dir="${1:-infra/bootstrap}"

want='resource "google_artifact_registry_repository_iam_member" "apply_writer"
resource "google_artifact_registry_repository_iam_member" "plan_reader"
resource "google_project_iam_member" "ci"
resource "google_secret_manager_secret_iam_member" "run_accessor"
resource "google_service_account_iam_member" "tf_apply_act_as_run"
resource "google_service_account_iam_member" "tf_apply_wif"
resource "google_service_account_iam_member" "tf_plan_wif"
resource "google_storage_bucket_iam_member" "prod_state"'

# .terraform（取ってきたモジュール・プロバイダ）は対象外。tests/ の .tftest.hcl は *.tf でないので入らない
got="$(find "$dir" -name '.terraform' -prune -o -type f -name '*.tf' -print0 \
  | xargs -0 grep -hoE '^[[:space:]]*resource[[:space:]]+"google_[a-z0-9_]*_iam_[a-z_]+"[[:space:]]+"[^"]+"' \
  | sed -E 's/^[[:space:]]*//; s/[[:space:]]+/ /g' | LC_ALL=C sort || true)"

# module を使うと宣言がこのディレクトリの外に出て数えられないので、使っていないことも確かめる
if find "$dir" -name '.terraform' -prune -o -type f -name '*.tf' -print0 | xargs -0 grep -qE '^[[:space:]]*module[[:space:]]+"'; then
  echo "NG: $dir に module がある（IAM の宣言を数えられない）"
  exit 1
fi

if [ "$got" != "$(printf '%s\n' "$want" | LC_ALL=C sort)" ]; then
  echo "NG: $dir の IAM のリソースの宣言が決めた一覧と違う"
  diff <(printf '%s\n' "$want" | LC_ALL=C sort) <(printf '%s\n' "$got") || true
  exit 1
fi
echo "ok: IAM のリソースの宣言 $(printf '%s\n' "$got" | wc -l) 件"
