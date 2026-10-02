import { spawn, type ChildProcess } from 'node:child_process'
import { createConnection } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const appDir = path.dirname(fileURLToPath(import.meta.url))

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' })
    const done = (open: boolean) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(open)
    }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/** Starts the wildfire instrument server (DHT11 dashboard) next to the map. */
function instrumentServer(): Plugin {
  let child: ChildProcess | null = null
  const stop = () => {
    if (child && !child.killed) child.kill()
    child = null
  }
  return {
    name: 'instrument-server',
    async configureServer(server) {
      if (await portOpen(8000)) return
      const root = path.resolve(appDir, '../wildfire')
      const python = path.join(root, '.venv', 'Scripts', 'python.exe')
      child = spawn(python, ['-m', 'app'], { cwd: root, stdio: 'inherit', windowsHide: true })
      child.on('error', (err) => {
        console.error(`[instrument] failed to start: ${err.message}`)
      })
      server.httpServer?.on('close', stop)
    },
  }
}

// Static site: `npm run build` → dist/ (deploy anywhere). Set BASE for sub-path hosting (e.g. GitHub Pages).
export default defineConfig({
  base: process.env.BASE ?? '/',
  plugins: [react(), tailwindcss(), instrumentServer()],
  worker: { format: 'es' },
  // Don't watch the bake cache (GBs of downloads). public/data stays watched so newly baked files are served.
  server: { watch: { ignored: ['**/scripts/.cache/**'] } },
  build: {
    rollupOptions: {
      // Main app + the standalone mascot preview page.
      input: { main: path.resolve(appDir, 'index.html'), firefly: path.resolve(appDir, 'firefly.html') },
    },
  },
})
