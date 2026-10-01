import { createRoot } from 'react-dom/client'
import './index.css'

// Apply the saved theme before first paint (no flash).
try {
  document.documentElement.dataset.theme = localStorage.getItem('embergrid.theme') === 'light' ? 'light' : 'dark'
} catch {
  document.documentElement.dataset.theme = 'dark'
}
import App from './App.tsx'
import { mountFireflyDev } from './mascot/firefly/script'

// No StrictMode: the engine owns a WebGL context + worker and must mount exactly once.
createRoot(document.getElementById('root')!).render(<App />)

// Firefly script recorder overlay (dev builds, or ?fireflydev). Ctrl+Shift+F.
mountFireflyDev()
