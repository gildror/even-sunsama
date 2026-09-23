/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PROVIDER?: 'mock' | 'sunsama'
  readonly VITE_SUNSAMA_SEED_BUNDLE?: string
}
