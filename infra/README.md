# infra

本番（GCP の Cloud Run）の Terraform。設計は `docs/design.md`「GCP の構成」「シークレットの置き場」。

| ルート | 中身 | apply する人 | state の場所 |
|---|---|---|---|
| `infra/bootstrap` | WIF のプール・プロバイダ、SA 3 つ（実行用・CI の apply 用・CI の plan 用）と付与、Artifact Registry、tfstate のバケット 2 つ、Secret Manager の入れ物 3 つ、`_Default` シンクへのログの除外 1 つ（`logging.tf`） | **所有者が手元で 1 回**（IAM を変えるので CI には apply させない） | `<PROJECT_ID>-tvad-tfstate-bootstrap`（prefix `bootstrap`） |
| `infra/prod` | Cloud Run のサービス `tvad` 1 つ（IAM のリソース・data source なし） | CI（`.github/workflows/deploy.yml`。GitHub の Environment `prod` の承認の後） | `<PROJECT_ID>-tvad-tfstate`（prefix `prod`） |

- IAM の付与は追加型（`*_iam_member`）だけ。`*_iam_policy` / `*_iam_binding` は使わない（同じプロジェクトの既存の付与を書き換えない）
- API は有効化しない（API の有効化のリソースを書かない。有効化済み = `docs/design.md`「API の有効化」）
- シークレットの版（値）は Terraform に書かない（state・plan に値が入らない）。値は所有者が下の手順で入れる
- プロジェクト ID・リポジトリ名・GitHub の数値 ID・SA のメール・URL をリポジトリ・Issue・PR に書かない。**state・plan の全文を Issue / PR に貼らない**（SA のメール・プロジェクト ID が入る）。記録は件数と一致だけ
- `*.tfstate`・`*.tfplan`・`*.tfvars`・`.terraform/` は gitignore。`.terraform.lock.hcl` はコミットする

## 資格情報なしの検証（CI の `check` と同じ）

```bash
terraform fmt -check -recursive infra
terraform -chdir=infra/bootstrap init -backend=false -input=false
terraform -chdir=infra/bootstrap validate
terraform -chdir=infra/bootstrap test   # モックのプロバイダ。値はすべて架空
.github/scripts/tf-iam-decl-check.sh      # IAM のリソースの宣言（種類と名前）が決めた 8 件、ログの設定（google_logging_*）が除外 1 件と同じか
terraform -chdir=infra/prod init -backend=false -input=false
terraform -chdir=infra/prod validate
terraform -chdir=infra/prod test        # モックのプロバイダ。値はすべて架空
.github/scripts/tf-iam-decl-check.sh infra/prod   # prod は 0 件
.github/scripts/tf-iam-decl-check.test.sh         # 検査そのもののテスト
.github/scripts/log-mask.test.sh                  # Actions のログのマスクのテスト
```

`terraform test` の「付与は○件だけ」は、そのリソースの中の件数（for_each の数）しか見られない。別の名前・別の種類の IAM のリソースを足したことは `tf-iam-decl-check.sh` が宣言の一覧で検出する。実際のプロジェクトの IAM に増えたのが決めた付与だけであることは、apply の後の「6. 事後の確認」（プロジェクトの IAM の差分）で確かめる。

Terraform は 1.16.4（PATH に無ければ `mise exec terraform@1.16.4 -- terraform …`）。google プロバイダは `= 8.9.0` で固定（bootstrap と prod で揃える）。版を上げるときは両方のディレクトリで `terraform -chdir=infra/<dir> providers lock -platform=linux_amd64 -platform=darwin_arm64 -platform=darwin_amd64` で lock を作り直す。

## 共通の変数

値は環境変数で渡す（表示しない。`echo` しない）。`local.auto.tfvars.example` を `local.auto.tfvars` に写して `project_id`・`github_repository` を書いてもよい（gitignore）。

```bash
export TF_VAR_project_id="$(gcloud config get-value project)"
export TF_VAR_github_repository='<owner>/<repo>'
export TF_VAR_github_repository_id="$(gh api "repos/$TF_VAR_github_repository" --jq .id)"
export TF_VAR_github_owner_id="$(gh api "repos/$TF_VAR_github_repository" --jq .owner.id)"
# GitHub の OIDC の sub が不変 ID 入りの形式か（true なら既定のまま。false なら TF_VAR_github_oidc_immutable_subject=false）
gh api "repos/$TF_VAR_github_repository/actions/oidc/customization/sub" --jq .use_immutable_subject
```

ADC（`gcloud auth application-default login`）が無いときは、gcloud のログインのトークンを環境変数で渡して init / plan / apply / output を通す（表示しない。約 1 時間で切れるので、切れたら同じ行で取り直す）:

```bash
export GOOGLE_OAUTH_ACCESS_TOKEN="$(gcloud auth print-access-token)"
```

必要な API が有効か（8 なら OK）:

```bash
gcloud services list --enabled --format='value(config.name)' \
  | grep -cxE '(iam|iamcredentials|sts|artifactregistry|secretmanager|run|cloudresourcemanager|storage-api)\.googleapis\.com'
```

（storage は `storage-api.googleapis.com` の名前で有効になっている。2026-11-10 の #3 の apply で確認）

## bootstrap の apply（所有者の手順）

本番の IAM を変える操作。実施はユーザーの明示承認の後（`CLAUDE.md`）。`google_project_iam_member` はプロジェクトの IAM ポリシーを読んで書くので、**同じプロジェクトの別の bootstrap の apply と同時に走らせない**。

### 0. 前提: GitHub の Environment `prod` の保護（apply より前）

apply SA を借りられるのは sub が `…:environment:prod` のトークン（Environment `prod` を参照する job）だけ。ただし **sub はブランチを含まない**。ブランチと承認の制限は Environment `prod` の保護ルールが担う。GitHub は、job が存在しない Environment を参照すると、その名前の Environment を **保護ルールなしで自動作成する**。保護の前に apply すると、リポジトリに push できる者が任意のブランチに `environment: prod` の job を置くだけで apply SA を借りられる。このため、**bootstrap の apply の前に** 所有者が次を設定し、読み取りで確かめる（GitHub の設定の変更なので、所有者の明示承認の後に行う）:

| 項目 | 値 |
|---|---|
| Environment | `prod` |
| Required reviewers | 所有者（1 人。所有者が自分で承認できるように Prevent self-review は付けない） |
| Deployment branches and tags | Selected branches and tags → `main`（ブランチ）だけ |
| Allow administrators to bypass configured protection rules | 付けない |

設定は Settings → Environments か API で行う。API なら `gh api -X PUT repos/<owner>/<repo>/environments/prod` の本文に承認者・`deployment_branch_policy` と `can_admins_bypass: false` を渡し（管理者の bypass もこれで外せた。2026-11-10 の #3 で確認）、ブランチは `POST …/environments/prod/deployment-branch-policies` で足す。リポジトリは public（GitHub Free / Pro / Team で required reviewers が使えるのは public のリポジトリ）。

確認（読み取りだけ。出すのは真偽と件数で、名前・数値 ID は出さない。すべて `true` なら OK）:

```bash
E="repos/$TF_VAR_github_repository/environments/prod"
# 承認者が所有者 1 人・自己承認の禁止なし・ブランチはカスタムのポリシー
gh api "$E" --jq '
  [.protection_rules[] | select(.type == "required_reviewers")] as $r
  | ($r | length) == 1
    and ([$r[0].reviewers[] | select(.type == "User") | .reviewer.id | tostring] == [env.TF_VAR_github_owner_id])
    and ($r[0].reviewers | length) == 1
    and ($r[0].prevent_self_review | not)
    and (.deployment_branch_policy.custom_branch_policies == true)
    and (.deployment_branch_policy.protected_branches == false)'
# 許すのは main ブランチの 1 件だけ（タグは許さない）
gh api "$E/deployment-branch-policies" --jq '[.branch_policies[] | {name, type}] == [{name: "main", type: "branch"}]'
# 管理者の bypass が無効（true なら OK）
gh api "$E" --jq '.can_admins_bypass == false'
```

`false` か 404（Environment が無い）なら apply しない。多層防御として、WIF のプロバイダの条件でも Environment `prod` のトークンは `ref` が `refs/heads/main` のときだけ受け付ける（`wif.tf`。保護が外れても main 以外のブランチからは借りられない。ただし守るのはブランチの制限だけで、承認の欠落は守らないので、上の確認は省かない）。

### 1. 作業前の記録

比較の元をスクラッチのディレクトリに取る（リポジトリ・Issue・PR に貼らない。作業が終わったら消す）。

```bash
export W="$(mktemp -d)"
R=asia-northeast1
gcloud projects get-iam-policy "$TF_VAR_project_id" --format=json > "$W/project-iam.before.json"
# 既存の WIF のプールすべてのプロバイダの名前と条件
wif_snapshot() {
  for p in $(gcloud iam workload-identity-pools list --location=global --format='value(name.basename())'); do
    gcloud iam workload-identity-pools providers list --workload-identity-pool="$p" --location=global \
      --format='value(name,attributeCondition)'
  done | sort
}
wif_snapshot > "$W/wif.before.txt"
# 既存の Cloud Run サービスすべての最新のリビジョンと IAM
run_snapshot() {
  for s in $(gcloud run services list --region="$R" --format='value(metadata.name)'); do
    echo "== $s"
    gcloud run services describe "$s" --region="$R" --format='value(status.latestReadyRevisionName)'
    gcloud run services get-iam-policy "$s" --region="$R" --format=json
  done
}
run_snapshot > "$W/run.before.txt"
# _Default シンクの除外の名前と包含のフィルタ（logging.tf の除外の前後の比較）
gcloud logging sinks describe _Default --format=json | jq '{ex: [.exclusions[]?.name], filter}' > "$W/default-sink.before.json"
```

### 2. bootstrap 用のバケットを作る

state の置き場なので Terraform より先に作り、apply で `import` して管理下に入れる（`imports.tf`）。

```bash
B="${TF_VAR_project_id}-tvad-tfstate-bootstrap"
gcloud storage buckets create "gs://$B" --location=asia-northeast1 \
  --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets update "gs://$B" --versioning
```

### 3. init

```bash
cd infra/bootstrap
terraform init -input=false -backend-config="bucket=$B"
```

### 4. plan と要約の確認

```bash
terraform plan -input=false -out=bootstrap.tfplan
# アドレスと操作だけを出す（値は出さない）
terraform show -json bootstrap.tfplan \
  | jq -r '.resource_changes[] | [(.change.actions | join("+")), (if .change.importing then "import" else "-" end), .address] | @tsv'
terraform show -json bootstrap.tfplan \
  | jq -r '[.resource_changes[] | (.change.actions | join("+")) + (if .change.importing then " (import)" else "" end)] | group_by(.) | map("\(.[0]): \(length)") | .[]'
```

目安（初回）:

| 操作 | 件数 | 中身 |
|---|---|---|
| `create` | 23 | SA 3・プール 1・プロバイダ 1・SA の付与 3（借用 2・actAs 1）・プロジェクトの付与 2・バケット 1（prod）・バケットの付与 2・Artifact Registry 1・その付与 2・シークレット 3・その付与 3・ログの除外 1（`google_logging_project_exclusion.tvad_rejected`。#16 より前に apply した環境では、この 1 件だけの `create` になる = 下の「送信元 IP の許可リストとログの除外（#16）」） |
| import | 1 | `google_storage_bucket.tfstate["bootstrap"]`。操作は `no-op` か `update`（gcloud で作ったときに無い設定 = 古い世代の削除のルールや Terraform だけの属性 `deletion_policy`・`force_destroy` を合わせる差分）。`update` なら `terraform show bootstrap.tfplan` のこのリソースの差分がそれだけであることを見る |
| それ以外の `update`・`delete`・`replace` | 0 | 1 件でもあれば apply しない |

### 5. apply と差分 0 の確認

```bash
terraform apply bootstrap.tfplan
terraform plan -input=false -detailed-exitcode >/dev/null; echo "exit=$?"   # 0 なら差分なし
rm -f bootstrap.tfplan
```

WIF のプロバイダの作成が `attribute_condition` の評価のエラー（`endsWith` を受け付けない等）で失敗した場合は、続けずに止めて報告する（条件を緩めて通さない。拒否の側に倒れるだけで、既存のリソースは変わらない）。

### 6. 事後の確認（出力は件数と一致だけを記録する）

```bash
APPLY_SA="$(terraform output -raw sa_tf_apply_email)"
PLAN_SA="$(terraform output -raw sa_tf_plan_email)"
RUN_SA="$(terraform output -raw sa_run_email)"

# 新しいプロバイダがこのリポジトリの ID に固定され、Environment prod は main だけ（1 と 1）
gcloud iam workload-identity-pools providers describe github-actions --workload-identity-pool=tvad-github \
  --location=global --format='value(attributeCondition)' > "$W/cond.txt"
grep -c "'$TF_VAR_github_repository_id'" "$W/cond.txt"
grep -cF "(!assertion.sub.endsWith(':environment:prod') || assertion.ref == 'refs/heads/main')" "$W/cond.txt"
# 既存の WIF のプロバイダの名前と条件が変わっていない（diff が空）
wif_snapshot | grep -v '/workloadIdentityPools/tvad-github/' | diff "$W/wif.before.txt" - && echo same

# apply SA の借用が Environment prod の subject 1 件（true）
gcloud iam service-accounts get-iam-policy "$APPLY_SA" --format=json \
  | jq '[.bindings[] | select(.role == "roles/iam.workloadIdentityUser") | .members[]] | length == 1 and (.[0] | endswith(":environment:prod"))'

# プロジェクトの IAM: 消えた付与 0、増えたのは apply SA の run.admin と plan SA の run.viewer の 2 件だけ
gcloud projects get-iam-policy "$TF_VAR_project_id" --format=json > "$W/project-iam.after.json"
flat='[.bindings[] | .role as $r | .members[] | {role: $r, member: .}] | unique'
jq -n --argjson b "$(jq "$flat" "$W/project-iam.before.json")" --argjson a "$(jq "$flat" "$W/project-iam.after.json")" \
  --arg apply "serviceAccount:$APPLY_SA" --arg plan "serviceAccount:$PLAN_SA" '
  {removed: ($b - $a | length), added: ($a - $b | length),
   expected: (($a - $b) == ([{role: "roles/run.admin", member: $apply}, {role: "roles/run.viewer", member: $plan}] | unique))}'

# 既存の Cloud Run サービスのリビジョンと IAM が変わっていない（diff が空）
run_snapshot | diff "$W/run.before.txt" - && echo same

# シークレットの secretAccessor が実行用 SA の 1 件だけ（それぞれ true）
for s in tvad-webhook-secret tvad-line-channel-access-token tvad-line-to; do
  gcloud secrets get-iam-policy "$s" --format=json \
    | jq --arg m "serviceAccount:$RUN_SA" '[.bindings[]? | select(.role == "roles/secretmanager.secretAccessor") | .members[]] == [$m]'
done
# bootstrap 用バケットに CI の SA の付与が無い（0）
gcloud storage buckets get-iam-policy "gs://$B" --format=json \
  | jq --arg a "serviceAccount:$APPLY_SA" --arg p "serviceAccount:$PLAN_SA" '[.bindings[].members[] | select(. == $a or . == $p)] | length'
# _Default シンク: 増えた除外が tvad-rejected-requests の 1 件だけ・消えた除外 0・包含のフィルタが同じ（すべて true）
default_sink_check() {
  gcloud logging sinks describe _Default --format=json | jq --slurpfile b "$W/default-sink.before.json" '
    [.exclusions[]?.name] as $a | {
      added_only_tvad: (($a - $b[0].ex) == ["tvad-rejected-requests"]),
      removed_none: (($b[0].ex - $a) == []),
      filter_same: (.filter == $b[0].filter),
      enabled: ([.exclusions[]? | select(.name == "tvad-rejected-requests") | (.disabled // false)] == [false])}'
}
default_sink_check
```

終わったら `rm -rf "$W"`。

## シークレットの値の投入（所有者。#4 の前）

値は Terraform に持たせない。コンソールで入れるか、次のように **標準入力から** 入れる（値をコマンドラインの引数・シェルの履歴・ファイルに残さない。`read -rs` は入力を画面に出さない。末尾の改行は入らない）。

```bash
for s in tvad-webhook-secret tvad-line-channel-access-token tvad-line-to; do
  printf '%s の値: ' "$s"; IFS= read -rs V; echo
  printf '%s' "$V" | gcloud secrets versions add "$s" --data-file=-
  unset V
done
```

| シークレット | アプリの環境変数 |
|---|---|
| `tvad-webhook-secret` | `WEBHOOK_SECRET` |
| `tvad-line-channel-access-token` | `LINE_CHANNEL_ACCESS_TOKEN` |
| `tvad-line-to` | `LINE_TO` |

投入の確認は版の件数だけ（`access` で値を出さない）:

```bash
for s in tvad-webhook-secret tvad-line-channel-access-token tvad-line-to; do
  gcloud secrets versions list "$s" --filter='state=ENABLED' --format='value(name)' | wc -l
done
```

## apply SA のプロジェクト単位の `roles/run.admin`

Cloud Run は IAM の条件のリソース属性に対応していないので、サービス名で絞った付与はできない（条件をつけると何も許可されない）。`infra/prod` の `invoker_iam_disabled` には `run.services.setIamPolicy` が要るので `roles/run.developer` でも足りない。このため apply SA は同じプロジェクトの既存のサービスも変更できる。次で緩和する（`docs/design.md`「apply SA の Cloud Run の権限」）:

- apply SA を借りられるのは GitHub の Environment `prod` の job だけ。Environment `prod` は **bootstrap の apply より前に** main 限定・承認必須（所有者）・管理者の bypass なしに設定し、読み取りで確かめる（上の「0. 前提」。存在しない Environment を参照する job は保護なしの Environment を自動作成するので、「Environment が無いから借りられない」とは言えない）
- WIF のプロバイダの条件で、Environment `prod` のトークンは `ref` が `refs/heads/main` のときだけ受け付ける（Environment の保護が外れたときの 2 枚目）
- `deploy.yml` は承認の前に plan の要約（アドレスと操作）を出し、apply の直前の plan が承認した plan と同じ操作のときだけ apply する
- 上の事後の確認で、既存のサービスのリビジョンと IAM が変わっていないことを確かめる

## plan SA と prod の state

- plan SA の prod の state への付与は `roles/storage.objectViewer`（読み取り）だけ。gcs backend の plan は既定で state のロック（`.tflock` の作成）を取るので、**plan SA の plan（`deploy.yml` の plan job・`ci.yml` の `terraform-plan`）は `terraform plan -lock=false`**（付与は増やさない。plan は state を書かないので、ロックなしでも state は壊れない。apply は apply SA がロックを取る）
- plan SA はこのリポジトリのどのブランチ・イベントの job でも借りられる（読み取りだけ）。ワークフローで `pull_request_target` を使わない（fork の PR に OIDC のトークンを渡さない）。`ci.yml` の `terraform-plan` は同じリポジトリからの PR だけで動く
- plan SA の `roles/run.viewer`・`roles/artifactregistry.reader`・`objectViewer` で `infra/prod` の init・イメージの解決・plan が通るかは、#4 の PR の `terraform-plan` で確かめる（state もサービスも無い初回。サービスの読み取りは 2 回目以降の plan で確定する）。足りなければ付与を足さずに止めて諮る
- 不変 ID 入りの sub の形式（`iam.tf` の `apply_subject`）は #4 の最初の deploy（apply job）の認証で確かめる（違えば認証が拒否される = 安全側の失敗）

## bootstrap の切り戻し・撤去

- 付与だけを外す: 該当の `*_iam_member` を消して apply（追加型なので、ほかの付与は残る）
- ログの除外を外す: `logging.tf` のリソースを消す PR → 所有者の apply（`_Default` のほかの除外・包含のフィルタは変わらない。除外していた間のログは戻らない）。`gcloud logging sinks update _Default --remove-exclusions=…` は Terraform と食い違うので使わない
- 全体の撤去: 各リソースの `deletion_policy = "PREVENT"` とバケットの `prevent_destroy` を外してから `terraform destroy`。バケットとシークレットは中身を確かめてから手で消す。WIF のプールは削除後 30 日は同じ ID を作り直せない

## prod（Cloud Run）

`infra/prod` はサービス `tvad`（`google_cloud_run_v2_service`）1 つだけ。未認証で呼べる（`invoker_iam_disabled = true`、ingress `all`）、instance-based billing（`cpu_idle = false`、CPU 1、メモリ `512Mi`）、最小 0・最大 2（変数 `max_instance_count`。1〜5）、実行用 SA `sa-tvad-run`、環境変数 4 つ（Secret Manager の参照 3 つ（版は変数 `secret_version`、既定 `latest`）と平文の `ALLOWED_SOURCE_IPS` 1 つ（変数 `allowed_source_ips`、既定は TradingView の 4 つ。`[]` なら置かない = 制限なし））、`deletion_protection = true`、traffic は最新のリビジョンに 100%。IAM のリソース・data source・output を持たない（plan SA の読み取りの権限で plan できるように。URL を出力しない）。設計は `docs/design.md`。

本番を変えるのは `.github/workflows/deploy.yml` だけ（手作業の `gcloud run deploy` はしない）:

1. main への push ごとに **plan job**（plan SA）: イメージのタグ（`.github/scripts/image.sh tag` = イメージの入力のハッシュ `src-<20 桁>`）を求め、Artifact Registry にあれば digest、無ければタグの参照で `terraform plan -lock=false`。ジョブの要約に「アドレスと操作」・件数・タグだけを出す
2. 差分があれば **apply job**（`environment: prod`）が承認待ちになる。差分が無ければ apply job は動かない（承認待ちは出ない）
3. 承認の後: イメージが無ければ GCP の認証より前に `docker build` と `image-check.sh` → 認証（apply SA）→ push → digest を解決（`@sha256:` でなければ失敗）→ plan を取り直し、**承認した plan と「アドレスと操作」が同じときだけ** apply → apply の直後の plan が差分 0 でなければ失敗

ログ・要約には plan / apply の全文・プロジェクト ID・番号・SA のメール・URL を出さない（失敗時は `log-mask.sh filter` を通した末尾だけ）。plan ファイルは artifact にしない。

### GitHub の設定

所有者の明示承認の後に登録する（本番の設定の変更）。値は `infra/bootstrap` の出力から標準入力で渡す（引数・履歴・画面に出さない）。`infra/bootstrap` を `terraform init -input=false -backend-config="bucket=<PROJECT_ID>-tvad-tfstate-bootstrap"` したうえで（ADC が無ければ上の `GOOGLE_OAUTH_ACCESS_TOKEN`）:

| 種類 | 名前 | 値の出どころ |
|---|---|---|
| secret | `GCP_PROJECT_ID` | プロジェクト ID（secret にするのは、Actions のログで自動で伏せるため。それを含む SA のメール・バケット名・AR のパスも伏せられる） |
| secret | `GCP_WIF_PROVIDER` | 出力 `wif_provider_name`（プロジェクト番号を含む） |
| variable | `TF_STATE_BUCKET` | 出力 `tf_state_bucket` |
| variable | `GCP_SA_TF_PLAN` | 出力 `sa_tf_plan_email` |
| variable | `GCP_SA_TF_APPLY` | 出力 `sa_tf_apply_email` |

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
terraform -chdir=infra/bootstrap output -raw wif_provider_name | gh secret set GCP_WIF_PROVIDER --repo "$REPO"
printf '%s' "$TF_VAR_project_id"                               | gh secret set GCP_PROJECT_ID   --repo "$REPO"
terraform -chdir=infra/bootstrap output -raw tf_state_bucket   | gh variable set TF_STATE_BUCKET --repo "$REPO"
terraform -chdir=infra/bootstrap output -raw sa_tf_plan_email  | gh variable set GCP_SA_TF_PLAN  --repo "$REPO"
terraform -chdir=infra/bootstrap output -raw sa_tf_apply_email | gh variable set GCP_SA_TF_APPLY --repo "$REPO"
# 確認は名前だけ
gh variable list --repo "$REPO" --json name -q '[.[].name]|sort'   # ["GCP_SA_TF_APPLY","GCP_SA_TF_PLAN","TF_STATE_BUCKET"]
gh secret list   --repo "$REPO" --json name -q '[.[].name]|sort'   # ["GCP_PROJECT_ID","GCP_WIF_PROVIDER"]
```

どれかが未設定なら `deploy.yml` と `ci.yml` の `terraform-plan` は `::notice::` を出して何もしない（clone して使う人のリポジトリで main への push を失敗にしない）。Environment `prod` の保護は bootstrap の「0. 前提」のまま。

### 初回デプロイ

1. **作業前の記録**（マージの直前。比較の元）: bootstrap の「1. 作業前の記録」と同じく、スクラッチのディレクトリにプロジェクトの IAM ポリシーと `run_snapshot`（既存の Cloud Run サービスすべての最新のリビジョンと IAM）を取る（`project-iam.before.json`・`run.before.txt`）
2. **GitHub の設定**（上。所有者の承認の後）
   - **prod の state の初期化**（所有者、一度だけ。最初の PR の plan の前）: state が無いと `terraform init` が空の state とロックを書こうとし、読み取りだけの plan SA では `storage.objects.create` が 403 になる（2026-11-10 の #4 で確認）。所有者の手元で一度 init して空の state を作る（リソースは作らない。付与は足さない）:

     ```bash
     B=$(terraform -chdir=infra/bootstrap output -raw tf_state_bucket)
     terraform -chdir=infra/prod init -input=false -backend-config="bucket=$B"
     terraform -chdir=infra/prod state list | wc -l   # 0
     ```
3. **PR の plan**: PR の `ci.yml` の `terraform-plan` の要約が `create` 1 件（`google_cloud_run_v2_service.tvad`）だけであること。plan SA の権限不足で落ちたら、付与を足さずに止めて諮る
4. **マージ** → `deploy.yml` の plan job の要約が `create` 1 件・イメージ「未作成」であることを確かめる
5. **承認**: 所有者が Environment `prod` を承認する（画面の Review deployments）
6. **apply job**: ビルド・検査 → push → digest → 指紋の一致 → apply → 再 plan 差分 0。`gh run watch <run-id>` で追う
7. **事後の確認**（URL・ID・メール・番号は記録しない。件数・ステータス・真偽だけ）:

```bash
R=asia-northeast1
# 設定（すべて true）。jq のパスは gcloud run services describe（v1 の形）
gcloud run services describe tvad --region="$R" --format=json | jq '
  .spec.template.spec.containers[0] as $c | .spec.template.metadata.annotations as $a | {
    env4: (($c.env | length) == 4),
    secrets3: (([$c.env[] | select(.valueFrom.secretKeyRef != null and .value == null) | .name] | sort) == ["LINE_CHANNEL_ACCESS_TOKEN", "LINE_TO", "WEBHOOK_SECRET"]),
    allowed_source_ips: ([$c.env[] | select(.value != null) | {name, value}] == [{name: "ALLOWED_SOURCE_IPS", value: "52.89.214.238,34.212.75.30,54.218.53.128,52.32.178.7"}]),
    line_to: any($c.env[]; .name == "LINE_TO"),
    digest: ($c.image | contains("@sha256:")),
    invoker_iam_disabled: (.metadata.annotations["run.googleapis.com/invoker-iam-disabled"] == "true"),
    ingress_all: (.metadata.annotations["run.googleapis.com/ingress"] == "all"),
    cpu_always: ($a["run.googleapis.com/cpu-throttling"] == "false"),
    memory: ($c.resources.limits.memory == "512Mi"),
    min0: (($a["autoscaling.knative.dev/minScale"] // "0") == "0"),
    max2: ($a["autoscaling.knative.dev/maxScale"] == "2"),
    run_sa: (.spec.template.spec.serviceAccountName | startswith("sa-tvad-run@"))}'
URL=$(gcloud run services describe tvad --region="$R" --format='value(status.url)')   # 表示しない
curl -s -o /dev/null -w '%{http_code}\n' "$URL/health"                                  # 200
# TradingView 以外の送信元からなので、送信元 IP の許可リストで 403（allowed_source_ips = [] なら 401）
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$URL/webhook" -d '{"message":"test"}' # 403
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$URL/webhook" -d '{"secret":"not-the-secret","message":"test"}'  # 403
# 上の 2 回の時刻の範囲で dispatched が 0 件（forbidden は bootstrap のログの除外で保存されないので 0 件。
# 除外の前なら 2 件以上。allowed_source_ips = [] なら unauthorized が 2 件以上。正しいシークレットでの送信は下の「通し確認」）
for m in forbidden unauthorized dispatched; do
  gcloud logging read "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"tvad\" AND jsonPayload.msg=\"$m\"" \
    --freshness=15m --format='value(timestamp)' | wc -l
done
# プロジェクトの IAM の (role, member) の消えた件数・増えた件数がどちらも 0
gcloud projects get-iam-policy "$TF_VAR_project_id" --format=json > "$W/project-iam.after.json"
flat='[.bindings[] | .role as $r | .members[] | {role: $r, member: .}] | unique'
jq -n --argjson b "$(jq "$flat" "$W/project-iam.before.json")" --argjson a "$(jq "$flat" "$W/project-iam.after.json")" \
  '{removed: ($b - $a | length), added: ($a - $b | length)}'
# 新しいサービスの IAM の bindings が 0 件（allUsers が無い）
gcloud run services get-iam-policy tvad --region="$R" --format=json | jq '.bindings // [] | length'
# 既存のサービスの最新のリビジョンと IAM が変わっていない（tvad を除いて diff が空）
run_snapshot | awk '/^== /{skip = ($2 == "tvad")} !skip' | diff "$W/run.before.txt" - && echo same
```

あわせて、次の `deploy.yml` の run（ドキュメントだけの変更のマージか、所有者の承認の後の `workflow_dispatch`）で plan job が「差分なし」・apply job が動かない（承認待ちが出ない）ことを確かめる。終わったら `rm -rf "$W"`。

初回の apply が途中で失敗した場合（例: シークレットを解決できずリビジョンが Ready にならない）、サービスが tainted で state に残り、`deletion_protection = true` のため作り直し（replace）も止まる。原因を直して同じ経路で再 apply する（`terraform untaint` が要るなら所有者の手元で、承認の後）。

### 通し確認

本番を変えずに、TradingView → dispatcher → LINE が通ること、コールドスタートを含めて応答が 3 秒（TradingView の打ち切り）に間に合うことを確かめる（以後の再測定にも使う。2026-11-10 の結果は `docs/design.md`「最小インスタンス数」）。URL・シークレット・トークンは変数にだけ入れて表示しない。記録は件数・ステータス・秒数だけ（URL・インスタンス ID・ログの全文を Issue / PR に貼らない）。

**A. 応答時間と件数（LINE に送らない）**: `channels` に設定に無い ID だけを指定すると、dispatcher は送らずに `ok: false`・`error: "未知のチャネル"` の結果を 1 件だけ持つ `msg=dispatched` を出す（`src/dispatcher.ts`）。結果が `ok: false` なので、この `dispatched` は severity ERROR で出る（想定どおり）。

```bash
R=asia-northeast1
F='resource.type="cloud_run_revision" AND resource.labels.service_name="tvad"'
REQ="$F AND logName:\"run.googleapis.com%2Frequests\""
# 1. 前の 20 分のリクエストが 0 件（アイドルのインスタンスは最長 15 分で止まるので、次の 1 回目がコールドスタートになる）
gcloud logging read "$REQ" --freshness=20m --format='value(timestamp)' | wc -l
# 2. LINE の今月の送信数（前）。README.md「LINE の無料枠」と同じ
T=$(gcloud secrets versions access latest --secret=tvad-line-channel-access-token)
printf 'Authorization: Bearer %s' "$T" | curl -s -H @- https://api.line.me/v2/bot/message/quota/consumption; echo
# 3. 10 回（1 秒間隔で順に）。シークレットは本文の secret で渡す（?key= はリクエストログに残るので使わない）
URL=$(gcloud run services describe tvad --region="$R" --format='value(status.url)')
export PROBE_SECRET=$(gcloud secrets versions access latest --secret=tvad-webhook-secret)
START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
for i in $(seq 10); do
  jq -nc '{secret: env.PROBE_SECRET, message: "probe", channels: ["probe-nonexistent"]}' \
    | curl -s -o /dev/null -w "$i %{http_code} %{time_total}\n" -X POST "$URL/webhook" -H 'Content-Type: application/json' --data-binary @-
  sleep 1
done
unset PROBE_SECRET URL
sleep 60   # ログの取り込みを待つ
# 4. リクエストログ: 10 件・すべて 200・httpRequest.latency の最大と最小（秒）
gcloud logging read "$REQ AND httpRequest.requestMethod=\"POST\" AND timestamp>=\"$START\"" --format=json \
  | jq '[.[].httpRequest] | {n: length, all200: all(.[]; .status == 200), latency: ([.[].latency | rtrimstr("s") | tonumber] | {max: max, min: min})}'
# 5. dispatched が 10 件で、どれも probe-nonexistent の ok: false・未知のチャネルの 1 件だけ
gcloud logging read "$F AND jsonPayload.msg=\"dispatched\" AND timestamp>=\"$START\"" --format=json \
  | jq '{n: length, probe_only: all(.[]; [.jsonPayload.results[] | [.channel, .ok, .error]] == [["probe-nonexistent", false, "未知のチャネル"]])}'
# 6. コールドスタート: 新しいインスタンスの listening が 1 件以上（システムログ varlog/system の「Starting new instance」でも分かる）
gcloud logging read "$F AND jsonPayload.msg=\"listening\" AND timestamp>=\"$START\"" --format='value(timestamp)' | wc -l
# 7. dispatched 以外の ERROR が 0 件
gcloud logging read "$F AND severity>=ERROR AND NOT jsonPayload.msg=\"dispatched\" AND timestamp>=\"$START\"" --format='value(timestamp)' | wc -l
# 8. LINE の今月の送信数（後）。2. と同じ = LINE に送っていない
printf 'Authorization: Bearer %s' "$T" | curl -s -H @- https://api.line.me/v2/bot/message/quota/consumption; echo
unset T
```

合格: 3. の 10 回がすべて `200` かつ `time_total` < 3.0 秒、4. が `n: 10`・`all200: true`・`latency.max` < 3、5. が `n: 10`・`probe_only: true`、6. が 1 以上、7. が 0、2. と 8. の `totalUsage` が同じ。curl の `time_total` は測る場所から asia-northeast1 までの往復を含み、TradingView の送信元とは経路が違う。`httpRequest.latency` がコールドスタートの起動待ちを含むかは公式ドキュメントに記載が無い（未確認）ので、両方で判定する。どれかが 3 秒以上なら、最小インスタンス数を 1 にするかをオーナーに諮る（`docs/design.md`「最小インスタンス数」。変えるなら `infra/prod` の PR）。

**B. 実際の送達（LINE に 1 通）**: 所有者が README.md「TradingView のアラートの設定」の手順でテストのアラートを 1 件作り（本文は架空の内容）、1 回発火させる。TradingView の「アラートのログ」の Webhook status が成功、LINE に 1 通届く、その時刻の `jsonPayload.msg="dispatched"` が 1 件で `results` の全チャネルが `ok: true`、`quota/consumption` の `totalUsage` が +1 を確かめる。終わったらテストのアラートを消す。応答の後の送信が CPU の割り当てで止まらない（instance-based billing）ことは、A ではなくこの 1 通で確かめる（A は応答の後に通信しない）。

### 送信元 IP の許可リストとログの除外（#16）

`infra/prod` の `allowed_source_ips`（既定は TradingView の 4 つ）と `infra/bootstrap/logging.tf`（`_Default` シンクへの除外 1 つ）を、すでに動いている本番に入れる手順（設計は `docs/design.md`「送信元 IP の許可リスト」「弾いたリクエストのログ」）。**アプリを先に反映して A・D を確かめ、その後に bootstrap の除外を apply して C・B を確かめる**（D が 403 のとき、まだ除外していないリクエストログで原因を調べられるように）。URL・シークレットは変数にだけ入れて表示しない。記録は件数・ステータス・真偽だけ。

1. PR の `ci.yml` の `terraform-plan` の要約が `update` 1 件（`google_cloud_run_v2_service.tvad`）だけ → マージ
2. `deploy.yml` の plan が `update` 1 件 → **Environment `prod` の承認**（ユーザーの明示承認）→ ビルド・push・apply・再 plan 差分 0
3. **A**（手元 = TradingView の 4 つ以外の IP から。シークレットは送らない）:

   ```bash
   R=asia-northeast1
   URL=$(gcloud run services describe tvad --region="$R" --format='value(status.url)')   # 表示しない
   curl -s -o /dev/null -w '%{http_code}\n' -X POST "$URL/webhook" -d '{"message":"test"}'                                   # 403
   curl -s -o /dev/null -w '%{http_code}\n' -X POST "$URL/webhook" -H 'X-Forwarded-For: 52.89.214.238' -d '{"message":"test"}' # 403（先頭の偽装が効かない）
   curl -s -o /dev/null -w '%{http_code}\n' -X POST "$URL/webhook" -H 'X-Forwarded-For: 203.0.113.9' -H 'X-Forwarded-For: 52.89.214.238' -d '{"message":"test"}' # 403（2 行のヘッダは拒否）
   curl -s -o /dev/null -w '%{http_code}\n' "$URL/health"                                                                     # 200
   # 環境変数が 4 つ（シークレットの参照 3 つ + 平文の ALLOWED_SOURCE_IPS が既定の値）。すべて true
   gcloud run services describe tvad --region="$R" --format=json | jq '.spec.template.spec.containers[0].env as $e | {
     env4: (($e | length) == 4),
     secrets3: (([$e[] | select(.valueFrom.secretKeyRef != null and .value == null) | .name] | sort) == ["LINE_CHANNEL_ACCESS_TOKEN", "LINE_TO", "WEBHOOK_SECRET"]),
     allowed_source_ips: ([$e[] | select(.value != null) | {name, value}] == [{name: "ALLOWED_SOURCE_IPS", value: "52.89.214.238,34.212.75.30,54.218.53.128,52.32.178.7"}])}'
   unset URL
   ```

4. **D**（A の直後に。所有者が行う。実際の LINE に 1 通届く）: 「通し確認」の B と同じく TradingView のテストのアラートを 1 通送り、Webhook status が成功・その時刻のリクエストログの POST が `200`・`dispatched` が 1 件で全チャネル `ok: true`・LINE に届くことを確かめる（= `X-Forwarded-For` の末尾が TradingView の送信元で、許可リストが TradingView を通す。`docs/design.md`「送信元 IP の許可リスト」の未確認の点）。確かめたら設計書の未確認の点を事実に書き換える PR を出す
   - **403 なら即切り戻す**: 「切り戻し」の「急ぐとき」で前のリビジョン（`ALLOWED_SOURCE_IPS` を持たない）へ traffic を移し、続けて `allowed_source_ips = []` の PR を `deploy.yml` で反映する。その間の TradingView のアラートは再送されない。原因は、そのリクエストログの `httpRequest.remoteIp` が許可リストに入っているかの真偽だけで見る（値は記録しない）:

     ```bash
     F='resource.type="cloud_run_revision" AND resource.labels.service_name="tvad"'
     gcloud logging read "$F AND log_id(\"run.googleapis.com/requests\") AND httpRequest.status=403" --freshness=30m --format=json \
       | jq '[.[].httpRequest.remoteIp | IN("52.89.214.238", "34.212.75.30", "54.218.53.128", "52.32.178.7")]'
     ```

5. A・D が通ったら **bootstrap の apply**（ユーザーの明示承認・所有者の手元）: bootstrap の「1. 作業前の記録」の `W` と `default-sink.before.json` だけを取り、「3. init」→「4. plan と要約の確認」→「5. apply と差分 0 の確認」。plan の目安は `create` 1 件（`google_logging_project_exclusion.tvad_rejected`）・ほかは `no-op`（それ以外があれば apply しない）。apply の直後の再 plan が差分 0（API がフィルタを正規化して返すと永続差分になる。出たら filter の書き方を API の返す形に合わせる PR）
6. **C**: bootstrap の「6. 事後の確認」の `default_sink_check`（すべて true）
7. **B**: A の 3 回をもう一度送り、2 分以上待ってから（すべて期待の件数）:

   ```bash
   F='resource.type="cloud_run_revision" AND resource.labels.service_name="tvad"'
   REQ="$F AND log_id(\"run.googleapis.com/requests\")"
   START=$(date -u +%Y-%m-%dT%H:%M:%SZ)
   # （ここで 3. の curl の 3 行を送る）
   sleep 150
   gcloud logging read "$REQ AND (httpRequest.status=401 OR httpRequest.status=403) AND timestamp>=\"$START\"" --format='value(timestamp)' | wc -l   # 0
   gcloud logging read "$F AND jsonPayload.msg=\"forbidden\" AND timestamp>=\"$START\"" --format='value(timestamp)' | wc -l                            # 0
   gcloud logging read "$REQ AND httpRequest.status=200 AND timestamp>=\"$START\"" --format='value(timestamp)' | wc -l                                 # 1 以上（/health。ログ自体は届いている）
   ```

   （任意）Cloud Monitoring の Metrics Explorer で `run.googleapis.com/request_count` を `service_name=tvad`・`response_code=403` で絞り、同じ範囲で 2 以上（弾いた件数が指標で見える）。終わったら `rm -rf "$W"`

切り戻し: アプリは `allowed_source_ips = []` の PR（急ぐときは前のリビジョンへ traffic）。除外は「bootstrap の切り戻し・撤去」の「ログの除外を外す」。

調査のとき（TradingView の送信元 IP が変わった疑いなど、弾いたリクエストの送信元 IP を見たいとき）: 除外は弾いたリクエストのリクエストログ（`httpRequest.remoteIp` を含む）を保存しないので、そのままでは送信元が分からない。所有者の承認の後、一時的に `gcloud logging sinks update _Default --update-exclusion=name=<除外の名前>,disabled=true`（または Terraform で `disabled = true` の PR）で止めて調べ、終わったら戻す（止めている間は弾いたリクエストのログが課金の対象になる）。

### 更新

- main へのマージごとに plan job が動く。イメージの入力（`Dockerfile`・`.dockerignore`・`package.json`・`src/`）か `infra/prod` が変わったときだけ差分が出て、Environment `prod` の承認待ちになる。ドキュメントだけのマージは「差分なし」で承認待ちは出ない
- イメージの入力を足すときは、`.dockerignore` の許可リストと `.github/scripts/image.sh` の `paths` を一緒に直す（`ci.yml` の check が食い違いを落とす）
- 承認する前に、plan job の要約の「アドレスと操作」が PR の意図どおりか（既存のものの `delete`・`replace` が無いか）を見る。要約には update で変わる値が出ない（public のリポジトリなので値を出さない割り切り）ので、何が変わるかはマージした PR の diff（`infra/prod`・イメージの入力）と照らして確かめる

### 切り戻し

- **基本**: main で該当のマージを `git revert` する PR → マージ → 同じ経路（plan → 承認 → apply）。前のタグのイメージが Artifact Registry に残っていれば digest で、消えていれば（cleanup: 直近 5 版を残し 30 日超を消す）再ビルドになる
- **急ぐとき**（所有者・承認の後）: 前のリビジョンに traffic を移す

```bash
gcloud run revisions list --service=tvad --region=asia-northeast1 --format='value(metadata.name,status.conditions[0].status)'
gcloud run services update-traffic tvad --region=asia-northeast1 --to-revisions=<前のリビジョン>=100
```

traffic は Terraform で「最新のリビジョンに 100%」と明示しているので、以後の plan に `update` が出る。この状態で別のマージを deploy すると最新に戻る（固定が外れる）。続けて revert の PR を同じ経路でデプロイし、traffic を最新に戻す

### シークレットの値の入れ替え

シークレットの版（変数 `secret_version`。既定 `latest`）は、リビジョンの作成時ではなく **インスタンスの起動時** に解決される（Cloud Run のドキュメント。取れなければインスタンスは起動しない）。`latest` のまま新しい版を足すと、その後に起動したインスタンス（コールドスタート・スケールアウト）だけが新しい値になり、動いているインスタンスは古い値のまま（いつ切り替わるかが決まらない）。このため入れ替えは、**版の番号を指定する PR で新しいリビジョンを作って反映する**（`deploy.yml` の経路。`gcloud run services update` は使わない = 本番を変えるのは `deploy.yml` だけ）。

`secret_version` は 3 つのシークレットに共通なので、指定する番号の版が **3 つすべてに enabled である** 必要がある（無いと新しいリビジョンが起動せず apply が失敗する。traffic は前のリビジョンのまま）。1 つだけ入れ替えるときも、ほかの 2 つにいまの値の複製を足して番号をそろえる。

1. **新しい版を足す**（所有者）。入れ替えるシークレットは「シークレットの値の投入」と同じく `read -rs` で入れ、ほかはいま使っている版の値の複製を足す（値を表示しない。`CUR` はいまの `secret_version` = `infra/prod/variables.tf` の既定。`latest` か番号）:

   ```bash
   NEW=tvad-webhook-secret   # 入れ替えるシークレット
   CUR=latest                # いまの secret_version
   for s in tvad-webhook-secret tvad-line-channel-access-token tvad-line-to; do
     if [ "$s" = "$NEW" ]; then
       printf '%s の新しい値: ' "$s"; IFS= read -rs V; echo
     else
       V=$(gcloud secrets versions access "$CUR" --secret="$s")   # いまの値（表示しない）
     fi
     printf '%s' "$V" | gcloud secrets versions add "$s" --data-file=-
     unset V
   done
   # 3 つの最新の版の番号（同じ N になること。違えば小さいほうに複製を足してそろえる）
   for s in tvad-webhook-secret tvad-line-channel-access-token tvad-line-to; do
     gcloud secrets versions list "$s" --filter='state=ENABLED' --sort-by=~createTime --limit=1 --format='value(name.basename())'
   done
   ```

2. **PR**: `infra/prod/variables.tf` の `secret_version` の `default` を `"N"` にする（`infra/prod/tests/prod.tftest.hcl` の既定の版の検査も合わせて直す）。PR の `terraform-plan` の要約が `update` 1 件（`google_cloud_run_v2_service.tvad`）
3. **マージ → 承認 → apply**（上の「更新」と同じ）。新しいリビジョンが Ready になり、すべてのインスタンスが版 N の値になる
4. **webhook のシークレットのとき**: 3. の後に、README.md「TradingView のアラートの設定」の手順で新しい値を取り出し、すべてのアラートのメッセージの `"secret"` を書き換える。3. から書き換えまでの間は 401（TradingView は再送しない）なので、アラートが出ない時間帯に行い、終わったら `jsonPayload.msg="unauthorized"` の件数が増えていないことを見る（README.md「ログの見方」）
5. **LINE のトークンのとき**: 古いトークンを無効にする（LINE Developers での再発行・取り消し）のは 3. の後。前に無効にすると、3. までの送信が 401 で失敗する
6. 古い版は、切り戻し（前のリビジョンに traffic を移す）が要らなくなってから `gcloud secrets versions disable <版> --secret=<名前>` で止める（前のリビジョンは古い版を参照するので、止めると切り戻した先が起動できない）

### 手元の plan（所有者）

```bash
terraform -chdir=infra/prod init -input=false -backend-config="bucket=${TF_VAR_project_id}-tvad-tfstate"
export TF_VAR_image="$(GCP_PROJECT_ID="$TF_VAR_project_id" .github/scripts/image.sh resolve | sed -n 's/^image=//p')"
terraform -chdir=infra/prod plan -lock=false -input=false -out=prod.tfplan
.github/scripts/tf-plan-summary.sh infra/prod/prod.tfplan   # アドレスと操作だけ（全文を Issue / PR に貼らない）
rm -f infra/prod/prod.tfplan
```

手元から apply しない（本番を変えるのは `deploy.yml` だけ）。

### 撤去

2 段の PR で行う（どちらも同じ経路 = 承認の後の apply）: (1) `run.tf` の `deletion_protection` を `false` にする PR、(2) `google_cloud_run_v2_service.tvad` を消す PR。Artifact Registry のイメージとシークレットは bootstrap の管理物なので残る。
