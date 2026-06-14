/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the portal backend (native-http API). Baked at build time. */
  readonly VITE_API_BASE?: string
  /** Arms the client-side mock seams (the synthetic-crash route — §24.36 36.3).
   * Baked `'1'` only into the dev + E2E builds; the production build leaves it
   * unset, so the seams are inert. The client-side counterpart to the server's
   * PORTAL_MOCK_STATE_SEAM. */
  readonly VITE_MOCK_SEAM?: string
  /** The fork's public repo URL (the "view source" link base). Per-deployment;
   * defaults to the generic `janedoe` placeholder when unset (§24.71 9.4b-3). */
  readonly VITE_REPO_URL?: string
  /** The public origin (absolute og:url / og:image base). Per-deployment;
   * defaults to the generic `hire.example.com` placeholder (§24.71 9.4b-3). */
  readonly VITE_SITE_URL?: string
  /** The candidate's name — the header brand wordmark. Per-deployment; defaults
   * to the generic `Jane Doe` placeholder when unset (§24.71 9.4b-3). */
  readonly VITE_PERSON_NAME?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
