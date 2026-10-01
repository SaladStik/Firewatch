import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Static site: `npm run build` → dist/ (deploy anywhere). Set BASE for sub-path hosting (e.g. GitHub Pages).
export default defineConfig({
  base: process.env.BASE ?? '/',
  plugins: [react(), tailwindcss()],
  worker: { format: 'es' },
})
