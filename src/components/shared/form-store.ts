'use client';

import { useSyncExternalStore } from 'react';

/** Tiny external store so a modal's body and footer (rendered in different places by the Modal provider) share form state. */
export interface Store<T> {
  get(): T;
  set(patch: Partial<T>): void;
  subscribe(fn: () => void): () => void;
}

export function createStore<T extends object>(init: T): Store<T> {
  let v = init;
  const subs = new Set<() => void>();
  return {
    get: () => v,
    set(patch) {
      v = { ...v, ...patch };
      subs.forEach((f) => f());
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
