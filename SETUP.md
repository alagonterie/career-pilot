# Career Pilot Setup Guide

This document outlines all the necessary prerequisites, credentials, and configuration steps required to deploy and run the Career Pilot system from scratch. 

## 1. Local Prerequisites

Ensure your local development machine has the following tools installed:
- **Node.js** (v20+) & **npm**
- **Docker Desktop** (with NVIDIA GPU passthrough enabled if testing local LLMs)
- **Terraform** (v1.5+)
- **Google Cloud CLI** (`gcloud`)
- **Git**

## 2. Service Accounts & API Keys

You will need accounts and tokens from the following providers:

### A. Telegram (User Interface)
The system uses Telegram as the primary interface for natural language interaction.
1. Open Telegram and search for `@BotFather`.
2. Send `/newbot` and follow the prompts to create your bot.
3. Save the **Bot Token** provided.
4. Search for `@userinfobot` (or similar) and send a message to get your personal **Chat ID**. 
   *This is critical: the bot will drop messages from any other Chat ID for security.*

### B. Cloudflare (Edge Hosting & Tunnels)
Used for hosting the frontend Next.js app and securing the backend API via Zero Trust tunnels.
1. Create a Cloudflare account.
2. Add your custom domain to Cloudflare and change your nameservers at your registrar.
3. Note your **Account ID** (found on the right sidebar of the Cloudflare dashboard overview).
4. Note your **Zone ID** (found on the right sidebar of your specific domain's overview).
5. Generate an **API Token** (`My Profile -> API Tokens`). It must have permissions to Edit `DNS` and `Zero Trust`.

### C. Google Cloud Platform (Backend Infrastructure)
Used for the Container-Optimized OS Virtual Machine and Workspace integrations.
1. Create a new project in the [GCP Console](https://console.cloud.google.com/).
2. Note your **Project ID**.
3. Enable the **Compute Engine API**.
4. Authenticate your local machine for Terraform by running:
   ```bash
   gcloud auth application-default login
   ```

### D. Google Workspace OAuth (Gmail / Calendar Sync)
Allows the bot to parse incoming recruiter emails and sync interview calendar events.
1. In the GCP Console, navigate to **APIs & Services > Credentials**.
2. Configure the **OAuth Consent Screen** (set to Internal or External/Testing depending on your workspace type).
3. Create **OAuth 2.0 Client IDs** (Web Application type).
4. Add the following scopes:
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/calendar.events.readonly`
5. Save the **Client ID** and **Client Secret**.

### E. Portkey & OpenRouter (Production LLMs)
Local development uses Ollama (free), but production cloud deployment relies on API routing via Portkey to OpenRouter.
1. Create an [OpenRouter](https://openrouter.ai/) account and generate an API Key.
2. Create a [Portkey](https://portkey.ai/) account.
3. In Portkey, navigate to the **Virtual Keys** vault and securely save your OpenRouter API Key.
4. Note the generated Portkey Virtual Key slug (e.g., `@openrouter-default`).
5. Generate a **Portkey API Key** for the application to use.

---

## 3. Environment Variables Reference

When we initialize the repository, we will create a `.env.example` file. You will need to copy this to `.env` and populate it with the secrets gathered above. 

**Never commit the `.env` file to version control.**

```env
# ==========================================
# 1. TELEGRAM CONFIGURATION
# ==========================================
TELEGRAM_BOT_TOKEN="your_telegram_bot_token_here"
ALLOWED_TELEGRAM_CHAT_ID="your_personal_chat_id"

# ==========================================
# 2. CLOUDFLARE CONFIGURATION
# ==========================================
CLOUDFLARE_API_TOKEN="your_cloudflare_api_token"
CLOUDFLARE_ACCOUNT_ID="your_account_id"
CLOUDFLARE_ZONE_ID="your_zone_id"
DOMAIN_NAME="yourdomain.com"

# ==========================================
# 3. GOOGLE CLOUD & WORKSPACE
# ==========================================
GOOGLE_PROJECT_ID="your_gcp_project_id"
GOOGLE_OAUTH_CLIENT_ID="your_oauth_client_id"
GOOGLE_OAUTH_CLIENT_SECRET="your_oauth_client_secret"

# ==========================================
# 4. LLM CONFIGURATION (PRODUCTION ONLY)
# ==========================================
PORTKEY_API_KEY="your_portkey_api_key"
PORTKEY_VIRTUAL_KEY="your_openrouter_virtual_key"
```

## 4. Next Steps
Once your `.env` is populated locally:
1. Run Terraform to provision the GCP VM and Cloudflare Tunnels.
2. Deploy the Frontend to Cloudflare Workers.
3. Deploy the Backend Docker Compose stack.
4. Message your Telegram Bot to complete the initialization!
