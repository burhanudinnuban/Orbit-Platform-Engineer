output "namespace" {
  description = "The app's namespace."
  value       = kubernetes_namespace_v1.this.metadata[0].name
}

output "service_account" {
  description = "ServiceAccount the app's pods run as."
  value       = kubernetes_service_account_v1.app.metadata[0].name
}

output "database_secret" {
  description = "Name of the Secret with DATABASE_URL and PG* variables, or null when database_enabled is false."
  value       = one(kubernetes_secret_v1.db[*].metadata[0].name)
}
