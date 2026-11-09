#!/usr/bin/env bash
# .github/scripts/log-mask.sh のテスト（ci.yml の check で回す。手元でもそのまま動く）。
# 値はすべて架空。このファイル自身も repo-values-check.sh の対象（追跡される）なので、
# run.app のホスト・10 桁以上の番号の例は文字列の連結で組み立てる。
#
#   log-mask.test.sh
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
mask="$here/log-mask.sh"
fails=0

# filter_case <名前> <入力> <出力に無いこと（固定文字列）> <出力にあること（固定文字列）>
filter_case() {
  local label=$1 in=$2 absent=$3 present=$4 out
  out=$(printf '%s\n' "$in" | env GCP_PROJECT_ID="${PID:-}" "$mask" filter)
  if printf '%s' "$out" | grep -qF -e "$absent" || ! printf '%s' "$out" | grep -qF -e "$present"; then
    echo "FAIL ${label}: 出力 ${out}"
    fails=$((fails + 1))
  else
    echo "ok   ${label}"
  fi
}

num="1234""567890"
host="tvad-${num}"".asia-northeast1.run"".app"
filter_case '9 桁以上の数字' "project number ${num}" "$num" '<num>'
filter_case '9 桁ちょうど' "n=123456789" '123456789' 'n=<num>'
filter_case '8 桁以下はそのまま' "id 12345678 ok" '<num>' 'id 12345678 ok'
filter_case 'SA のメール' 'sa sa-tvad-run@example-project.iam.gserviceaccount.com x' 'example-project' 'sa <email> x'
filter_case '一般のメール' 'by someone@example.com.' 'someone@' 'by <email>.'
filter_case 'run.app の URL' "url https://${host}/health end" '.run.app' 'url <run-url> end'
filter_case 'run.app のホスト' "host ${host}" 'run.app' 'host <run-url>'
filter_case 'AR のパス' 'push asia-northeast1-docker.pkg.dev/example-project/tvad/dispatcher:src-0' 'example-project' 'asia-northeast1-docker.pkg.dev/<project>/tvad/dispatcher:src-0'
filter_case 'projects/<id>' 'name projects/example-project/locations/asia-northeast1/services/tvad' 'example-project' 'projects/<project>/locations/asia-northeast1/services/tvad'
filter_case 'projects/<番号>' "projects/${num}/locations/global" "$num" 'projects/<project>/locations/global'
filter_case 'state のバケット' 'bucket gs://example-project-tvad-tfstate/prod/default.tfstate' 'example-project' 'gs://<bucket>/prod/default.tfstate'
filter_case 'bootstrap のバケット' 'example-project-tvad-tfstate-bootstrap' 'example-project' '<bucket>'
filter_case 'Terraform のアドレスはそのまま' 'google_cloud_run_v2_service.tvad: Creating...' '<' 'google_cloud_run_v2_service.tvad: Creating...'
PID=example-project filter_case 'GCP_PROJECT_ID の値' 'Error: project example-project not found' 'example-project' 'project <project> not found'
PID=a.b filter_case 'GCP_PROJECT_ID は正規表現にしない' 'axb a.b' 'a.b' 'axb <project>'

# register
reg_case() {
  local label=$1 v=$2 want=$3 out rc=0
  out=$(env GCP_WIF_PROVIDER="$v" "$mask" register) || rc=$?
  if [ "$rc" -ne 0 ] || [ "$out" != "$want" ]; then
    echo "FAIL ${label}: exit ${rc} 出力 ${out}"
    fails=$((fails + 1))
  else
    echo "ok   ${label}"
  fi
}
reg_case 'register（番号を伏せる）' "projects/${num}/locations/global/workloadIdentityPools/p/providers/q" "::add-mask::${num}"
reg_case 'register（空なら何も出さない）' '' ''
reg_case 'register（形が違えば何も出さない）' 'not-a-provider' ''

rc=0
"$mask" unknown >/dev/null 2>&1 || rc=$?
if [ "$rc" -eq 2 ]; then echo "ok   未知の引数で exit 2"; else echo "FAIL 未知の引数: exit ${rc}"; fails=$((fails + 1)); fi

if [ "$fails" -gt 0 ]; then
  echo "NG: ${fails} 件"
  exit 1
fi
echo "ok: すべて pass"
