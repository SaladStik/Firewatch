import './migrateStorage' // first: renamed storage keys must be in place before anything reads them
import { createRoot } from 'react-dom/client'
import './index.css'

// Apply the saved theme before first paint (no flash).
try {
  document.documentElement.dataset.theme = localStorage.getItem('firewatch.theme') === 'light' ? 'light' : 'dark'
} catch {
  document.documentElement.dataset.theme = 'dark'
}
import App from './App.tsx'
import { mountFireflyDev } from './mascot/firefly/script'
import { applySavedLodTuning } from './dev/LodTuner'

// Dev LOD tuning saved in this browser (no-op unless dev / ?fireflydev). Must run before the engine boots.
applySavedLodTuning()

// No StrictMode: the engine owns a WebGL context + worker and must mount exactly once.
createRoot(document.getElementById('root')!).render(<App />)

// Firefly script recorder overlay (dev builds, or ?fireflydev). Ctrl+Shift+F.
mountFireflyDev()
