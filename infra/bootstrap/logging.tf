# 弾いたリクエストのログを保存しない（docs/design.md「弾いたリクエストのログ」）。_Default シンクへの除外 1 つ（追加型）。
# google_logging_project_sink で _Default 全体を管理しない（ほかの除外・包含フィルタを書き換えうる）。
# 宣言の一覧は tf-iam-decl-check.sh で固定（google_logging_* はこの 1 つだけ）
resource "google_logging_project_exclusion" "tvad_rejected" {
  name        = "tvad-rejected-requests"
  description = "tvad: requests rejected with 401/403 and the app's forbidden lines (see docs/design.md)"
  # 1 行の文字列（heredoc は末尾に改行が入る）。tests/bootstrap.tftest.hcl で完全一致を固定
  filter = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"tvad\" AND ((log_id(\"run.googleapis.com/requests\") AND (httpRequest.status=401 OR httpRequest.status=403)) OR (log_id(\"run.googleapis.com/stdout\") AND jsonPayload.msg=\"forbidden\"))"
}
