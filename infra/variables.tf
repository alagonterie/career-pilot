variable "gcp_project_id" {
  description = "The GCP Project ID"
  type        = string
}

variable "gcp_region" {
  description = "The GCP Region"
  type        = string
  default     = "us-central1"
}

variable "gcp_zone" {
  description = "The GCP Zone"
  type        = string
  default     = "us-central1-a"
}

variable "cloudflare_api_token" {
  description = "Cloudflare API Token"
  type        = string
  sensitive   = true
}

variable "cloudflare_account_id" {
  description = "Cloudflare Account ID"
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Cloudflare Zone ID"
  type        = string
}

variable "apex_domain" {
  description = "The apex domain managed by this Cloudflare zone (e.g., 'example.com'). Used to construct the Tunnel ingress FQDN. Set this in terraform.tfvars (gitignored), never hardcode."
  type        = string
}

variable "frontend_subdomain" {
  description = "The subdomain for the portal (e.g., 'hire' → hire.<apex_domain>)"
  type        = string
  default     = "hire"
}

variable "cloudflare_worker_subdomain" {
  description = "The workers.dev subdomain assigned by Cloudflare (e.g., 'career-pilot')"
  type        = string
  default     = "career-pilot"
}

variable "environment" {
  description = "Deploy environment: 'dev' | 'prod'. Selects the frontend hostname + Worker name. Pass per apply (-var environment=dev) with a Terraform workspace per environment; no default, to avoid an accidental prod apply."
  type        = string

  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "environment must be 'dev' or 'prod'."
  }
}

variable "owner_email" {
  description = "The owner's email — the sole identity allowed through Cloudflare Access on the deployed environments. Set in terraform.tfvars (gitignored)."
  type        = string
}
