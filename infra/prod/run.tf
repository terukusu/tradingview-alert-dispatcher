# Cloud Run のサービス（docs/design.md「公開方式」「送信のタイミング」「シークレットの置き場」）。
# IAM のリソースと data source は書かない（plan SA の読み取りの権限で plan できるように。tf-iam-decl-check.sh で 0 件を固定）

locals {
  # bootstrap の実行用 SA（data source で引かずに組み立てる）
  run_service_account = "sa-tvad-run@${var.project_id}.iam.gserviceaccount.com"

  # アプリの環境変数 → bootstrap のシークレット。平文の value は置かない。
  # PORT は Cloud Run が注入し、CONFIG_PATH は使わない（本番は環境変数だけの LINE の 1 チャネル）
  secret_env = {
    WEBHOOK_SECRET            = "tvad-webhook-secret"
    LINE_CHANNEL_ACCESS_TOKEN = "tvad-line-channel-access-token"
    LINE_TO                   = "tvad-line-to"
  }
}

resource "google_cloud_run_v2_service" "tvad" {
  name     = "tvad"
  location = var.region

  # TradingView はインターネットから来る。認証はアプリの共有シークレット（Invoker の公開の付与はしない）
  ingress              = "INGRESS_TRAFFIC_ALL"
  invoker_iam_disabled = true
  # destroy と作り直し（replace）を止める。撤去は infra/README.md「撤去」の 2 段で
  deletion_protection = true

  template {
    service_account = local.run_service_account

    scaling {
      min_instance_count = 0
      max_instance_count = var.max_instance_count
    }

    containers {
      image = var.image

      # instance-based billing（cpu_idle = false）。応答の後の送信に CPU を割り当てる。メモリ 512 MiB 以上が条件
      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
        cpu_idle = false
      }

      dynamic "env" {
        for_each = local.secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = var.secret_version
            }
          }
        }
      }
      # 起動プローブは Cloud Run の既定（TCP）。HTTP のプローブは使わない（docs/design.md「ヘルスチェックのパス」）
    }
  }

  # 明示する: 緊急の gcloud run services update-traffic でリビジョンを固定したら plan に差分が出て、次の apply で最新に戻る
  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }
}
