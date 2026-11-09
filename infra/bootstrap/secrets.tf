# Secret Manager の入れ物だけを作る（docs/design.md「シークレットの置き場（Secret Manager）」）。
# 版（値）のリソース・data source は書かない（値が state・plan に入らない）。値は所有者が gcloud で入れる（infra/README.md）

locals {
  secrets = {
    webhook_secret            = "tvad-webhook-secret"            # WEBHOOK_SECRET
    line_channel_access_token = "tvad-line-channel-access-token" # LINE_CHANNEL_ACCESS_TOKEN
    line_to                   = "tvad-line-to"                   # LINE_TO（秘密ではないがリポジトリと state に置かない）
  }
}

resource "google_secret_manager_secret" "this" {
  for_each = local.secrets

  secret_id       = each.value
  deletion_policy = "PREVENT"

  labels = {
    app = "tvad"
  }

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }
}

# 実行用 SA だけがシークレット単位で読める（apply SA・plan SA には付けない）
resource "google_secret_manager_secret_iam_member" "run_accessor" {
  for_each = google_secret_manager_secret.this

  project   = var.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = google_service_account.run.member
}
