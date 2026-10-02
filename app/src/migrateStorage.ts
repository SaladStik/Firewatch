/**
 * Imported first by main.tsx (module imports run before the importing file's body, and app
 * state reads storage when its module loads).
 */
// The app was renamed EMBER//GRID → EMBER//WATCH → FIRE//WATCH: carry saved settings over to the
// current keys (once), from whichever older name they were saved under.
try {
  for (const old of ['embergrid.', 'emberwatch.']) {
    for (const k of Object.keys(localStorage)) {
      if (!k.startsWith(old)) continue
      const nk = 'firewatch.' + k.slice(old.length)
      if (localStorage.getItem(nk) == null) localStorage.setItem(nk, localStorage.getItem(k) ?? '')
      localStorage.removeItem(k)
    }
  }
} catch { /* storage unavailable */ }

export {}
