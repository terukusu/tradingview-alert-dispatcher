# infra/bootstrap の構成のテスト（資格情報なし。モックのプロバイダで apply する）。
# 値はすべて架空（example-project・example-owner/example-repo・数値 ID 123 / 456）。
# 番号は 10 桁未満にする（repo-values-check の projects/<番号> の検査に当たらないように）

mock_provider "google" {}

variables {
  project_id           = "example-project"
  github_repository    = "example-owner/example-repo"
  github_repository_id = "123"
  github_owner_id      = "456"
}

override_resource {
  target = google_service_account.run
  values = {
    email  = "sa-tvad-run@example-project.iam.gserviceaccount.com"
    member = "serviceAccount:sa-tvad-run@example-project.iam.gserviceaccount.com"
    name   = "projects/example-project/serviceAccounts/sa-tvad-run@example-project.iam.gserviceaccount.com"
  }
}

override_resource {
  target = google_service_account.tf_apply
  values = {
    email  = "sa-tvad-tf-apply@example-project.iam.gserviceaccount.com"
    member = "serviceAccount:sa-tvad-tf-apply@example-project.iam.gserviceaccount.com"
    name   = "projects/example-project/serviceAccounts/sa-tvad-tf-apply@example-project.iam.gserviceaccount.com"
  }
}

override_resource {
  target = google_service_account.tf_plan
  values = {
    email  = "sa-tvad-tf-plan@example-project.iam.gserviceaccount.com"
    member = "serviceAccount:sa-tvad-tf-plan@example-project.iam.gserviceaccount.com"
    name   = "projects/example-project/serviceAccounts/sa-tvad-tf-plan@example-project.iam.gserviceaccount.com"
  }
}

override_resource {
  target = google_iam_workload_identity_pool.github
  values = {
    name = "projects/000/locations/global/workloadIdentityPools/tvad-github"
  }
}

# imports.tf の取り込み先（モックのプロバイダは import できないので上書きで与える）
override_resource {
  target = google_storage_bucket.tfstate["bootstrap"]
  values = {}
}

run "defaults" {
  command = apply

  # AC 3.1 WIF のプロバイダはこのリポジトリとオーナーの数値 ID の両方で固定。
  # 多層防御: Environment prod のトークン（sub の末尾が :environment:prod）は ref が main のときだけ
  assert {
    condition     = google_iam_workload_identity_pool_provider.github.attribute_condition == "assertion.repository_id == '123' && assertion.repository_owner_id == '456' && (!assertion.sub.endsWith(':environment:prod') || assertion.ref == 'refs/heads/main')"
    error_message = "attribute_condition がリポジトリ ID・オーナー ID・Environment prod は main だけ、の && でない"
  }
  assert {
    condition     = google_iam_workload_identity_pool_provider.github.attribute_mapping["attribute.ref"] == "assertion.ref" && google_iam_workload_identity_pool_provider.github.attribute_mapping["google.subject"] == "assertion.sub"
    error_message = "条件で使う ref・sub の属性の対応づけが無い"
  }
  assert {
    condition     = google_iam_workload_identity_pool_provider.github.deletion_policy == "PREVENT"
    error_message = "WIF のプロバイダが PREVENT でない"
  }
  assert {
    condition     = google_iam_workload_identity_pool_provider.github.oidc[0].issuer_uri == "https://token.actions.githubusercontent.com"
    error_message = "issuer が GitHub Actions の OIDC でない"
  }
  assert {
    condition     = google_iam_workload_identity_pool.github.workload_identity_pool_id == "tvad-github" && google_iam_workload_identity_pool.github.deletion_policy == "PREVENT"
    error_message = "プールの ID か deletion_policy が違う"
  }

  # AC 3.2 apply SA の借用は Environment prod の subject 1 件（不変 ID 入りの形式）
  assert {
    condition     = google_service_account_iam_member.tf_apply_wif.role == "roles/iam.workloadIdentityUser" && google_service_account_iam_member.tf_apply_wif.service_account_id == google_service_account.tf_apply.name
    error_message = "apply SA の借用の role か対象の SA が違う"
  }
  assert {
    condition     = startswith(google_service_account_iam_member.tf_apply_wif.member, "principal://iam.googleapis.com/") && endswith(google_service_account_iam_member.tf_apply_wif.member, "/subject/repo:example-owner@456/example-repo@123:environment:prod")
    error_message = "apply SA の借用の member が Environment prod の subject 1 件でない"
  }

  # AC 3.3 plan SA の借用はこのリポジトリ（数値 ID）
  assert {
    condition     = google_service_account_iam_member.tf_plan_wif.role == "roles/iam.workloadIdentityUser" && google_service_account_iam_member.tf_plan_wif.service_account_id == google_service_account.tf_plan.name
    error_message = "plan SA の借用の role か対象の SA が違う"
  }
  assert {
    condition     = startswith(google_service_account_iam_member.tf_plan_wif.member, "principalSet://") && endswith(google_service_account_iam_member.tf_plan_wif.member, "/attribute.repository_id/123")
    error_message = "plan SA の借用の member がリポジトリ ID の principalSet でない"
  }

  # AC 3.4 シークレットは 3 つ、複製は asia-northeast1 の 1 つ、accessor は実行用 SA だけ
  assert {
    condition     = join(",", sort([for s in google_secret_manager_secret.this : s.secret_id])) == "tvad-line-channel-access-token,tvad-line-to,tvad-webhook-secret"
    error_message = "シークレットが 3 つ（WEBHOOK_SECRET・LINE_CHANNEL_ACCESS_TOKEN・LINE_TO 用）でない"
  }
  assert {
    condition = alltrue([for s in google_secret_manager_secret.this :
      length(s.replication[0].user_managed[0].replicas) == 1 &&
      one(s.replication[0].user_managed[0].replicas).location == "asia-northeast1" &&
      s.deletion_policy == "PREVENT"
    ])
    error_message = "シークレットの複製先が asia-northeast1 の 1 つでないか、PREVENT でない"
  }
  assert {
    condition = length(google_secret_manager_secret_iam_member.run_accessor) == 3 && alltrue([for k, m in google_secret_manager_secret_iam_member.run_accessor :
      m.role == "roles/secretmanager.secretAccessor" &&
      m.member == google_service_account.run.member &&
      m.secret_id == google_secret_manager_secret.this[k].secret_id
    ])
    error_message = "secretAccessor が各シークレットの実行用 SA の 1 件ずつでない"
  }
  assert {
    condition = alltrue([for m in google_secret_manager_secret_iam_member.run_accessor :
      !contains([google_service_account.tf_apply.member, google_service_account.tf_plan.member, "allUsers", "allAuthenticatedUsers"], m.member)
    ])
    error_message = "secretAccessor に apply SA・plan SA・公開の member がある"
  }

  # AC 3.5 プロジェクト単位の付与は apply SA の run.admin（条件なし）と plan SA の run.viewer の 2 件だけ
  assert {
    condition     = length(google_project_iam_member.ci) == 2
    error_message = "プロジェクト単位の付与が 2 件でない"
  }
  assert {
    condition = (
      google_project_iam_member.ci["apply_run_admin"].role == "roles/run.admin" &&
      google_project_iam_member.ci["apply_run_admin"].member == google_service_account.tf_apply.member &&
      length(google_project_iam_member.ci["apply_run_admin"].condition) == 0
    )
    error_message = "apply SA のプロジェクト単位の run.admin（条件なし）が無い"
  }
  assert {
    condition = (
      google_project_iam_member.ci["plan_run_viewer"].role == "roles/run.viewer" &&
      google_project_iam_member.ci["plan_run_viewer"].member == google_service_account.tf_plan.member
    )
    error_message = "plan SA のプロジェクト単位の run.viewer が無い"
  }
  assert {
    condition     = alltrue([for m in google_project_iam_member.ci : m.member != google_service_account.run.member && m.project == "example-project"])
    error_message = "実行用 SA にプロジェクト単位の付与がある"
  }

  # AC 3.6 apply SA の serviceAccountUser は実行用 SA 単位の 1 件
  assert {
    condition = (
      google_service_account_iam_member.tf_apply_act_as_run.role == "roles/iam.serviceAccountUser" &&
      google_service_account_iam_member.tf_apply_act_as_run.service_account_id == google_service_account.run.name &&
      google_service_account_iam_member.tf_apply_act_as_run.member == google_service_account.tf_apply.member
    )
    error_message = "apply SA の serviceAccountUser が実行用 SA 単位でない"
  }

  # AC 3.7 Artifact Registry とリポジトリ単位の writer / reader
  assert {
    condition = (
      google_artifact_registry_repository.tvad.repository_id == "tvad" &&
      google_artifact_registry_repository.tvad.format == "DOCKER" &&
      google_artifact_registry_repository.tvad.location == "asia-northeast1" &&
      google_artifact_registry_repository.tvad.docker_config[0].immutable_tags &&
      google_artifact_registry_repository.tvad.deletion_policy == "PREVENT"
    )
    error_message = "Artifact Registry が DOCKER・asia-northeast1・不変タグ・PREVENT でない"
  }
  assert {
    condition = (
      google_artifact_registry_repository_iam_member.apply_writer.role == "roles/artifactregistry.writer" &&
      google_artifact_registry_repository_iam_member.apply_writer.member == google_service_account.tf_apply.member &&
      google_artifact_registry_repository_iam_member.apply_writer.repository == "tvad" &&
      google_artifact_registry_repository_iam_member.plan_reader.role == "roles/artifactregistry.reader" &&
      google_artifact_registry_repository_iam_member.plan_reader.member == google_service_account.tf_plan.member &&
      google_artifact_registry_repository_iam_member.plan_reader.repository == "tvad"
    )
    error_message = "Artifact Registry の writer / reader がリポジトリ単位の apply SA / plan SA でない"
  }

  # AC 3.8 tfstate のバケット 2 つと prod 用だけの付与
  assert {
    condition = (
      google_storage_bucket.tfstate["prod"].name == "example-project-tvad-tfstate" &&
      google_storage_bucket.tfstate["bootstrap"].name == "example-project-tvad-tfstate-bootstrap"
    )
    error_message = "tfstate のバケット名が違う"
  }
  assert {
    condition = alltrue([for b in google_storage_bucket.tfstate :
      b.uniform_bucket_level_access &&
      b.public_access_prevention == "enforced" &&
      b.versioning[0].enabled &&
      b.location == "ASIA-NORTHEAST1" &&
      !b.force_destroy &&
      b.deletion_policy == "PREVENT"
    ])
    error_message = "tfstate のバケットが UBLA・公開アクセスの防止 enforced・バージョニング・PREVENT でない"
  }
  assert {
    condition     = length(google_storage_bucket_iam_member.prod_state) == 2 && alltrue([for m in google_storage_bucket_iam_member.prod_state : m.bucket == google_storage_bucket.tfstate["prod"].name])
    error_message = "tfstate の付与が prod 用のバケットの 2 件だけでない（bootstrap 用に付与がある）"
  }
  assert {
    condition = (
      google_storage_bucket_iam_member.prod_state["apply"].role == "roles/storage.objectUser" &&
      google_storage_bucket_iam_member.prod_state["apply"].member == google_service_account.tf_apply.member &&
      google_storage_bucket_iam_member.prod_state["plan"].role == "roles/storage.objectViewer" &&
      google_storage_bucket_iam_member.prod_state["plan"].member == google_service_account.tf_plan.member
    )
    error_message = "prod の state の付与が apply = objectUser・plan = objectViewer でない"
  }

  # SA は 3 つ、どれも PREVENT
  assert {
    condition = (
      google_service_account.run.account_id == "sa-tvad-run" &&
      google_service_account.tf_apply.account_id == "sa-tvad-tf-apply" &&
      google_service_account.tf_plan.account_id == "sa-tvad-tf-plan" &&
      alltrue([for sa in [google_service_account.run, google_service_account.tf_apply, google_service_account.tf_plan] : sa.deletion_policy == "PREVENT"])
    )
    error_message = "SA の ID か deletion_policy が違う"
  }

  # 出力（#4 が GitHub の variables / secrets に渡す）
  assert {
    condition     = output.artifact_registry_repository == "asia-northeast1-docker.pkg.dev/example-project/tvad" && output.tf_state_bucket == "example-project-tvad-tfstate"
    error_message = "出力の Artifact Registry のパスか state のバケットが違う"
  }
  assert {
    condition     = output.sa_run_email == "sa-tvad-run@example-project.iam.gserviceaccount.com" && length(output.secret_ids) == 3
    error_message = "出力の SA のメールかシークレット ID が違う"
  }
}

# AC 3.2 従来の sub の形式（不変 ID なし）
run "legacy_subject" {
  command = apply

  variables {
    github_oidc_immutable_subject = false
  }

  assert {
    condition     = startswith(google_service_account_iam_member.tf_apply_wif.member, "principal://iam.googleapis.com/") && endswith(google_service_account_iam_member.tf_apply_wif.member, "/subject/repo:example-owner/example-repo:environment:prod")
    error_message = "従来の形式の subject になっていない"
  }
  # sub の末尾 :environment:prod はどちらの形式でも同じなので、プロバイダの条件は変わらない
  assert {
    condition     = endswith(google_iam_workload_identity_pool_provider.github.attribute_condition, "(!assertion.sub.endsWith(':environment:prod') || assertion.ref == 'refs/heads/main')")
    error_message = "従来の形式でプロバイダの Environment prod の条件が無い"
  }
}

# AC 3.9 変数の検証
run "reject_non_numeric_repository_id" {
  command = plan

  variables {
    github_repository_id = "12a"
  }

  expect_failures = [var.github_repository_id]
}

run "reject_non_numeric_owner_id" {
  command = plan

  variables {
    github_owner_id = "owner"
  }

  expect_failures = [var.github_owner_id]
}

run "reject_repository_without_owner" {
  command = plan

  variables {
    github_repository = "example-repo"
  }

  expect_failures = [var.github_repository]
}
