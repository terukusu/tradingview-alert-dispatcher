# bootstrap 用のバケットは state の置き場なので、所有者が init の前に gcloud で作り、ここで管理下に取り込む（infra/README.md）
import {
  to = google_storage_bucket.tfstate["bootstrap"]
  id = "${var.project_id}-tvad-tfstate-bootstrap"
}
