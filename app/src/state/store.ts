/** Tiny external store (no deps) + React hook. */
import { useSyncExternalStore } from "react";

export function createStore<T extends object>(initial: T) {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set(patch: Partial<T> | ((s: T) => Partial<T>)) {
      const p = typeof patch === "function" ? patch(state) : patch;
      state = { ...state, ...p };
      subs.forEach((f) => f());
    },
    subscribe(f: () => void) {
      subs.add(f);
      return () => subs.delete(f);
    },
  };
}

export function useStore<T extends object, S>(store: ReturnType<typeof createStore<T>>, sel: (s: T) => S): S {
  return useSyncExternalStore(store.subscribe, () => sel(store.get()));
}
