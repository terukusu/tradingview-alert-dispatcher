# prod の state は bootstrap が作った prod 用のバケット（出力 tf_state_bucket）に置く。
# バケット名は部分設定で渡す（リポジトリに書かない）: terraform init -backend-config="bucket=<PROJECT_ID>-tvad-tfstate"
# plan SA は読み取り（objectViewer）だけなので、plan は -lock=false で行う（docs/design.md「SA と権限」）
terraform {
  backend "gcs" {
    prefix = "prod"
  }
}
