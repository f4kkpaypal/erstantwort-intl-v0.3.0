'use strict';

/**
 * Minimal reactive store used by the Mini App.
 *
 * - `set`/`update` notify subscribers once per microtask, so a burst of changes produces one render.
 * - `subscribe` returns an unsubscribe function; listeners never break the store.
 * - `select` reads a single slice for cheap, targeted updates (error banner, status pill) without
 *   re-rendering the whole screen.
 *
 * @template T
 * @typedef {Object} Store
 * @property {() => T} get
 * @property {<K extends keyof T>(key: K) => T[K]} select
 * @property {(patch: Partial<T>) => T} set
 * @property {(updater: (state: T) => T) => T} update
 * @property {(listener: (state: T) => void) => () => void} subscribe
 * @property {(fn: () => void) => void} batch
 */

/**
 * @template T
 * @param {T} initial
 * @returns {Store<T>}
 */
function createStore(initial) {
  /** @type {T} */
  let state = initial;
  /** @type {Set<(state: T) => void>} */
  const listeners = new Set();
  let scheduled = false;

  const flush = () => {
    scheduled = false;
    for (const listener of [...listeners]) {
      try {
        listener(state);
      } catch {
        // A broken subscriber must not take the store down.
      }
    }
  };

  const notify = () => {
    if (scheduled) return;
    scheduled = true;
    if (typeof queueMicrotask === 'function') queueMicrotask(flush);
    else Promise.resolve().then(flush);
  };

  return {
    get: () => state,
    select: (key) => state[key],
    set: (patch) => {
      state = { ...state, ...patch };
      notify();
      return state;
    },
    update: (updater) => {
      state = updater(state);
      notify();
      return state;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    batch: (fn) => {
      fn();
      notify();
    },
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { createStore };
if (typeof window !== 'undefined') {
  /** @type {any} */ (window).DSHStore = { createStore };
}
