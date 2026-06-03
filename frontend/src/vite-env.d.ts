/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the portal backend (native-http API). Baked at build time. */
  readonly VITE_API_BASE?: string
  /** Arms the client-side mock seams (the synthetic-crash route — §24.36 36.3).
   * Baked `'1'` only into the dev + E2E builds; the production build leaves it
   * unset, so the seams are inert. The client-side counterpart to the server's
   * PORTAL_MOCK_STATE_SEAM. */
  readonly VITE_MOCK_SEAM?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
