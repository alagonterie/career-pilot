# Phase 9.2 (STRATEGY.md §24.39, decision D8) — the "base" layer.
#
# A single, applied-once Terraform state owning the SHARED host VM + network.
# GCP-only: it declares no Cloudflare provider, because the per-environment
# Cloudflare surface + each env's `cloudflared` tunnel live in the sibling
# per-env layer (`infra/`, workspace-per-env). Splitting the one shared
# resource (the VM) out here keeps it from straddling two per-env states.
terraform {
  required_version = ">= 1.5.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

provider "google" {
  project = var.gcp_project_id
  region  = var.gcp_region
  zone    = var.gcp_zone
}
