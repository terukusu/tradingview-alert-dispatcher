# prod（Cloud Run のサービス。deploy.yml が Environment prod の承認の後に apply する）の Terraform とプロバイダの版。
# 版は infra/bootstrap と揃える。プロバイダは = で固定し、.terraform.lock.hcl をコミットする（infra/README.md）
terraform {
  required_version = "~> 1.16.4"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "= 8.9.0"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
