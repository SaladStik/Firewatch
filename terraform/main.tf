# Credentials for the Cloudflare Pages proxy to call the FIRE//WATCH data server.
#
# The proxy needs a service principal with an OAuth secret, and that principal needs
# permission to use the app. Doing it by hand means clicking through the account console and
# copying a secret that is shown exactly once; this does the same thing reproducibly and
# prints both halves.
#
#   cd terraform
#   terraform init
#   terraform apply
#   terraform output -raw databricks_client_id
#   terraform output -raw databricks_client_secret
#
# Then paste those into Cloudflare Pages (see DEPLOY-DATABRICKS.md section 5).
#
# Everything here is workspace-level, so the `databricks auth login` you already did is
# enough — no account ID and no second login. That is only possible because
# databricks_service_principal_secret accepts api = "workspace"; the account console is the
# manual route, not the only one.

terraform {
  required_version = ">= 1.5"
  required_providers {
    databricks = {
      source  = "databricks/databricks"
      version = "~> 1.0"
    }
  }
}

variable "profile" {
  description = "Databricks CLI profile. `databricks auth login` names it after the workspace, not DEFAULT."
  type        = string
  default     = "dbc-16e256ad-ebf8"
}

variable "app_name" {
  description = "The Databricks App running the data server."
  type        = string
  default     = "firewatch-data"
}

provider "databricks" {
  profile = var.profile
}

# The identity the proxy authenticates as. It owns no data and can do nothing in the
# workspace except call the app, which is the whole point of using one rather than a person.
resource "databricks_service_principal" "pages" {
  display_name = "firewatch-pages"

  # Without this the principal has no entitlements at all and every call to the app comes back
  # 401, even with CAN_USE granted and a valid token — it cannot reach the workspace to begin
  # with. This is the only entitlement it needs; it gets no cluster or SQL access.
  workspace_access = true
}

# Its OAuth secret. `api = "workspace"` is what keeps this off the account console.
resource "databricks_service_principal_secret" "pages" {
  service_principal_id = databricks_service_principal.pages.id
  api                  = "workspace"
}

# Without this the proxy gets a 403 even with a perfectly valid token.
resource "databricks_permissions" "app_usage" {
  app_name = var.app_name

  access_control {
    service_principal_name = databricks_service_principal.pages.application_id
    permission_level       = "CAN_USE"
  }
}

output "databricks_client_id" {
  description = "DATABRICKS_CLIENT_ID for Cloudflare Pages."
  value       = databricks_service_principal.pages.application_id
}

output "databricks_client_secret" {
  description = "DATABRICKS_CLIENT_SECRET for Cloudflare Pages. Mark it as a secret there."
  value       = databricks_service_principal_secret.pages.secret
  sensitive   = true
}

output "databricks_host" {
  description = "DATABRICKS_HOST for Cloudflare Pages."
  value       = "https://dbc-16e256ad-ebf8.cloud.databricks.com"
}
