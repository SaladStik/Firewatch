/**
 * Imported first by main.tsx (module imports run before the importing file's body, and app
 * state reads storage when its module loads).
 */
// The app was renamed EMBER//GRID → EMBER//WATCH: carry saved settings over to the new keys (once).
try {
  for (const k of Object.keys(localStorage)) {
    if (!k.startsWith('embergrid.')) continue
    const nk = 'emberwatch.' + k.slice('embergrid.'.length)
    if (localStorage.getItem(nk) == null) localStorage.setItem(nk, localStorage.getItem(k) ?? '')
    localStorage.removeItem(k)
  }
} catch { /* storage unavailable */ }

export {}
