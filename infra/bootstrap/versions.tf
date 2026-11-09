# bootstrap（所有者が手元で 1 回 apply する土台）の Terraform とプロバイダの版。
# プロバイダは = で固定し、.terraform.lock.hcl をコミットする（infra/README.md）
terraform {
  required_version = "~> 1.16.4"

  required_providers {
    google = {
      source = "hashicorp/google"
      # invoker_iam_disabled（#4）は 6.8.0 で追加。8.9.0 のスキーマで確認済み
      version = "= 8.9.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
