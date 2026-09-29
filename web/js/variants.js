const DB_NAME = "cvs-reader-variants";
const STORE = "paragraphs";

function openDatabase() {
  if (!globalThis.indexedDB) return Promise.resolve(null);
  return new Promise(resolve => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

export class VariantStore {
  constructor() {
    this.database = openDatabase();
    this.memory = new Map();
  }

  key(documentId, chapterIndex, paragraphIndex) {
    return `${documentId || "manual"}:${chapterIndex}:${paragraphIndex}`;
  }

  async read(key) {
    const db = await this.database;
    if (!db) return this.memory.get(key) || { selected: null, versions: [] };
    return new Promise(resolve => {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      request.onsuccess = () => resolve(request.result || { selected: null, versions: [] });
      request.onerror = () => resolve(this.memory.get(key) || { selected: null, versions: [] });
    });
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
