/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the portal backend (native-http API). Baked at build time. */
  readonly VITE_API_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
