# infra

本番（GCP の Cloud Run）の Terraform。設計は `docs/design.md`「GCP の構成」「シークレットの置き場」。

| ルート | 中身 | apply する人 | state の場所 |
|---|---|---|---|
| `infra/bootstrap` | WIF のプール・プロバイダ、SA 3 つ（実行用・CI の apply 用・CI の plan 用）と付与、Artifact Registry、tfstate のバケット 2 つ、Secret Manager の入れ物 3 つ | **所有者が手元で 1 回**（IAM を変えるので CI には apply させない） | `<PROJECT_ID>-tvad-tfstate-bootstrap`（prefix `bootstrap`） |
| `infra/prod` | Cloud Run のサービス（#4 で追加） | CI（`deploy.yml`。GitHub の Environment `prod` の承認の後。#4） | `<PROJECT_ID>-tvad-tfstate` |

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
.github/scripts/tf-iam-decl-check.sh      # IAM のリソースの宣言（種類と名前）が決めた 8 件と同じか
```

`terraform test` の「付与は○件だけ」は、そのリソースの中の件数（for_each の数）しか見られない。別の名前・別の種類の IAM のリソースを足したことは `tf-iam-decl-check.sh` が宣言の一覧で検出する。実際のプロジェクトの IAM に増えたのが決めた付与だけであることは、apply の後の「6. 事後の確認」（プロジェクトの IAM の差分）で確かめる。

Terraform は 1.16.4（PATH に無ければ `mise exec terraform@1.16.4 -- terraform …`）。google プロバイダは `= 8.9.0` で固定。版を上げるときは `terraform -chdir=infra/bootstrap providers lock -platform=linux_amd64 -platform=darwin_arm64 -platform=darwin_amd64` で lock を作り直す。

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

必要な API が有効か（8 なら OK）:

```bash
gcloud services list --enabled --format='value(config.name)' \
  | grep -cxE '(iam|iamcredentials|sts|artifactregistry|secretmanager|run|cloudresourcemanager|storage)\.googleapis\.com'
```

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

設定は Settings → Environments で行う（承認者・ブランチは API の `PUT repos/<owner>/<repo>/environments/prod` と `POST …/environments/prod/deployment-branch-policies` でもできるが、管理者の bypass は公開の REST・GraphQL の仕様に無いので画面で外す）。リポジトリは public（GitHub Free / Pro / Team で required reviewers が使えるのは public のリポジトリ）。

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
# 管理者の bypass が無効（true なら OK）。公開の仕様に無いフィールドなので、null が返って false になったら画面で
# 「Allow administrators to bypass configured protection rules」が外れていることを目で確かめる
gh api "$E" --jq '.can_admins_bypass == false'
```

`false`（bypass は画面で確かめた場合を除く）か 404（Environment が無い）なら apply しない。多層防御として、WIF のプロバイダの条件でも Environment `prod` のトークンは `ref` が `refs/heads/main` のときだけ受け付ける（`wif.tf`。保護が外れても main 以外のブランチからは借りられない。ただし守るのはブランチの制限だけで、承認の欠落は守らないので、上の確認は省かない）。

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
| `create` | 22 | SA 3・プール 1・プロバイダ 1・SA の付与 3（借用 2・actAs 1）・プロジェクトの付与 2・バケット 1（prod）・バケットの付与 2・Artifact Registry 1・その付与 2・シークレット 3・その付与 3 |
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
```

終わったら `rm -rf "$W"`。

## シークレットの値の投入（所有者。#4 / #5 の前）

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

Cloud Run は IAM の条件のリソース属性に対応していないので、サービス名で絞った付与はできない（条件をつけると何も許可されない）。#4 の `invoker_iam_disabled` には `run.services.setIamPolicy` が要るので `roles/run.developer` でも足りない。このため apply SA は同じプロジェクトの既存のサービスも変更できる。次で緩和する（`docs/design.md`「apply SA の Cloud Run の権限」）:

- apply SA を借りられるのは GitHub の Environment `prod` の job だけ。Environment `prod` は **bootstrap の apply より前に** main 限定・承認必須（所有者）・管理者の bypass なしに設定し、読み取りで確かめる（上の「0. 前提」。存在しない Environment を参照する job は保護なしの Environment を自動作成するので、「Environment が無いから借りられない」とは言えない）
- WIF のプロバイダの条件で、Environment `prod` のトークンは `ref` が `refs/heads/main` のときだけ受け付ける（Environment の保護が外れたときの 2 枚目）
- #4 の `deploy.yml` は承認の前に plan の要約（アドレスと操作）を出す
- 上の事後の確認で、既存のサービスのリビジョンと IAM が変わっていないことを確かめる

## #4 への引き継ぎ（plan SA）

- plan SA の prod の state への付与は `roles/storage.objectViewer`（読み取り）だけ。gcs backend の plan は既定で state のロック（`.tflock` の作成）を取るので、**#4 の PR の plan は `terraform plan -lock=false` で行う**（付与は増やさない。plan は state を書かないので、ロックなしでも state は壊れない。apply は apply SA がロックを取る）
- plan SA はこのリポジトリのどのブランチ・イベントの job でも借りられる（読み取りだけ）。#4 のワークフローで `pull_request_target` を使わない（fork の PR に OIDC のトークンを渡さない）
- 不変 ID 入りの sub の形式（`iam.tf` の `apply_subject`）は #4 の最初の deploy の認証で確かめる（違えば認証が拒否される = 安全側の失敗）

## 切り戻し・撤去

- 付与だけを外す: 該当の `*_iam_member` を消して apply（追加型なので、ほかの付与は残る）
- 全体の撤去: 各リソースの `deletion_policy = "PREVENT"` とバケットの `prevent_destroy` を外してから `terraform destroy`。バケットとシークレットは中身を確かめてから手で消す。WIF のプールは削除後 30 日は同じ ID を作り直せない
