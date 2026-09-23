import { defineConfig } from 'vite'

export default defineConfig({
  // 5183 rather than Vite's default 5173, which other local projects tend to occupy.
  server: { host: true, port: 5183, strictPort: true },
  build: { target: 'esnext' },
})
