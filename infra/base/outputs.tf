output "vm_name" {
  description = "The shared host instance name — the per-env deploy + tunnel bootstrap target this."
  value       = google_compute_instance.host.name
}

output "vm_zone" {
  description = "The VM's zone — needed for `gcloud compute ssh --zone`."
  value       = google_compute_instance.host.zone
}

output "vm_external_ip" {
  description = "Ephemeral external IP (outbound only; no inbound ports open)."
  value       = google_compute_instance.host.network_interface[0].access_config[0].nat_ip
}

output "service_user" {
  description = "The Linux user that owns the checkouts + runs the services."
  value       = var.service_user
}
