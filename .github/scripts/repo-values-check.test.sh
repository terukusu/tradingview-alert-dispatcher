#!/usr/bin/env bash
# .github/scripts/repo-values-check.sh のテスト（ci.yml の check で検査の前に回す。手元でもそのまま動く）。
# 一時ディレクトリの git リポジトリに 1 ファイル（f.txt）だけ置いて検査を呼び、exit コードと出力を確かめる。
# 陽性: exit 1、出力に置いた文字列が無く、f.txt:1 がある。陰性: exit 0。
# このファイル自身も検査の対象（追跡される）なので、陽性の文字列は連結で組み立てる。
#
#   repo-values-check.test.sh
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
check="$here/repo-values-check.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fails=0
n=0

# run <期待の exit> <名前> <f.txt の中身> [VAR=値 ...]: 値の環境変数は指定したもの以外を空にする。
# 置くファイルの名前は RUN_FILE（既定 f.txt）
run() {
  local want=$1 label=$2 content=$3 file=${RUN_FILE:-f.txt}
  shift 3
  local dir="$tmp/r$n" out rc=0
  n=$((n + 1))
  mkdir -p "$dir"
  git -C "$dir" init -q
  printf '%s\n' "$content" > "$dir/$file"
  git -C "$dir" add "$file"
  out=$(env GCP_PROJECT_ID= GCP_PROJECT_NUMBER= REPO_OWNER= "$@" "$check" "$dir" 2>&1) || rc=$?
  local why=""
  if [ "$rc" -ne "$want" ]; then why="exit $rc（期待 $want）"; fi
  if [ "$want" -ne 0 ]; then
    if printf '%s' "$out" | grep -qF -e "$content"; then why="$why 出力に置いた文字列がある"; fi
    if ! printf '%s' "$out" | grep -qF "$file:1"; then why="$why 出力に $file:1 が無い"; fi
  fi
  if [ -n "$why" ]; then
    echo "FAIL ${label}:${why}"
    fails=$((fails + 1))
  else
    echo "ok   ${label}"
  fi
  LAST_OUT=$out
}

# 陽性（架空の値。連結で組み立てる）
run 1 'a.run.app（-<英数字>-<略号>）' "url https://simulator-abc123xyz""-an.a.run""."app/
run 1 'run.app（<名前>-<番号>.<リージョン>）' "simulator-123456789012"".asia-northeast1.run""."app
run 1 'gmail のメール' "contact some""one@gm""ail.com"
run 1 'ホームのパス' "path /ho""me/alice/x"
run 1 'macOS のホームのパス' "/Use""rs/alice/x"
run 1 'projects/<13 桁>' "projects/""1234567890123/x"
run 1 'service-<10 桁>@' "service-""1234567890@gcp-sa-iap.iam.gserviceaccount.com"
run 1 'ya29. のトークン' "token ya""29.a0Abcdef"
run 1 'OAuth クライアントのシークレット' "GOCSP""X-abcdef"
run 1 '秘密鍵' "-----BEGIN ""PRIVATE KEY-----"
run 1 'SA 鍵の private_key_id' "\"private_key""_id\": \"x\""
run 1 '署名付き URL' "https://storage.googleapis.com/b/o?X-Goog-""Signature=abc"
run 1 'Anthropic の API キーの形' "ANTHROPIC_API_KEY=sk-""ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-x"
run 1 'Anthropic の OAuth トークンの形' "token sk-""ant-oat01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"
run 1 'LINE の userId の形' "to: U0123456789abcdef""0123456789abcdef"
run 1 'LINE の groupId の形' "C0123456789abcdef""0123456789abcdef"
run 1 'LINE のチャネルアクセストークンの形' "LINE_CHANNEL_ACCESS_TOKEN=$(printf 'Ab+/%.0s' $(seq 1 45))""="
run 1 'プロジェクト ID の値' "project = fake-proj""-123456" GCP_PROJECT_ID=fake-proj-123456
run 1 'プロジェクト ID の値（バケット名の一部）' "bucket fake-proj""-123456-sim-tfstate" GCP_PROJECT_ID=fake-proj-123456
run 1 'プロジェクト ID の値（大小無視）' "FAKE-PROJ""-123456" GCP_PROJECT_ID=fake-proj-123456
run 1 'プロジェクト番号の値' "number 98765""4321" GCP_PROJECT_NUMBER=987654321
run 1 'オーナー名の値' "see fake""owner/repo" REPO_OWNER=fakeowner
RUN_FILE=LICENSE run 1 'LICENSE でも著作権表示の行でなければ NG' "maintained by fake""owner" REPO_OWNER=fakeowner
RUN_FILE=LICENSE run 1 'LICENSE の著作権表示に続きがあれば NG' "Copyright (c) 2026 fake""owner and fake""owner/repo" REPO_OWNER=fakeowner
RUN_FILE=README.md run 1 'LICENSE 以外の著作権表示は NG' "Copyright (c) 2026 fake""owner" REPO_OWNER=fakeowner

# 陰性（プレースホルダ）
run 0 'example.com のメール' 'someone@example.com'
run 0 '<PROJECT_ID>' 'gcloud config set project <PROJECT_ID>'
run 0 'service-<6 桁>@gcp-sa-iap' 'service-123456@gcp-sa-iap.iam.gserviceaccount.com'
run 0 'example-project の SA' 'sa-x@example-project.iam.gserviceaccount.com'
# shellcheck disable=SC2016 # $P はそのままの文字列として置く
run 0 '$P と <OWNER>/<REPO>' 'SA=sa-simulator@$P.iam.gserviceaccount.com <OWNER>/<REPO>'
run 0 '/home/<名前>/' 'ls /home/<名前>/'
run 0 '<SERVICE>-<HASH>-an.a.run.app' 'https://<SERVICE>-<HASH>-an.a.run.app/'
run 0 'projects/<6 桁>' 'projects/123456/locations'
run 0 'sk-ant- の接頭辞だけ（説明文）' 'キーは sk-ant- で始まる（sk-ant-api03-... / sk-ant-oat01-...）'
run 0 '語単位（値の続きが英数字）' 'fake-proj-1234567' GCP_PROJECT_ID=fake-proj-123456
RUN_FILE=LICENSE run 0 'LICENSE の著作権表示の行だけは例外' "Copyright (c) 2026 fake""owner" REPO_OWNER=fakeowner
RUN_FILE=LICENSE run 0 'LICENSE の著作権表示（年の範囲・大小無視）' "Copyright (c) 2026-2027 Fake""Owner" REPO_OWNER=fakeowner
run 0 'LINE の ID のプレースホルダ' 'LINE_TO=U<32 桁の 16 進>,<groupId>'
run 0 '33 桁以上の 16 進は LINE の ID としない' 'sha 0123456789abcdef0123456789abcdef01'
run 0 '変数が空なら形の検査だけ' 'nothing here'
if [ "$(printf '%s\n' "$LAST_OUT" | grep -c '^skip: ')" -ne 3 ]; then
  echo "FAIL 変数が空のときの skip: が 3 行でない"
  fails=$((fails + 1))
fi

# このファイル自身を含む今のリポジトリ（変数は空）
rc=0
env GCP_PROJECT_ID= GCP_PROJECT_NUMBER= REPO_OWNER= "$check" "$here/../.." > /dev/null || rc=$?
if [ "$rc" -ne 0 ]; then
  echo "FAIL 今のリポジトリで exit $rc"
  fails=$((fails + 1))
else
  echo "ok   今のリポジトリ"
fi

if [ "$fails" -gt 0 ]; then
  echo "NG: ${fails} 件"
  exit 1
fi
echo "ok: すべて"
