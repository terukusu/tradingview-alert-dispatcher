# 実行時の依存は無い（Node の型の除去で src/*.ts をそのまま動かす）ので、package.json と src/ だけを入れる。
# ベースはタグと digest で固定する（タグは再ビルドで中身が変わるため）。更新するときは公開から 2 週間以上たった版にする
FROM node:24.22.0-slim@sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4

ENV PORT=8080
WORKDIR /app
# ファイルは root の持ち物のまま（実行ユーザーは読めるが書けない）
COPY package.json ./
COPY src ./src

# ベースイメージの非 root ユーザー
USER node
EXPOSE 8080
# exec 形式で node を PID 1 にし、SIGTERM を直接受ける（受付を止めて処理中の配信を待つ）
CMD ["node", "src/server.ts"]
