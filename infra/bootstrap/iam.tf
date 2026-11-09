# SA と IAM の付与。付与は追加型（*_iam_member）だけ。*_iam_policy / *_iam_binding は使わない
# （同じプロジェクトの既存の付与を書き換えないため。docs/design.md「SA と権限」）

resource "google_service_account" "run" {
  account_id      = "sa-tvad-run"
  display_name    = "tvad Cloud Run runtime"
  description     = "Cloud Run のランタイム。付与はシークレット単位の secretAccessor だけ（secrets.tf）"
  deletion_policy = "PREVENT"
}

resource "google_service_account" "tf_apply" {
  account_id      = "sa-tvad-tf-apply"
  display_name    = "tvad Terraform apply (CI)"
  description     = "infra/prod の apply 用。借用は GitHub の Environment prod の job だけ"
  deletion_policy = "PREVENT"
}

resource "google_service_account" "tf_plan" {
  account_id      = "sa-tvad-tf-plan"
  display_name    = "tvad Terraform plan (CI)"
  description     = "infra/prod の plan 用（読み取りだけ）"
  deletion_policy = "PREVENT"
}

locals {
  github_owner = split("/", var.github_repository)[0]
  github_repo  = split("/", var.github_repository)[1]

  # Environment prod の job の OIDC の sub。不変 ID 入りの形式は
  # gh api repos/<owner>/<repo>/actions/oidc/customization/sub の use_immutable_subject で確かめる（infra/README.md）
  apply_subject = (var.github_oidc_immutable_subject
    ? "repo:${local.github_owner}@${var.github_owner_id}/${local.github_repo}@${var.github_repository_id}:environment:prod"
    : "repo:${var.github_repository}:environment:prod"
  )
}

# apply SA の借用は Environment prod の subject 1 件だけ。Environment prod は bootstrap の apply より前に
# main 限定・承認必須にしておく（infra/README.md「0. 前提」）。WIF のプロバイダの条件でも main の ref に限る（wif.tf）
resource "google_service_account_iam_member" "tf_apply_wif" {
  service_account_id = google_service_account.tf_apply.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principal://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/subject/${local.apply_subject}"
}

# plan SA の借用はこのリポジトリ（数値 ID）の job（PR の plan）
resource "google_service_account_iam_member" "tf_plan_wif" {
  service_account_id = google_service_account.tf_plan.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository_id/${var.github_repository_id}"
}

# apply SA が Cloud Run のサービスに実行用 SA を設定するための actAs。実行用 SA 単位（プロジェクト単位にしない）
resource "google_service_account_iam_member" "tf_apply_act_as_run" {
  service_account_id = google_service_account.run.name
  role               = "roles/iam.serviceAccountUser"
  member             = google_service_account.tf_apply.member
}

# プロジェクト単位の付与はこの 1 リソースに集める（テストで「2 件だけ」を確かめる）。
#
# apply SA の roles/run.admin は条件なしのプロジェクト単位（docs/design.md「apply SA の Cloud Run の権限」）。
# Cloud Run は IAM の条件のリソース属性（resource.name など）に対応しておらず、条件をつけると何も許可されない。
# #4 の invoker_iam_disabled には run.services.setIamPolicy が要り、run.developer では足りない。
# 同じプロジェクトの既存のサービスも変更できる権限になるので、次で緩和する:
#   - 借用は Environment prod の job の subject 1 件だけ。Environment prod は bootstrap の apply より前に main 限定・承認必須にする
#   - WIF のプロバイダの条件で、Environment prod のトークンは ref が main のときだけ受け付ける（wif.tf）
#   - deploy.yml は承認の前に plan の要約（アドレスと操作）を出す（#4）
#   - apply の後に既存のサービスのリビジョンと IAM が変わっていないことを確かめる（infra/README.md）
# 出典: https://docs.cloud.google.com/iam/docs/conditions-resource-attributes
#       https://docs.cloud.google.com/iam/docs/conditions-attribute-reference
resource "google_project_iam_member" "ci" {
  for_each = {
    apply_run_admin = { role = "roles/run.admin", member = google_service_account.tf_apply.member }
    plan_run_viewer = { role = "roles/run.viewer", member = google_service_account.tf_plan.member }
  }

  project = var.project_id
  role    = each.value.role
  member  = each.value.member
}
