/**
 * chrome.storage.local async wrapper.
 *
 * All persistence in the extension goes through this module so there's a
 * single source of truth for how data is read/written. Handles the
 * availability check (storage may not exist in some dev contexts).
 */

const storageAvailable = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;

const Storage = {
  /**
   * Get one or more keys. Returns an object { key: value }.
   * If `keys` is a string, returns the single value (or undefined).
   */
  async get(keys) {
    if (!storageAvailable) return {};
    return new Promise((resolve) => {
      chrome.storage.local.get(keys, resolve);
    });
  },

  /**
   * Set one or more key-value pairs.
   */
  async set(items) {
    if (!storageAvailable) return;
    return new Promise((resolve) => {
      chrome.storage.local.set(items, resolve);
    });
  },

  /**
   * Remove one or more keys.
   */
  async remove(keys) {
    if (!storageAvailable) return;
    return new Promise((resolve) => {
      chrome.storage.local.remove(keys, resolve);
    });
  },

  /**
   * Get everything stored.
   */
  async getAll() {
    return this.get(null);
  }
};

if (typeof globalThis !== 'undefined') {
  globalThis.Storage = Storage;
}
