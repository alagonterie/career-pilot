variable "gcp_project_id" {
  description = "The GCP Project ID. Set in terraform.tfvars (gitignored)."
  type        = string
}

variable "gcp_region" {
  description = "The GCP Region."
  type        = string
  default     = "us-central1"
}

variable "gcp_zone" {
  description = "The GCP Zone."
  type        = string
  default     = "us-central1-a"
}

variable "machine_type" {
  description = "VM machine type. e2-medium (4 GB) is the floor for the SHARED dev+prod host — e2-small (2 GB) OOMs once prod's concurrent Bun agent containers join (STRATEGY §13 + §24.38 D1). Escape hatch: e2-standard-2 (8 GB)."
  type        = string
  default     = "e2-medium"
}

variable "boot_disk_gb" {
  description = "Boot disk size (GB). Holds Ubuntu + Docker + the agent container image + two repo checkouts (prod + dev) + node_modules + the SQLite data dirs."
  type        = number
  default     = 50
}

variable "service_user" {
  description = "The unprivileged Linux user that owns the repo checkouts under /opt and runs the per-env NanoClaw systemd services."
  type        = string
  default     = "career-pilot"
}
