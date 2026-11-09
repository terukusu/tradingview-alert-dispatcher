# Terraform の state のバケット。prod 用（#4 の infra/prod。CI の SA が読み書きする）と
# bootstrap 用（この構成の state。所有者が gcloud で先に作り imports.tf で取り込む。CI の SA の付与は付けない）

locals {
  state_buckets = {
    prod      = "${var.project_id}-tvad-tfstate"
    bootstrap = "${var.project_id}-tvad-tfstate-bootstrap"
  }
}

resource "google_storage_bucket" "tfstate" {
  for_each = local.state_buckets

  name                        = each.value
  location                    = upper(var.region)
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  deletion_policy             = "PREVENT"

  versioning {
    enabled = true
  }

  # 古い世代は新しい世代が 10 を超えたら消す
  lifecycle_rule {
    condition {
      num_newer_versions = 10
      with_state         = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}

# 付与は prod 用のバケットだけ。この 1 リソースに集める（テストで bootstrap 用への付与が無いことを確かめる）
resource "google_storage_bucket_iam_member" "prod_state" {
  for_each = {
    apply = { role = "roles/storage.objectUser", member = google_service_account.tf_apply.member }
    plan  = { role = "roles/storage.objectViewer", member = google_service_account.tf_plan.member }
  }

  bucket = google_storage_bucket.tfstate["prod"].name
  role   = each.value.role
  member = each.value.member
}
