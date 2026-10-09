import assert from "node:assert/strict";
import { OfflineLibrary } from "../web/js/offline.js";

// Minimal asynchronous IndexedDB substitute for storage/migration regressions.
// Transactions execute requests in order; an onsuccess handler can enqueue writes.
function memoryIndexedDB() {
  const databases = new Map();

  class MemoryTransaction {
    constructor(db, storeName) {
      this.db = db;
      this.storeName = storeName;
      this.pending = 0;
      this.completed = false;
      this.error = null;
      this.oncomplete = null;
      this.onerror = null;
      this.onabort = null;
    }
    request(operation) {
      this.pending += 1;
      const request = { result: undefined, error: null, onsuccess: null, onerror: null };
      queueMicrotask(() => {
        try {
          request.result = operation();
          request.onsuccess?.();
        } catch (error) {
          request.error = error;
          this.error = error;
          request.onerror?.();
          this.onerror?.();
        } finally {
          this.pending -= 1;
          queueMicrotask(() => {
            if (this.pending === 0 && !this.completed && !this.error) {
              this.completed = true;
              this.oncomplete?.();
            }
          });
        }
      });
      return request;
    }
    objectStore(name) {
      assert.equal(name, this.storeName);
      const store = this.db.stores.get(name);
      assert.ok(store, "missing IndexedDB object store " + name);
      return {
        get: key => this.request(() => store.get(key)),
        getAll: () => this.request(() => [...store.values()]),
        put: (value, key) => this.request(() => { store.set(key, value); return key; }),
        delete: key => this.request(() => { store.delete(key); })
      };
    }
  }

  class MemoryDB {
    constructor(name, version) {
      this.name = name;
      this.version = version;
      this.stores = new Map();
      this.objectStoreNames = { contains: name => this.stores.has(name) };
    }
    createObjectStore(name) {
      this.stores.set(name, new Map());
    }
    transaction(name) {
      return new MemoryTransaction(this, name);
    }
    close() {}
  }

  return {
    databases,
    open(name, version = 1) {
      const request = {
        result: null,
        error: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null
      };
      queueMicrotask(() => {
        let db = databases.get(name);
        const needsUpgrade = !db || version > db.version;
        if (!db) {
          db = new MemoryDB(name, version);
          databases.set(name, db);
        }
        request.result = db;
        let aborted = false;
        request.transaction = { abort() { aborted = true; } };
        if (needsUpgrade) request.onupgradeneeded?.();
        if (aborted) {
          request.error = { name: "AbortError" };
          request.onerror?.();
        } else {
          db.version = version;
          request.onsuccess?.();
        }
      });
      return request;
    }
  };
}

async function seedLegacyBook(indexedDB, book, clip) {
  const open = indexedDB.open("cvs-offline-library", 1);
  open.onupgradeneeded = () => {
    open.result.createObjectStore("books");
    open.result.createObjectStore("clips");
  };
  await new Promise((resolve, reject) => {
    open.onsuccess = resolve;
    open.onerror = reject;
  });
  const tx = open.result.transaction("books", "readwrite");
  tx.objectStore("books").put(book, book.id);
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = reject;
  });
  const clips = open.result.transaction("clips", "readwrite");
  clips.objectStore("clips").put(clip, book.id + ":segment-1");
  await new Promise((resolve, reject) => {
    clips.oncomplete = resolve;
    clips.onerror = reject;
  });
}

async function testDeletedLegacyBookDoesNotResurrect() {
  const indexedDB = memoryIndexedDB();
  globalThis.indexedDB = indexedDB;
  const library = new OfflineLibrary();
  const book = {
    id: "old-book", title: "Archived book",
    manifest: { clips: [{ segmentId: "segment-1" }] }
  };
  const clip = { size: 123 };
  await seedLegacyBook(indexedDB, book, clip);

  assert.equal((await library.getBook(book.id)).title, book.title);
  assert.equal((await library.getClip(book.id, "segment-1")).size, 123);
  assert.deepEqual((await library.listBooks()).map(item => item.id), [book.id]);

  await library.removeBook(book.id);
  assert.equal(await library.getBook(book.id), undefined);
  assert.equal(await library.getClip(book.id, "segment-1"), undefined);
  assert.deepEqual(await library.listBooks(), []);
  assert.deepEqual(await library.listBooks(), [], "listing must not restore deleted legacy books");

  const legacy = indexedDB.databases.get("cvs-offline-library");
  assert.equal(legacy.stores.get("books").get(book.id).title, book.title,
    "rollback-compatible old database must remain untouched");

  await library.putBook(book);
  assert.equal((await library.getBook(book.id)).title, book.title,
    "an explicit re-add should replace the tombstone");
  assert.deepEqual((await library.listBooks()).map(item => item.id), [book.id]);
}

async function testDeleteBeforeInitialListing() {
  const indexedDB = memoryIndexedDB();
  globalThis.indexedDB = indexedDB;
  const library = new OfflineLibrary();
  const book = {
    id: "unlisted-book", title: "Unlisted",
    manifest: { clips: [{ segmentId: "segment-1" }] }
  };
  await seedLegacyBook(indexedDB, book, { size: 1 });
  await library.removeBook(book.id);
  assert.deepEqual(await library.listBooks(), []);
  assert.equal(await library.getBook(book.id), undefined);
  assert.equal(await library.getClip(book.id, "segment-1"), undefined);
}

await testDeletedLegacyBookDoesNotResurrect();
await testDeleteBeforeInitialListing();
console.log("PASS: Reader offline library deletion/migration regressions");
