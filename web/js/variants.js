const DB_NAME = "character-voice-reader-variants";
const LEGACY_DB_NAME = "cvs-reader-variants";
const STORE = "paragraphs";

function openDatabase(name = DB_NAME, { create = true } = {}) {
  if (!globalThis.indexedDB) return Promise.resolve(null);
  return new Promise(resolve => {
    const request = indexedDB.open(name, 1);
    let createdLegacy = false;
    request.onupgradeneeded = () => {
      if (!create) {
        createdLegacy = true;
        request.transaction.abort();
        return;
      }
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => {
      if (createdLegacy) {
        request.result.close();
        resolve(null);
        return;
      }
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.close();
        resolve(null);
        return;
      }
      resolve(request.result);
    };
    request.onerror = () => {
      if (!create && (createdLegacy || request.error?.name === "AbortError")) {
        resolve(null);
      } else {
        resolve(null);
      }
    };
    request.onblocked = () => resolve(null);
  });
}

function readFrom(databasePromise, key) {
  return databasePromise.then(db => {
    if (!db) return undefined;
    return new Promise(resolve => {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(undefined);
    });
  });
}

export class VariantStore {
  constructor() {
    this.database = openDatabase();
    this.legacyDatabase = openDatabase(LEGACY_DB_NAME, { create: false });
    this.memory = new Map();
  }

  key(documentId, chapterIndex, paragraphIndex) {
    return `${documentId || "manual"}:${chapterIndex}:${paragraphIndex}`;
  }

  async read(key) {
    const current = await readFrom(this.database, key);
    if (current !== undefined) return current;

    const legacy = await readFrom(this.legacyDatabase, key);
    if (legacy !== undefined) {
      // Lazy copy-forward: a legacy value is promoted when first used.
      await this.write(key, legacy);
      return legacy;
    }
    return this.memory.get(key) || { selected: null, versions: [] };
  }

  async write(key, value) {
    this.memory.set(key, value);
    const db = await this.database;
    if (!db) return false;
    return new Promise(resolve => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
      tx.onabort = () => resolve(false);
    });
  }

  async add(key, clips, metadata) {
    const state = await this.read(key);
    const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const version = { id, createdAt: new Date().toISOString(),
      clips, metadata };
    state.versions.push(version);
    state.selected = version.id;
    while (state.versions.length > 7) {
      const oldest = state.versions.findIndex(item => item.id !== state.selected);
      if (oldest < 0) break;
      state.versions.splice(oldest, 1);
    }
    await this.write(key, state);
    return version;
  }

  async select(key, id) {
    const state = await this.read(key);
    if (!state.versions.some(item => item.id === id)) return false;
    state.selected = id;
    return this.write(key, state);
  }

  async clearSelection(key) {
    const state = await this.read(key);
    state.selected = null;
    return this.write(key, state);
  }

  async remove(key, id) {
    const state = await this.read(key);
    state.versions = state.versions.filter(item => item.id !== id);
    if (state.selected === id) state.selected = state.versions.at(-1)?.id || null;
    return this.write(key, state);
  }

  async selectedClip(key, offset, count) {
    const state = await this.read(key);
    const version = state.versions.find(item => item.id === state.selected);
    return version?.clips.length === count ? version.clips[offset] || null : null;
  }
}
