# #4 が GitHub の variables / secrets と infra/prod に渡す値。Issue・PR に貼らない

output "wif_provider_name" {
  description = "WIF のプロバイダの完全名（google-github-actions/auth の workload_identity_provider）。プロジェクト番号を含む"
  value       = google_iam_workload_identity_pool_provider.github.name
  sensitive   = true
}

output "sa_run_email" {
  description = "Cloud Run の実行用 SA"
  value       = google_service_account.run.email
}

output "sa_tf_apply_email" {
  description = "CI の apply 用 SA（Environment prod の job）"
  value       = google_service_account.tf_apply.email
}

output "sa_tf_plan_email" {
  description = "CI の plan 用 SA"
  value       = google_service_account.tf_plan.email
}

output "tf_state_bucket" {
  description = "infra/prod の state のバケット"
  value       = google_storage_bucket.tfstate["prod"].name
}

output "artifact_registry_repository" {
  description = "イメージの push 先（<region>-docker.pkg.dev/<project>/tvad）"
  value       = "${google_artifact_registry_repository.tvad.location}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.tvad.repository_id}"
}

output "secret_ids" {
  description = "シークレットの ID（infra/prod の secretKeyRef 用）"
  value       = { for k, s in google_secret_manager_secret.this : k => s.secret_id }
}
