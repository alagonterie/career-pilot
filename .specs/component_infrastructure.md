# Component Design: GCP, Cloudflare, & CI/CD Infrastructure

This document outlines the Infrastructure as Code (IaC) and Continuous Integration / Continuous Deployment (CI/CD) pipelines for the job-hunting assistant project.

---

## 1. Terraform Infrastructure Code

The infrastructure is provisioned using Terraform. The files reside in the `iac/` directory.

### Provider Settings (`iac/provider.tf`)
```hcl
terraform {
  required_version = ">= 1.5.0"
  
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.0"
    }
  }

  backend "gcs" {
    bucket = "hire-agent-tfstate"
    prefix = "terraform/state"
  }
}

provider "google" {
  project = var.gcp_project_id
  region  = var.gcp_region
  zone    = var.gcp_zone
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}
```

### VM & Networking (`iac/main.tf`)
We provision an `e2-small` instance on GCP using a Container-Optimized OS (COS) image.
```hcl
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

# Firewall rule allowing only SSH access (API traffic runs over Cloudflare Tunnel)
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

# GCP VM Instance using Container-Optimized OS
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
      // Ephemeral public IP address (only SSH accessed directly, if not via IAP)
    }
  }

  metadata = {
    # Cloud-init configuring directory paths, downloading docker-compose to /opt/bin, and running containers
    user-data = templatefile("${path.module}/templates/user-data.yml.tpl", {
      docker_compose_content = base64encode(file("${path.module}/../backend/docker-compose.yml"))
      cloudflare_tunnel_token = var.cloudflare_tunnel_token
    })
  }

  service_account {
    scopes = ["cloud-platform"]
  }
}
```

### DNS & Cloudflare Tunnel Settings (`iac/cloudflare.tf`)
Uses generic input variables to avoid hardcoded domain strings. Registers the tunnel resource and CNAME record.
```hcl
resource "cloudflare_record" "frontend_cname" {
  zone_id = var.cloudflare_zone_id
  name    = var.frontend_subdomain # e.g. "hire"
  value   = "${var.cloudflare_worker_subdomain}.workers.dev" # Matches Wrangler route
  type    = "CNAME"
  proxied = true
}

resource "cloudflare_tunnel" "backend_tunnel" {
  account_id = var.cloudflare_account_id
  name       = "career-pilot-backend-tunnel"
  secret     = base64sha256(var.cloudflare_tunnel_secret)
}

resource "cloudflare_record" "backend_tunnel_cname" {
  zone_id = var.cloudflare_zone_id
  name    = "api.${var.frontend_subdomain}" # e.g. "api.hire"
  value   = "${cloudflare_tunnel.backend_tunnel.id}.cfargotunnel.com"
  type    = "CNAME"
  proxied = true
}
```

---

## 2. GitHub Actions CI/CD Workflows

We use separate workflows to deploy the Next.js Worker and the GCP Orchestrator backend on push to the `main` branch.

### Frontend Deployment (`.github/workflows/deploy-frontend.yml`)
Deploys Next.js to Cloudflare Workers using the Wrangler CLI.
```yaml
name: Deploy Frontend to Cloudflare

on:
  push:
    branches:
      - main
    paths:
      - 'frontend/**'

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'
          cache-dependency-path: 'frontend/package.json'

      - name: Install Dependencies
        run: |
          cd frontend
          npm ci

      - name: Build Next.js app via OpenNext
        run: |
          cd frontend
          npx @opennextjs/cloudflare build
        env:
          NEXT_PUBLIC_CANDIDATE_NAME: ${{ vars.CANDIDATE_NAME }}
          NEXT_PUBLIC_CANDIDATE_TITLE: ${{ vars.CANDIDATE_TITLE }}
          NEXT_PUBLIC_CANDIDATE_DOMAIN: ${{ vars.DOMAIN_NAME }}
          NEXT_PUBLIC_API_URL: https://api.${{ vars.DOMAIN_NAME }}
          NEXT_PUBLIC_GITHUB_URL: ${{ vars.GITHUB_URL }}
          NEXT_PUBLIC_LINKEDIN_URL: ${{ vars.LINKEDIN_URL }}

      - name: Deploy to Cloudflare Workers
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          workingDirectory: 'frontend'
          command: deploy
```

### Backend Deployment (`.github/workflows/deploy-backend.yml`)
Deploys the customized NanoClaw orchestrator to the GCP COS VM. It utilizes Google Workload Identity Federation for passwordless IAM authentication.
```yaml
name: Deploy Backend to GCP

on:
  push:
    branches:
      - main
    paths:
      - 'backend/**'

permissions:
  contents: read
  id-token: write

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Code
        uses: actions/checkout@v4

      - name: Authenticate to GCP
        uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ secrets.GCP_WORKLOAD_IDENTITY_PROVIDER }}
          service_account: ${{ secrets.GCP_SERVICE_ACCOUNT }}

      - name: Set up Cloud SDK
        uses: google-github-actions/setup-gcloud@v2

      - name: Sync Files to GCP VM via gcloud compute scp
        run: |
          gcloud compute scp --recurse backend/ --zone=${{ secrets.GCP_ZONE }} hire-backend-orchestrator:/home/app/backend

      - name: Restart Services via SSH
        run: |
          gcloud compute ssh hire-backend-orchestrator --zone=${{ secrets.GCP_ZONE }} --command="
            cd /home/app/backend && \
            export PORTKEY_API_KEY='${{ secrets.PORTKEY_API_KEY }}' && \
            /opt/bin/docker-compose down && \
            /opt/bin/docker-compose up -d --build
          "
```

---

## 3. Workload Identity Federation (Keyless Auth)

To connect GitHub Actions to GCP without long-lived JSON keys:
1. We create a Workload Identity Pool (`hire-pool`) and Provider in the GCP console.
2. We map the provider audience to `https://iam.googleapis.com/projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/hire-pool/providers/github-provider`.
3. We grant the role `roles/iam.workloadIdentityUser` to the GitHub repository service account (`service-<PROJECT_NUMBER>@gcp-sa-auth.iam.gserviceaccount.com`), binding the GitHub repository.
4. This allows the actions job to acquire a temporary OAuth2 access token on the fly via the `google-github-actions/auth` step.
