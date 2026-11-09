# bootstrap の state は所有者が gcloud で先に作る bootstrap 用のバケットに置く（imports.tf で管理下に取り込む）。
# バケット名は部分設定で渡す: terraform init -backend-config="bucket=<PROJECT_ID>-tvad-tfstate-bootstrap"
terraform {
  backend "gcs" {
    prefix = "bootstrap"
  }
}
