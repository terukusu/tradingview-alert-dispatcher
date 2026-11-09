# 値は既定を持たず TF_VAR_* か未追跡の local.auto.tfvars で渡す（infra/README.md「共通の変数」）

variable "project_id" {
  description = "GCP のプロジェクト ID（リポジトリに書かない）"
  type        = string
}

variable "region" {
  description = "リソースを置くリージョン（docs/design.md「リージョン」）"
  type        = string
  default     = "asia-northeast1"
}

variable "github_repository" {
  description = "GitHub のリポジトリ（<owner>/<name>）。WIF の subject に使う"
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$", var.github_repository))
    error_message = "github_repository は <owner>/<name> の形で渡す。"
  }
}

variable "github_repository_id" {
  description = "GitHub のリポジトリの数値 ID（gh api repos/<owner>/<repo> --jq .id）"
  type        = string

  validation {
    condition     = can(regex("^[0-9]+$", var.github_repository_id))
    error_message = "github_repository_id は数字だけで渡す。"
  }
}

variable "github_owner_id" {
  description = "GitHub のオーナーの数値 ID（gh api repos/<owner>/<repo> --jq .owner.id）"
  type        = string

  validation {
    condition     = can(regex("^[0-9]+$", var.github_owner_id))
    error_message = "github_owner_id は数字だけで渡す。"
  }
}

variable "github_oidc_immutable_subject" {
  description = "GitHub の OIDC の sub が不変 ID 入りの形式（repo:<owner>@<owner_id>/<repo>@<repo_id>:...）なら true、従来の形式（repo:<owner>/<repo>:...）なら false"
  type        = bool
  default     = true
}
