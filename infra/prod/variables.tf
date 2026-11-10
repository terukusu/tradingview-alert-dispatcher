# 値は TF_VAR_* で渡す（deploy.yml・ci.yml は secrets / variables から。手元は infra/README.md「手元の plan（所有者）」）

variable "project_id" {
  description = "GCP のプロジェクト ID（リポジトリに書かない）"
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{4,28}[a-z0-9]$", var.project_id))
    error_message = "project_id が GCP のプロジェクト ID の形でない。"
  }
}

variable "region" {
  description = "サービスを置くリージョン（docs/design.md「リージョン」）"
  type        = string
  default     = "asia-northeast1"
}

variable "image" {
  description = "コンテナイメージ。bootstrap の Artifact Registry（tvad）の dispatcher だけ。apply は digest（@sha256:）の参照だけ（deploy.yml が検査する）。plan はまだ push していないタグ（:src-<20 桁>）も許す"
  type        = string

  validation {
    condition = (
      startswith(var.image, "${var.region}-docker.pkg.dev/${var.project_id}/tvad/dispatcher") &&
      can(regex("^(@sha256:[0-9a-f]{64}|:src-[0-9a-f]{20})$", substr(var.image, length("${var.region}-docker.pkg.dev/${var.project_id}/tvad/dispatcher"), -1)))
    )
    error_message = "image は <region>-docker.pkg.dev/<project_id>/tvad/dispatcher の @sha256:<64 桁> か :src-<20 桁> で渡す。"
  }
}

variable "max_instance_count" {
  description = "最大インスタンス数（docs/design.md「乱用への備え」。小さく保つ）"
  type        = number
  default     = 2

  validation {
    condition     = var.max_instance_count >= 1 && var.max_instance_count <= 5 && floor(var.max_instance_count) == var.max_instance_count
    error_message = "max_instance_count は 1〜5 の整数（超えるなら docs/design.md「乱用への備え」を見直す）。"
  }
}

variable "secret_version" {
  description = "Secret Manager のシークレットの版（docs/design.md「シークレットの版」）。latest は起動時に解決される"
  type        = string
  default     = "latest"

  validation {
    condition     = can(regex("^(latest|[1-9][0-9]*)$", var.secret_version))
    error_message = "secret_version は latest か正の整数。"
  }
}

variable "allowed_source_ips" {
  description = "送信元 IP の許可リスト（IPv4。docs/design.md「送信元 IP の許可リスト」）。既定は TradingView の webhook の送信元（公開の値）。[] で環境変数を置かない = 制限なし（切り戻し）"
  type        = list(string)
  default     = ["52.89.214.238", "34.212.75.30", "54.218.53.128", "52.32.178.7"]

  validation {
    condition     = alltrue([for ip in var.allowed_source_ips : can(regex("^((25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\\.){3}(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$", ip))])
    error_message = "allowed_source_ips は IPv4 だけ（CIDR・IPv6・ホスト名は不可）。"
  }
}
