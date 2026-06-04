# Phase 9.2 (STRATEGY.md §24.39) — CI deploy identity permissions.
#
# The `deploy-backend.yml` dev job authenticates GH -> GCP via Workload Identity
# Federation as the deploy service account, then `gcloud compute ssh
# --tunnel-through-iap` into the host to run the idempotent bootstrap with sudo.
# These are the minimum roles for that, against a VM that has OS Login enabled
# and an attached service account. count-gated on `deployer_sa_email` so a fork
# without a CI deploy SA still applies cleanly.

data "google_compute_default_service_account" "default" {}

locals {
  deployer_member = "serviceAccount:${var.deployer_sa_email}"
  deployer_count  = var.deployer_sa_email == "" ? 0 : 1
}

# Reach the host through the IAP TCP-forwarding proxy (the only SSH path —
# the firewall allows nothing else).
resource "google_project_iam_member" "deployer_iap_tunnel" {
  count   = local.deployer_count
  project = var.gcp_project_id
  role    = "roles/iap.tunnelResourceAccessor"
  member  = local.deployer_member
}

# OS Login as an admin (sudo) — the bootstrap writes systemd units + installs
# packages. Project-level is acceptable: this single-purpose project holds only
# the one host VM.
resource "google_project_iam_member" "deployer_os_admin_login" {
  count   = local.deployer_count
  project = var.gcp_project_id
  role    = "roles/compute.osAdminLogin"
  member  = local.deployer_member
}

# Resolve the instance for `gcloud compute ssh`.
resource "google_project_iam_member" "deployer_compute_viewer" {
  count   = local.deployer_count
  project = var.gcp_project_id
  role    = "roles/compute.viewer"
  member  = local.deployer_member
}

# OS Login to a VM that has an attached service account requires the connecting
# identity to be able to act as that SA.
resource "google_service_account_iam_member" "deployer_actas_vm_sa" {
  count              = local.deployer_count
  service_account_id = data.google_compute_default_service_account.default.name
  role               = "roles/iam.serviceAccountUser"
  member             = local.deployer_member
}
