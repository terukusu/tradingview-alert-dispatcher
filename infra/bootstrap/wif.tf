# GitHub Actions の OIDC で鍵なしに GCP を使うための Workload Identity Federation（このリポジトリ用に新設）。
# 同じプロジェクトの既存のプール・プロバイダは別リポジトリの管理物なので使わない（docs/design.md「WIF・tfstate・Artifact Registry」）

resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "tvad-github"
  display_name              = "tvad GitHub Actions"
  description               = "tradingview-alert-dispatcher の GitHub Actions 用"
  deletion_policy           = "PREVENT"
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-actions"
  display_name                       = "GitHub Actions"
  deletion_policy                    = "PREVENT"

  attribute_mapping = {
    "google.subject"                = "assertion.sub"
    "attribute.repository_id"       = "assertion.repository_id"
    "attribute.repository_owner_id" = "assertion.repository_owner_id"
    "attribute.ref"                 = "assertion.ref"
  }

  # 1. リポジトリの数値 ID とオーナーの数値 ID の両方で固定する（名前は変えられる・取り直せるので使わない）
  # 2. 多層防御: Environment prod の job のトークン（sub が ":environment:prod" で終わる）は ref が main のときだけ受け付ける。
  #    ブランチの制限の本体は Environment prod の deployment branch policy（infra/README.md「0. 前提」）。
  #    ここはそれが外れた・緩められたときの 2 枚目（apply SA の借用は sub が Environment prod のものだけ = iam.tf）。
  #    environment クレームではなく sub で判定する: environment クレームは Environment を参照する job のトークンにしか無く、
  #    CEL では無いキーの参照は実行時エラー（no_such_field）で、条件が true にならないトークンは拒否される。
  #    has() で守る書き方もできるが、sub は全トークンにあり（google.subject の元）、Environment 名の ":" は "%3A" に
  #    置き換わるので、末尾が ":environment:prod" になるのは Environment prod の job だけ。ref も全トークンにある。
  #    環境の無い job（PR の plan など）は前半が true になるので従来どおり通る。
  # 出典: https://docs.cloud.google.com/iam/docs/workload-identity-federation（true 以外は拒否）
  #       https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines（assertion.ref の条件の例）
  #       https://docs.github.com/en/actions/reference/security/oidc（environment・ref・sub のクレーム、":" → "%3A"）
  #       https://github.com/google/cel-spec/blob/master/doc/langdef.md（has() とマップ、no_such_field、&& / || とエラー）
  attribute_condition = join(" && ", [
    "assertion.repository_id == '${var.github_repository_id}'",
    "assertion.repository_owner_id == '${var.github_owner_id}'",
    "(!assertion.sub.endsWith(':environment:prod') || assertion.ref == 'refs/heads/main')",
  ])

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}
