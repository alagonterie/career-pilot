# Career Pilot Backend Service

This is the orchestrator service that runs the SQLite database, Express API server, and runs specialized NanoClaw agent containers.

## Getting Started

### Local Development (with Ollama)
```bash
docker compose up --build
```

### Production Deployment
Production deployment is fully automated via GitHub Actions on push to the `master` branch.
*   **Security**: Authenticated using GCP Workload Identity Federation (OIDC).
*   **Process**: SCP copies the backend files, and SSH restarts the Docker compose service.
