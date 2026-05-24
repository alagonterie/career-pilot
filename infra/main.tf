resource "google_compute_network" "vpc_network" {
  name                    = "hire-network"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "subnet" {
  name          = "hire-subnet"
  ip_cidr_range = "10.0.1.0/24"
  network       = google_compute_network.vpc_network.id
  region        = var.gcp_region
}

resource "google_compute_firewall" "firewall" {
  name    = "allow-ssh-only"
  network = google_compute_network.vpc_network.name

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }

  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["backend-vm"]
}

resource "google_compute_instance" "backend_vm" {
  name         = "hire-backend-orchestrator"
  machine_type = "e2-small"
  zone         = var.gcp_zone
  tags         = ["backend-vm"]

  boot_disk {
    initialize_params {
      image = "cos-cloud/cos-stable"
      size  = 30
      type  = "pd-standard"
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.subnet.id
    access_config {
      // Ephemeral IP
    }
  }

  metadata = {
    user-data = templatefile("${path.module}/templates/user-data.yml.tpl", {
      cloudflare_tunnel_token = cloudflare_tunnel.backend_tunnel.tunnel_token
    })
  }

  service_account {
    scopes = ["cloud-platform"]
  }
}

output "vm_public_ip" {
  value = google_compute_instance.backend_vm.network_interface[0].access_config[0].nat_ip
}
