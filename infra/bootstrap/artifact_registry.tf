# コンテナイメージの置き場（このリポジトリ用に新設）。付与はリポジトリ単位

resource "google_artifact_registry_repository" "tvad" {
  repository_id   = "tvad"
  location        = var.region
  format          = "DOCKER"
  description     = "tradingview-alert-dispatcher のイメージ"
  deletion_policy = "PREVENT"

  docker_config {
    immutable_tags = true
  }

  # 直近 5 版は残し、それ以外で 30 日を超えたものを消す（KEEP が DELETE より優先される）
  cleanup_policy_dry_run = false
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 5
    }
  }
  cleanup_policies {
    id     = "delete-old"
    action = "DELETE"
    condition {
      tag_state  = "ANY"
      older_than = "2592000s"
    }
  }
}

resource "google_artifact_registry_repository_iam_member" "apply_writer" {
  location   = google_artifact_registry_repository.tvad.location
  repository = google_artifact_registry_repository.tvad.repository_id
  role       = "roles/artifactregistry.writer"
  member     = google_service_account.tf_apply.member
}

resource "google_artifact_registry_repository_iam_member" "plan_reader" {
  location   = google_artifact_registry_repository.tvad.location
  repository = google_artifact_registry_repository.tvad.repository_id
  role       = "roles/artifactregistry.reader"
  member     = google_service_account.tf_plan.member
}
