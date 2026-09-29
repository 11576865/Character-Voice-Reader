const DB = "cvs-offline-library";
const BOOKS = "books";
const CLIPS = "clips";

function open() {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) return reject(new Error("此浏览器不支持离线书库。"));
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(BOOKS);
      request.result.createObjectStore(CLIPS);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function transaction(store, mode, operation) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = operation(tx.objectStore(store));
    tx.oncomplete = () => { db.close(); resolve(request.result); };
    tx.onerror = () => { db.close(); reject(tx.error || request.error); };
  });
}

const clipKey = (bookId, segmentId) => `${bookId}:${segmentId}`;

export class OfflineLibrary {
  getBook(id) { return transaction(BOOKS, "readonly", store => store.get(id)); }
  getClip(bookId, segmentId) {
    return transaction(CLIPS, "readonly", store => store.get(clipKey(bookId, segmentId)));
  }
  putBook(book) { return transaction(BOOKS, "readwrite", store => store.put(book, book.id)); }
  async updateBook(id, changes) {
    const current = await this.getBook(id);
    if (current) await this.putBook({ ...current, ...changes });
  }
  putClip(bookId, segmentId, audio) {
    return transaction(CLIPS, "readwrite", store => store.put(audio, clipKey(bookId, segmentId)));
  }
  listBooks() { return transaction(BOOKS, "readonly", store => store.getAll()); }

  async removeBook(id) {
    const book = await this.getBook(id);
    if (book) {
      for (const clip of book.manifest.clips) {
        await transaction(CLIPS, "readwrite", store => store.delete(clipKey(id, clip.segmentId)));
      }
    }
    await transaction(BOOKS, "readwrite", store => store.delete(id));
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
