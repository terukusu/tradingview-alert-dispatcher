#!/usr/bin/env bash
# コンテナイメージの検査。ci.yml の check で docker build の後に使う。手元でもそのまま動く（README.md「開発」）。
#
#   image-check.sh <image>
#
# - 非 root で動く・/app に package.json と src/ だけがある・package.json に dependencies が無い
# - 架空のシークレットと PORT=9090 で起動し、GET /health が 200 で ok・GET /healthz が 404・シークレットなしの POST /webhook が 401
#   （PORT の注入と 0.0.0.0 の待ち受けの確認を兼ねる。認証の通るリクエストは送らない = 通知の API を呼ばない）
# - docker stop（SIGTERM）で 10 秒未満に終了コード 0 で終わる
# - 出力は ok: / NG: の行だけ（シークレットの値・コンテナのログは出さない）。NG が出たら exit 1
set -euo pipefail

image="${1:?usage: image-check.sh <image>}"
container=""
cleanup() {
  if [ -n "$container" ]; then docker rm -f "$container" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT
# docker run などが失敗して set -e で抜けるときも NG の行を出す（fail() と || の分岐では呼ばれない）
trap 'echo "NG: コマンドが失敗した（${BASH_SOURCE[0]##*/} の ${LINENO} 行目）"' ERR

fail() {
  echo "NG: $*"
  exit 1
}

# 1. 非 root
uid="$(docker run --rm --entrypoint id "$image" -u)"
[ "$uid" != "0" ] || fail "root で動く"
echo "ok: 非 root（uid ${uid}）"

# 2. /app の中身（ベースの node_modules があるので / 全体は探さない）
entries="$(docker run --rm --entrypoint ls "$image" -A /app | sort | tr '\n' ' ')"
[ "$entries" = "package.json src " ] || fail "/app に package.json と src 以外がある: ${entries}"
extra="$(docker run --rm --entrypoint find "$image" /app \( -name node_modules -o -name .git -o -name .env -o -name config.json -o -name test \))"
[ -z "$extra" ] || fail "/app に入れないものがある"
echo "ok: /app の中身"

# 3. 実行時の依存が無い
docker run --rm --entrypoint node "$image" -e \
  'process.exit(require("/app/package.json").dependencies === undefined ? 0 : 1)' ||
  fail "package.json に dependencies がある"
echo "ok: dependencies なし"

# 4. 起動して HTTP を確かめる（値は架空。LINE_TO は渡さない = broadcast の設定。認証の通るリクエストは送らない）
container="$(docker run -d -p 127.0.0.1::9090 -e PORT=9090 \
  -e WEBHOOK_SECRET=image-check-dummy-secret \
  -e LINE_CHANNEL_ACCESS_TOKEN=image-check-dummy-token \
  "$image")"
port="$(docker port "$container" 9090/tcp | head -n1 | sed 's/.*://')"
[ -n "$port" ] || fail "公開ポートが取れない"
base="http://127.0.0.1:${port}"

status() { curl -s -o /dev/null -w '%{http_code}' "$@" || true; }
ready=""
for _ in $(seq 1 30); do
  if [ "$(status "${base}/health")" = "200" ]; then
    ready=1
    break
  fi
  sleep 0.5
done
[ -n "$ready" ] || fail "/health が 200 にならない（PORT=9090・0.0.0.0 で待ち受けていない）"
[ "$(curl -s "${base}/health")" = "ok" ] || fail "/health の本文が ok でない"
echo "ok: GET /health は 200 で本文 ok（PORT=9090 で待ち受け）"
[ "$(status "${base}/healthz")" = "404" ] || fail "/healthz が 404 でない"
echo "ok: GET /healthz は 404"
[ "$(status -X POST -d 'x' "${base}/webhook")" = "401" ] || fail "シークレットなしの POST /webhook が 401 でない"
echo "ok: シークレットなしの POST /webhook は 401"

# 5. SIGTERM で終了コード 0
started="$(date +%s)"
docker stop -t 10 "$container" >/dev/null
elapsed=$(($(date +%s) - started))
[ "$elapsed" -lt 10 ] || fail "docker stop に ${elapsed} 秒かかった（SIGTERM で終わらない）"
code="$(docker inspect -f '{{.State.ExitCode}}' "$container")"
[ "$code" = "0" ] || fail "終了コードが ${code}"
echo "ok: docker stop で終了コード 0（${elapsed} 秒）"
