# infra/prod の構成のテスト（資格情報なし。モックのプロバイダで apply する）。
# 値はすべて架空（example-project・digest は a の 64 桁）

mock_provider "google" {}

variables {
  project_id = "example-project"
  image      = "asia-northeast1-docker.pkg.dev/example-project/tvad/dispatcher@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}

run "defaults" {
  command = apply

  # AC 3.1 公開・消し防止・traffic
  assert {
    condition     = google_cloud_run_v2_service.tvad.name == "tvad" && google_cloud_run_v2_service.tvad.location == "asia-northeast1"
    error_message = "サービスの名前かリージョンが違う"
  }
  assert {
    condition     = google_cloud_run_v2_service.tvad.ingress == "INGRESS_TRAFFIC_ALL" && google_cloud_run_v2_service.tvad.invoker_iam_disabled == true
    error_message = "ingress が all でないか、Invoker の IAM チェックが無効でない"
  }
  assert {
    condition     = google_cloud_run_v2_service.tvad.deletion_protection == true
    error_message = "deletion_protection が true でない"
  }
  assert {
    condition     = google_cloud_run_v2_service.tvad.default_uri_disabled != true && google_cloud_run_v2_service.tvad.iap_enabled != true
    error_message = "run.app の URL が無効か、IAP が有効になっている"
  }
  assert {
    condition     = length(google_cloud_run_v2_service.tvad.traffic) == 1 && google_cloud_run_v2_service.tvad.traffic[0].type == "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST" && google_cloud_run_v2_service.tvad.traffic[0].percent == 100
    error_message = "traffic が最新のリビジョンに 100% の 1 件でない"
  }

  # AC 3.2 instance-based billing・CPU 1・メモリ 512Mi
  assert {
    condition     = google_cloud_run_v2_service.tvad.template[0].containers[0].resources[0].cpu_idle == false
    error_message = "cpu_idle が false でない（instance-based billing でない）"
  }
  assert {
    condition     = google_cloud_run_v2_service.tvad.template[0].containers[0].resources[0].limits["memory"] == "512Mi" && google_cloud_run_v2_service.tvad.template[0].containers[0].resources[0].limits["cpu"] == "1"
    error_message = "メモリが 512Mi でないか、CPU が 1 でない"
  }

  # AC 3.3 スケール
  assert {
    condition     = google_cloud_run_v2_service.tvad.template[0].scaling[0].min_instance_count == 0 && google_cloud_run_v2_service.tvad.template[0].scaling[0].max_instance_count == 2
    error_message = "最小が 0 でないか、最大が既定の 2 でない"
  }

  # AC 3.4 実行用 SA
  assert {
    condition     = google_cloud_run_v2_service.tvad.template[0].service_account == "sa-tvad-run@example-project.iam.gserviceaccount.com"
    error_message = "実行用 SA が sa-tvad-run でない"
  }

  # AC 3.5 環境変数は Secret Manager の参照だけ（平文の value なし。PORT・CONFIG_PATH なし）
  assert {
    condition     = length(google_cloud_run_v2_service.tvad.template[0].containers[0].env) == 3 && toset([for e in google_cloud_run_v2_service.tvad.template[0].containers[0].env : e.name]) == toset(["WEBHOOK_SECRET", "LINE_CHANNEL_ACCESS_TOKEN", "LINE_TO"])
    error_message = "環境変数の名前の集合が WEBHOOK_SECRET・LINE_CHANNEL_ACCESS_TOKEN・LINE_TO ちょうどでない"
  }
  assert {
    condition = { for e in google_cloud_run_v2_service.tvad.template[0].containers[0].env : e.name => e.value_source[0].secret_key_ref[0].secret } == {
      WEBHOOK_SECRET            = "tvad-webhook-secret"
      LINE_CHANNEL_ACCESS_TOKEN = "tvad-line-channel-access-token"
      LINE_TO                   = "tvad-line-to"
    }
    error_message = "環境変数とシークレットの対応が違う"
  }
  assert {
    condition     = alltrue([for e in google_cloud_run_v2_service.tvad.template[0].containers[0].env : e.value_source[0].secret_key_ref[0].version == "latest"])
    error_message = "シークレットの版が既定の latest でない"
  }
  assert {
    condition     = alltrue([for e in google_cloud_run_v2_service.tvad.template[0].containers[0].env : e.value == null])
    error_message = "平文の value を持つ環境変数がある"
  }

  assert {
    condition     = length(google_cloud_run_v2_service.tvad.template[0].containers) == 1 && google_cloud_run_v2_service.tvad.template[0].containers[0].image == var.image
    error_message = "コンテナが 1 つでないか、イメージが変数の値でない"
  }
}

run "secret_version_pinned" {
  command = apply

  variables {
    secret_version = "3"
  }

  # AC 3.5 版の変数
  assert {
    condition     = alltrue([for e in google_cloud_run_v2_service.tvad.template[0].containers[0].env : e.value_source[0].secret_key_ref[0].version == "3"])
    error_message = "シークレットの版が変数の 3 でない"
  }
}

# plan はタグの参照を許す（イメージがまだ無い初回の plan。apply の digest の強制は deploy.yml）
run "image_tag_for_plan" {
  command = plan

  variables {
    image = "asia-northeast1-docker.pkg.dev/example-project/tvad/dispatcher:src-00000000000000000000"
  }

  assert {
    condition     = google_cloud_run_v2_service.tvad.template[0].containers[0].image == "asia-northeast1-docker.pkg.dev/example-project/tvad/dispatcher:src-00000000000000000000"
    error_message = "タグの参照のイメージが渡らない"
  }
}

run "max_custom" {
  command = plan

  variables {
    max_instance_count = 5
  }

  assert {
    condition     = google_cloud_run_v2_service.tvad.template[0].scaling[0].max_instance_count == 5
    error_message = "最大インスタンス数の変数が渡らない"
  }
}

# AC 3.3 最大インスタンス数の範囲外
run "max_zero" {
  command = plan
  variables {
    max_instance_count = 0
  }
  expect_failures = [var.max_instance_count]
}

run "max_too_large" {
  command = plan
  variables {
    max_instance_count = 6
  }
  expect_failures = [var.max_instance_count]
}

run "max_fraction" {
  command = plan
  variables {
    max_instance_count = 1.5
  }
  expect_failures = [var.max_instance_count]
}

# AC 3.6 Artifact Registry の tvad 以外のイメージを拒む
run "image_other_registry" {
  command = plan
  variables {
    image = "docker.io/library/node:24"
  }
  expect_failures = [var.image]
}

run "image_empty" {
  command = plan
  variables {
    image = ""
  }
  expect_failures = [var.image]
}

run "image_other_project" {
  command = plan
  variables {
    image = "asia-northeast1-docker.pkg.dev/other-project/tvad/dispatcher@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
  expect_failures = [var.image]
}

run "image_other_repository" {
  command = plan
  variables {
    image = "asia-northeast1-docker.pkg.dev/example-project/other/dispatcher@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
  expect_failures = [var.image]
}

run "image_other_name" {
  command = plan
  variables {
    image = "asia-northeast1-docker.pkg.dev/example-project/tvad/other@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
  expect_failures = [var.image]
}

run "image_latest_tag" {
  command = plan
  variables {
    image = "asia-northeast1-docker.pkg.dev/example-project/tvad/dispatcher:latest"
  }
  expect_failures = [var.image]
}

run "image_short_digest" {
  command = plan
  variables {
    image = "asia-northeast1-docker.pkg.dev/example-project/tvad/dispatcher@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
  expect_failures = [var.image]
}

# シークレットの版は latest か正の整数だけ
run "secret_version_zero" {
  command = plan
  variables {
    secret_version = "0"
  }
  expect_failures = [var.secret_version]
}

run "secret_version_name" {
  command = plan
  variables {
    secret_version = "v1"
  }
  expect_failures = [var.secret_version]
}

run "secret_version_empty" {
  command = plan
  variables {
    secret_version = ""
  }
  expect_failures = [var.secret_version]
}

run "project_id_shape" {
  command = plan
  variables {
    project_id = "Example_Project"
    image      = "asia-northeast1-docker.pkg.dev/Example_Project/tvad/dispatcher@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }
  expect_failures = [var.project_id]
}
