const DB = "character-voice-reader-offline";
const LEGACY_DB = "cvs-offline-library";
const BOOKS = "books";
const CLIPS = "clips";

function openDatabase(name = DB, { create = true } = {}) {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) return reject(new Error("此浏览器不支持离线书库。"));
    const request = indexedDB.open(name, 1);
    let createdLegacy = false;
    request.onupgradeneeded = () => {
      if (!create) {
        createdLegacy = true;
        request.transaction.abort();
        return;
      }
      if (!request.result.objectStoreNames.contains(BOOKS)) {
        request.result.createObjectStore(BOOKS);
      }
      if (!request.result.objectStoreNames.contains(CLIPS)) {
        request.result.createObjectStore(CLIPS);
      }
    };
    request.onsuccess = () => {
      if (createdLegacy) {
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
        reject(request.error);
      }
    };
  });
}

async function transaction(store, mode, operation, { legacy = false } = {}) {
  const db = await openDatabase(legacy ? LEGACY_DB : DB, { create: !legacy });
  if (!db) return undefined;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = operation(tx.objectStore(store));
    tx.oncomplete = () => { db.close(); resolve(request.result); };
    tx.onerror = () => { db.close(); reject(tx.error || request.error); };
    tx.onabort = () => { db.close(); reject(tx.error || request.error); };
  });
}

const clipKey = (bookId, segmentId) => `${bookId}:${segmentId}`;

export class OfflineLibrary {
  async getBook(id) {
    let book = await transaction(BOOKS, "readonly", store => store.get(id));
    if (book !== undefined) return book;
    book = await transaction(BOOKS, "readonly", store => store.get(id), { legacy: true });
    if (book !== undefined) await this.putBook(book);
    return book;
  }

  async getClip(bookId, segmentId) {
    const key = clipKey(bookId, segmentId);
    let clip = await transaction(CLIPS, "readonly", store => store.get(key));
    if (clip !== undefined) return clip;
    clip = await transaction(CLIPS, "readonly", store => store.get(key), { legacy: true });
    if (clip !== undefined) await this.putClip(bookId, segmentId, clip);
    return clip;
  }

  putBook(book) {
    return transaction(BOOKS, "readwrite", store => store.put(book, book.id));
  }

  async updateBook(id, changes) {
    const current = await this.getBook(id);
    if (current) await this.putBook({ ...current, ...changes });
  }

  putClip(bookId, segmentId, audio) {
    return transaction(CLIPS, "readwrite", store => store.put(audio, clipKey(bookId, segmentId)));
  }

  async listBooks() {
    const current = await transaction(BOOKS, "readonly", store => store.getAll()) || [];
    const legacy = await transaction(BOOKS, "readonly", store => store.getAll(), { legacy: true }) || [];
    const byId = new Map(current.map(book => [book.id, book]));
    for (const book of legacy) {
      if (!byId.has(book.id)) {
        byId.set(book.id, book);
        await this.putBook(book);
      }
    }
    return [...byId.values()];
  }

  async removeBook(id) {
    const book = await this.getBook(id);
    if (book) {
      for (const clip of book.manifest.clips) {
        await transaction(CLIPS, "readwrite", store => store.delete(clipKey(id, clip.segmentId)));
      }
    }
    await transaction(BOOKS, "readwrite", store => store.delete(id));
    // Legacy DB is intentionally left intact during the migration window.
  }

  async download(manifest, fetchAudio, onProgress = () => {}) {
    if (!globalThis.crypto?.subtle) throw new Error("音频校验需要 HTTPS 或 localhost。 ");
    const book = manifest.book;
    const expected = manifest.clips;
    const previous = await this.getBook(book.id);
    const saved = { ...book, manifest, ready: false, downloaded: 0,
      annotations: previous?.pendingAnnotationsAt ? previous.annotations : book.annotations,
      annotationsUpdatedAt: previous?.pendingAnnotationsAt ? previous.annotationsUpdatedAt : book.annotationsUpdatedAt,
      pendingAnnotationsAt: previous?.pendingAnnotationsAt || null };
    await this.putBook(saved);
    for (const [index, clip] of expected.entries()) {
      let audio = await this.getClip(book.id, clip.segmentId);
      const digest = async blob => {
        const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
        return [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, "0")).join("");
      };
      if (!audio || audio.size !== clip.bytes || await digest(audio) !== clip.sha256) {
        audio = await fetchAudio(clip.segmentId);
      }
      if (audio.size !== clip.bytes) throw new Error(`音频大小不匹配：${clip.segmentId}`);
      if (await digest(audio) !== clip.sha256) throw new Error(`音频校验失败：${clip.segmentId}`);
      await this.putClip(book.id, clip.segmentId, audio);
      saved.downloaded = index + 1;
      await this.putBook(saved);
      onProgress(index + 1, expected.length);
    }
    saved.ready = true;
    await this.putBook(saved);
    return saved;
  }
}
