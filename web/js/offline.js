const DB = "character-voice-reader-offline";
const LEGACY_DB = "cvs-offline-library";
const BOOKS = "books";
const CLIPS = "clips";
// Keep a deletion marker in the new database while legacy records remain for rollback.
const isDeletedBook = book => book?.__cvrDeleted === true;

// Notify other tabs only after the deletion transaction commits. The
// announcement is an invalidation hint; receivers must never assume it
// replaces the persisted owner/tombstone checks.
const DELETION_CHANNEL = "cvr.offline-library-deletions-v1";
const DELETION_STORAGE_KEY = "cvr.offline-library-deletion-event";
const deletionSender = globalThis.crypto?.randomUUID?.() ||
  `reader-${Date.now()}-${Math.random()}`;

function validDeletionEvent(message) {
  return message?.type === "book-deleted" &&
    typeof message.bookId === "string" && message.bookId.length > 0 &&
    message.bookId.length <= 256 && message.sender !== deletionSender;
}

function publishOfflineBookDeletion(bookId) {
  const message = { type: "book-deleted", bookId, sender: deletionSender };
  if (typeof globalThis.BroadcastChannel === "function") {
    try {
      const channel = new BroadcastChannel(DELETION_CHANNEL);
      channel.postMessage(message);
      channel.close();
      return;
    } catch (_) { /* Attempt the storage-event fallback. */ }
  }
  try {
    globalThis.localStorage?.setItem(DELETION_STORAGE_KEY,
      JSON.stringify({ ...message, nonce: Math.random() }));
  } catch (_) { /* Notifications are best-effort; the committed tombstone wins. */ }
}

export function observeOfflineBookDeletions(onDeleted) {
  if (typeof globalThis.BroadcastChannel === "function") {
    try {
      const channel = new BroadcastChannel(DELETION_CHANNEL);
      channel.onmessage = event => {
        if (validDeletionEvent(event.data)) onDeleted(event.data.bookId);
      };
      return () => channel.close();
    } catch (_) { /* Fall back to the cross-tab storage event. */ }
  }
  if (typeof globalThis.addEventListener === "function") {
    const listener = event => {
      if (event.key !== DELETION_STORAGE_KEY || !event.newValue) return;
      try {
        const message = JSON.parse(event.newValue);
        if (validDeletionEvent(message)) onDeleted(message.bookId);
      } catch (_) { /* Ignore malformed or unrelated storage events. */ }
    };
    globalThis.addEventListener("storage", listener);
    return () => globalThis.removeEventListener("storage", listener);
  }
  return () => {};
}


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

// Atomically inspect the new record before copying an old one: a concurrent
// delete must never be undone by a migration that read the legacy DB earlier.
async function restoreLegacyBook(book) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BOOKS, "readwrite");
    const store = tx.objectStore(BOOKS);
    const existing = store.get(book.id);
    let selected = book;
    existing.onsuccess = () => {
      if (existing.result !== undefined) selected = existing.result;
      else store.put(book, book.id);
    };
    tx.oncomplete = () => { db.close(); resolve(isDeletedBook(selected) ? undefined : selected); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error); };
  });
}

const clipKey = (bookId, segmentId) => `${bookId}:${segmentId}`;

// Read authorization (live owner) and the media blob from one IndexedDB
// snapshot. A separate books transaction followed by a clips transaction
// could observe different revisions when another tab deletes the book.
async function readCurrentClipWithOwner(bookId, segmentId) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([BOOKS, CLIPS], "readonly");
    const request = tx.objectStore(BOOKS).get(bookId);
    let owner;
    let clip;
    request.onsuccess = () => {
      owner = request.result;
      if (owner && !isDeletedBook(owner)) {
        const media = tx.objectStore(CLIPS).get(clipKey(bookId, segmentId));
        media.onsuccess = () => { clip = media.result; };
      }
    };
    tx.oncomplete = () => { db.close(); resolve({ owner, clip }); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error); };
  });
}

function offlineAbort(message = "离线下载已取消。") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function assertActive(signal) {
  if (signal?.aborted) throw offlineAbort();
}

// All asynchronous download writes are committed behind the persisted owner
// token. A delete, newer download, or another tab can invalidate an older run.
async function ownedDownloadWrite(bookId, token, { book, clipId, audio, signal } = {}) {
  assertActive(signal);
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([BOOKS, CLIPS], "readwrite");
    const books = tx.objectStore(BOOKS);
    const clips = tx.objectStore(CLIPS);
    const request = books.get(bookId);
    let written = false;
    request.onsuccess = () => {
      const current = request.result;
      if (signal?.aborted || !current || isDeletedBook(current) ||
          current.__cvrDownloadToken !== token) return;
      if (clipId != null) clips.put(audio, clipKey(bookId, clipId));
      books.put(book, bookId);
      written = true;
    };
    tx.oncomplete = () => { db.close(); resolve(written); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error); };
  });
}

async function beginDownload(book, manifest, token, previous, signal) {
  assertActive(signal);
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BOOKS, "readwrite");
    const store = tx.objectStore(BOOKS);
    const request = store.get(book.id);
    let saved = null;
    request.onsuccess = () => {
      if (signal?.aborted) return;
      const current = request.result;
      const annotated = current && !isDeletedBook(current)
        ? current : previous;
      saved = { ...book, manifest, ready: false, downloaded: 0,
        annotations: annotated?.pendingAnnotationsAt ? annotated.annotations : book.annotations,
        annotationsUpdatedAt: annotated?.pendingAnnotationsAt
          ? annotated.annotationsUpdatedAt : book.annotationsUpdatedAt,
        pendingAnnotationsAt: annotated?.pendingAnnotationsAt || null,
        __cvrDownloadToken: token };
      store.put(saved, book.id);
    };
    tx.oncomplete = () => { db.close(); resolve(saved); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error); };
  });
}

async function writeClipIfLive(bookId, segmentId, audio) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([BOOKS, CLIPS], "readwrite");
    const store = tx.objectStore(BOOKS);
    const request = store.get(bookId);
    let allowed = false;
    request.onsuccess = () => {
      if (request.result && !isDeletedBook(request.result)) {
        tx.objectStore(CLIPS).put(audio, clipKey(bookId, segmentId));
        allowed = true;
      }
    };
    tx.oncomplete = () => { db.close(); resolve(allowed); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error); };
  });
}


export class OfflineLibrary {
  async getBook(id) {
    let book = await transaction(BOOKS, "readonly", store => store.get(id));
    if (book !== undefined) return isDeletedBook(book) ? undefined : book;
    book = await transaction(BOOKS, "readonly", store => store.get(id), { legacy: true });
    return book === undefined ? undefined : restoreLegacyBook(book);
  }

  async getClip(bookId, segmentId) {
    // Clip authorization and current audio must use the same transaction.
    // A legacy clip-first read may lazily restore its owning book; then take
    // a fresh atomic snapshot before reading the current clip.
    let { owner, clip } = await readCurrentClipWithOwner(bookId, segmentId);
    if (isDeletedBook(owner)) return undefined;
    if (owner === undefined) {
      if (!await this.getBook(bookId)) return undefined;
      ({ owner, clip } = await readCurrentClipWithOwner(bookId, segmentId));
      if (!owner || isDeletedBook(owner)) return undefined;
    }
    if (clip !== undefined) return clip;

    const legacy = await transaction(CLIPS, "readonly",
      store => store.get(clipKey(bookId, segmentId)), { legacy: true });
    if (legacy !== undefined) {
      // Its own readwrite transaction verifies the owner again: a delete
      // occurring during legacy I/O may not revive the removed audio.
      return (await writeClipIfLive(bookId, segmentId, legacy)) ? legacy : undefined;
    }
    return undefined;
  }

  putBook(book) {
    return transaction(BOOKS, "readwrite", store => store.put(book, book.id));
  }

  async updateBook(id, changes) {
    // Read/merge/write in one transaction, not with an awaited stale getBook().
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(BOOKS, "readwrite");
      const store = tx.objectStore(BOOKS);
      const request = store.get(id);
      request.onsuccess = () => {
        if (request.result && !isDeletedBook(request.result)) {
          store.put({ ...request.result, ...changes, id }, id);
        }
      };
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    });
  }

  putClip(bookId, segmentId, audio) {
    return writeClipIfLive(bookId, segmentId, audio);
  }

  async listBooks() {
    const current = await transaction(BOOKS, "readonly", store => store.getAll()) || [];
    const legacy = await transaction(BOOKS, "readonly", store => store.getAll(), { legacy: true }) || [];
    const removedIds = new Set(current.filter(isDeletedBook).map(book => book.id));
    const byId = new Map(current.filter(book => !isDeletedBook(book)).map(book => [book.id, book]));
    for (const book of legacy) {
      if (!byId.has(book.id) && !removedIds.has(book.id)) {
        const restored = await restoreLegacyBook(book);
        if (restored) byId.set(book.id, restored);
      }
    }
    return [...byId.values()];
  }

  async removeBook(id) {
    const db = await openDatabase();
    await new Promise((resolve, reject) => {
      const tx = db.transaction([BOOKS, CLIPS], "readwrite");
      const clips = tx.objectStore(CLIPS);
      // The current manifest may have dropped segment IDs from an older
      // download. Purge every persisted clip for this book, not just the
      // segment IDs in its most recent manifest. One transaction fences
      // concurrent downloads and prevents partially completed deletions.
      tx.objectStore(BOOKS).put({ id, __cvrDeleted: true }, id);
      const prefix = `${id}:`;
      const keys = clips.getAllKeys();
      keys.onsuccess = () => {
        for (const key of keys.result) {
          if (typeof key === "string" && key.startsWith(prefix)) {
            clips.delete(key);
          }
        }
      };
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    });
    // The tombstone and audio purge are committed before any other tab is
    // asked to stop using its previously acquired media Blob.
    publishOfflineBookDeletion(id);
    // Legacy DB remains untouched for rollback; the tombstone blocks re-import.
  }

  async download(manifest, fetchAudio, onProgress = () => {}, { signal } = {}) {
    if (!globalThis.crypto?.subtle || !globalThis.crypto?.randomUUID) {
      throw new Error("音频校验需要 HTTPS 或 localhost。");
    }
    assertActive(signal);
    const book = manifest.book;
    const expected = manifest.clips;
    const token = crypto.randomUUID();
    const previous = await this.getBook(book.id);
    const saved = await beginDownload(book, manifest, token, previous, signal);
    if (!saved) throw offlineAbort();

    const digest = async blob => {
      const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
      return [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, "0")).join("");
    };

    for (const [index, clip] of expected.entries()) {
      assertActive(signal);
      let audio = await this.getClip(book.id, clip.segmentId);
      if (!audio || audio.size !== clip.bytes || await digest(audio) !== clip.sha256) {
        assertActive(signal);
        audio = await fetchAudio(clip.segmentId, { signal });
      }
      assertActive(signal);
      if (audio.size !== clip.bytes) throw new Error(`音频大小不匹配：${clip.segmentId}`);
      if (await digest(audio) !== clip.sha256) throw new Error(`音频校验失败：${clip.segmentId}`);
      assertActive(signal);
      saved.downloaded = index + 1;
      if (!await ownedDownloadWrite(book.id, token, {
        book: { ...saved }, clipId: clip.segmentId, audio, signal
      })) {
        throw offlineAbort("离线下载已被删除或更新的任务取代。");
      }
      onProgress(index + 1, expected.length);
    }

    assertActive(signal);
    saved.ready = true;
    if (!await ownedDownloadWrite(book.id, token, { book: { ...saved }, signal })) {
      throw offlineAbort("离线下载已被删除或更新的任务取代。");
    }
    return saved;
  }
}
