# Phase 9.2 (STRATEGY.md §24.39, decision D8) — the SHARED host VM + network.
#
# The one VM that BOTH the dev (`career-pilot-dev`) and (at 9.4) prod
# (`career-pilot`) NanoClaw stacks run on. The per-environment Cloudflare
# surface + each env's `cloudflared` tunnel live in `infra/` (workspace-per-env).
#
# The VM has NO public ingress: SSH is reachable only via GCP Identity-Aware
# Proxy (IAP), and all app traffic arrives through OUTBOUND `cloudflared`
# tunnels (configured per-env at deploy time, NOT here). Cloud-init does only
# the env-agnostic host baseline (Docker, Node, pnpm, the service user); the
# per-env app + OneCLI + tunnel bootstrap runs over SSH/IAP via the deploy step,
# so this layer stays env-agnostic and the app setup stays re-runnable.

resource "google_compute_network" "vpc" {
  name                    = "career-pilot-network"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "subnet" {
  name          = "career-pilot-subnet"
  ip_cidr_range = "10.0.1.0/24"
  network       = google_compute_network.vpc.id
  region        = var.gcp_region
}

# SSH only, and only from Google's IAP TCP-forwarding range — never the open
# internet. Operators reach the box via
# `gcloud compute ssh career-pilot-host --tunnel-through-iap`.
resource "google_compute_firewall" "iap_ssh" {
  name    = "career-pilot-allow-iap-ssh"
  network = google_compute_network.vpc.name

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  # Google IAP's published source range for TCP forwarding.
  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["career-pilot-host"]
}

resource "google_compute_instance" "host" {
  name         = "career-pilot-host"
  machine_type = var.machine_type
  zone         = var.gcp_zone
  tags         = ["career-pilot-host"]

  boot_disk {
    initialize_params {
      image = "projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64"
      size  = var.boot_disk_gb
      type  = "pd-balanced"
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.subnet.id
    # Ephemeral external IP for OUTBOUND only (apt, container pulls, the
    # cloudflared tunnel dial-out, api.anthropic.com). No inbound ports are
    # open (the firewall allows only IAP SSH), so this is not an attack
    # surface — and it avoids the ~$32/mo cost of Cloud NAT for a dev box.
    access_config {}
  }

  metadata = {
    # OS Login: SSH access is governed by IAM (the project owner identity),
    # no manually-managed SSH keys.
    enable-oslogin = "TRUE"
    user-data = templatefile("${path.module}/templates/host-init.yml.tpl", {
      service_user = var.service_user
    })
  }

  # Default compute service account, cloud-platform scope. Least-privilege
  # (a dedicated SA with logging/monitoring-only roles) is a 9.4 hardening item.
  service_account {
    scopes = ["cloud-platform"]
  }

  # Cloud-init runs once at first boot; editing the baseline later is done over
  # SSH, not by replacing the VM. Ignore user-data churn so a template tweak
  # doesn't show a spurious diff (or threaten the running host).
  lifecycle {
    ignore_changes = [metadata["user-data"]]
  }
}
