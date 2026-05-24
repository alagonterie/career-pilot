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

variable "frontend_subdomain" {
  description = "The subdomain for the Next.js portal (e.g., 'hire')"
  type        = string
  default     = "hire"
}

variable "cloudflare_worker_subdomain" {
  description = "The workers.dev subdomain assigned by Cloudflare (e.g., 'career-pilot')"
  type        = string
  default     = "career-pilot"
}
