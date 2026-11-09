#!/usr/bin/env bash
# 追跡しているファイルに個人の値・秘匿情報（CLAUDE.md「置かないもの」）が無いかの検査。
# ci.yml の check で使う。手元でもそのまま動く（README.md「開発」）。
#
#   repo-values-check.sh [dir]
#
# - 形の検査（値を知らなくても効く）: run.app のホスト名、許可リスト外のドメインのメールアドレス、
#   /home/<名前>・/Users/<名前>、10 桁以上の projects/<番号>・service-<番号>、トークン・鍵・署名の形（Anthropic の sk-ant- を含む）、
#   LINE の userId / groupId / roomId（U・C・R + 16 進 32 桁）とチャネルアクセストークン（長い base64）の形
# - 値の検査: 環境変数 GCP_PROJECT_ID・GCP_PROJECT_NUMBER・REPO_OWNER のうち空でないものを固定文字列
#   （大小無視・語単位）で探す。空なら飛ばしたことを 1 行出す。例外は LICENSE の著作権表示の行
#   `Copyright (c) <年>[-<年>] <REPO_OWNER>` ちょうどだけ（MIT の著作権者。オーナーが決めた名前。ほかのファイル・行は NG のまま）
# - 出力は「NG <検査名>: <ファイル>:<行番号>」と件数だけ（一致した文字列・行の中身・変数の値は出さない）。1 件以上で exit 1
# - 対象は git ls-files（package-lock.json・api/uv.lock を除く。バイナリは grep -I で飛ばす）
set -euo pipefail

cd "${1:-.}"
mapfile -d '' files < <(git ls-files -z | { grep -zvE '^(package-lock\.json|api/uv\.lock)$' || true; })
if [ "${#files[@]}" -eq 0 ]; then
  echo "ok: 追跡ファイルなし"
  exit 0
fi

hits=0
# 標準入力の grep -Hn の出力（<ファイル>:<行番号>:<中身>）から位置だけを出して数える。
# grep には必ず -H を付ける（1 ファイルだと -n の出力が <行番号>:<中身> になり、中身が出てしまう）。
# 呼び出しはプロセス置換で（パイプだとサブシェルになり hits が増えない）
report() {
  local loc
  while IFS= read -r loc; do
    echo "NG ${1}: ${loc}"
    hits=$((hits + 1))
  done < <(cut -d: -f1,2 | sort -u)
}
shape() { report "$1" < <(grep -HnsIE -e "$2" -- "${files[@]}" || true); }

shape run-app-host '[a-z0-9][a-z0-9-]*-[a-z0-9]+-[a-z]{2,4}\.a\.run\.app|[a-z0-9][a-z0-9-]*-[0-9]+\.[a-z]+-[a-z]+[0-9]+\.run\.app'
shape home-path '/(home|Users)/[A-Za-z0-9._-]+'
shape project-number '(projects/|service-)[0-9]{10,}'
# [X] などはこのファイル自身に一致させないための書き方
# [s]k-ant-: Anthropic の API キー・OAuth トークン（sk-ant-<種別>-<本体>。種別は api03・oat01 など。接頭辞だけの説明文には一致しない）
shape line-id '(^|[^A-Za-z0-9])[UCR][0-9a-f]{32}([^A-Za-z0-9]|$)'
shape line-token '[A-Za-z0-9+/]{160,}={0,2}'
shape token 'ya29\.[A-Za-z0-9_-]|GOCSP[X]-|-----BEGIN [A-Z ]*PRIVATE KEY-----|"private_key_i[d]"|X-Goog-Signatur[e]=|[s]k-ant-[a-z]+[0-9]*-[A-Za-z0-9_-]{20,}'

# メールアドレスはドメインがプレースホルダの許可リストに無いものだけ。awk には ENVIRON で渡す（-v だと \. が崩れる）
export REPO_VALUES_ALLOW='^(example\.(com|org|net)|[a-z0-9-]+\.example\.com|example-project\.iam\.gserviceaccount\.com|gcp-sa-[a-z-]+\.iam\.gserviceaccount\.com)$'
report email-domain < <({ grep -HnosIE -e '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}' -- "${files[@]}" || true; } \
  | awk -F: '{ m = $NF; d = tolower(substr(m, index(m, "@") + 1)); if (d !~ ENVIRON["REPO_VALUES_ALLOW"]) print $1 ":" $2 }')

for name in GCP_PROJECT_ID GCP_PROJECT_NUMBER REPO_OWNER; do
  v=${!name:-}
  if [ -z "$v" ]; then
    echo "skip: ${name} が空なので値の検査を飛ばす"
    continue
  fi
  if [ "$name" = REPO_OWNER ]; then
    # LICENSE の著作権表示の行だけを除く（値は ENVIRON で比べる。正規表現に値を入れない）
    report "value-${name}" < <({ grep -HnsIFiw -e "$v" -- "${files[@]}" || true; } | REPO_VALUES_V="$v" awk '{
      f = $0; i = index(f, ":"); file = substr(f, 1, i - 1); r = substr(f, i + 1); j = index(r, ":"); body = substr(r, j + 1)
      sub(/\r$/, "", body)
      if (file == "LICENSE" && match(body, /^Copyright \(c\) [0-9][0-9][0-9][0-9](-[0-9][0-9][0-9][0-9])? /) &&
          tolower(substr(body, RLENGTH + 1)) == tolower(ENVIRON["REPO_VALUES_V"])) next
      print
    }')
  else
    report "value-${name}" < <(grep -HnsIFiw -e "$v" -- "${files[@]}" || true)
  fi
done

if [ "$hits" -gt 0 ]; then
  echo "NG: ${hits} 件（CLAUDE.md「置かないもの」。値はプレースホルダ・変数にする）"
  exit 1
fi
echo "ok: ${#files[@]} ファイル"
