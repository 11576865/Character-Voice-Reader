import assert from "node:assert/strict";
import { OfflineLibrary } from "../web/js/offline.js";

// Minimal asynchronous IndexedDB substitute for storage/migration regressions.
// Transactions execute requests in order; an onsuccess handler can enqueue writes.
function memoryIndexedDB() {
  const databases = new Map();

  class MemoryTransaction {
    constructor(db, storeName) {
      this.db = db;
      this.storeNames = Array.isArray(storeName) ? storeName : [storeName];
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
      assert.ok(this.storeNames.includes(name));
      const store = this.db.stores.get(name);
      assert.ok(store, "missing IndexedDB object store " + name);
      return {
        get: key => this.request(() => store.get(key)),
        getAll: () => this.request(() => [...store.values()]),
        getAllKeys: () => this.request(() => [...store.keys()]),
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
        const newlyCreated = !db;
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
          // Aborted versionchange must roll back a newly created database.
          if (newlyCreated) databases.delete(name);
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

async function testFirstClipAccessMigratesItsLegacyOwner() {
  const indexedDB = memoryIndexedDB();
  globalThis.indexedDB = indexedDB;
  const library = new OfflineLibrary();
  const book = {
    id: "b-" + "c".repeat(24), title: "Legacy without listing",
    manifest: { clips: [{ segmentId: "segment-1" }] }
  };
  await seedLegacyBook(indexedDB, book, { size: 321 });

  // A clip lookup must work before the first getBook()/listBooks() call.
  assert.equal((await library.getClip(book.id, "segment-1"))?.size, 321,
    "clip-first reads must lazily migrate their legacy owning book");
  const current = indexedDB.databases.get("character-voice-reader-offline");
  assert.equal(current.stores.get("books").get(book.id).title, book.title);
  assert.equal(current.stores.get("clips").get(book.id + ":segment-1").size, 321);
  assert.equal((await library.getBook(book.id)).title, book.title);

  await library.removeBook(book.id);
  assert.equal(await library.getClip(book.id, "segment-1"), undefined,
    "deletion tombstone must still prevent a second lazy migration");
  assert.equal(current.stores.get("clips").has(book.id + ":segment-1"), false);
  assert.equal(current.stores.get("books").get(book.id).__cvrDeleted, true);
  assert.equal(indexedDB.databases.get("cvs-offline-library")
    .stores.get("clips").has(book.id + ":segment-1"), true,
    "rollback-compatible legacy data remains untouched");
}

async function testClipFirstAccessDoesNotImportLegacyOrphans() {
  const indexedDB = memoryIndexedDB();
  globalThis.indexedDB = indexedDB;
  const library = new OfflineLibrary();
  const legacyBook = {
    id: "b-" + "d".repeat(24), title: "Formerly owned",
    manifest: { clips: [{ segmentId: "segment-1" }] }
  };
  await seedLegacyBook(indexedDB, legacyBook, { size: 4 });
  const legacyStore = indexedDB.databases.get("cvs-offline-library").stores.get("books");
  legacyStore.delete(legacyBook.id); // orphaned legacy clip with no owning book

  assert.equal(await library.getClip(legacyBook.id, "segment-1"), undefined,
    "a standalone legacy clip may not be copied to a missing book");
  const current = indexedDB.databases.get("character-voice-reader-offline");
  assert.equal(current.stores.get("clips").has(legacyBook.id + ":segment-1"), false);
  assert.equal(current.stores.get("books").has(legacyBook.id), false);
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


function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function clipFixture(contents = ["first", "second"]) {
  const chunks = contents.map(text => new Blob([text]));
  const clips = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const hash = await crypto.subtle.digest("SHA-256", await chunks[index].arrayBuffer());
    clips.push({
      segmentId: `segment-${index + 1}`,
      bytes: chunks[index].size,
      sha256: [...new Uint8Array(hash)].map(value => value.toString(16).padStart(2, "0")).join("")
    });
  }
  return { chunks, clips };
}

function downloadManifest(bookId, clips) {
  return {
    book: { id: bookId, title: "Download lifecycle", kind: "epub", segments: [] },
    clips
  };
}

async function testLateDownloadDoesNotUndoDeletion() {
  globalThis.indexedDB = memoryIndexedDB();
  const library = new OfflineLibrary();
  const { chunks, clips } = await clipFixture();
  const second = deferred();
  const manifest = downloadManifest("in-flight-delete", clips);
  const waitingOnSecond = deferred();
  const task = library.download(manifest, async segmentId => {
    if (segmentId === "segment-1") return chunks[0];
    waitingOnSecond.resolve();
    return second.promise;
  });
  await waitingOnSecond.promise;
  assert.equal((await library.getBook(manifest.book.id)).downloaded, 1);
  await library.removeBook(manifest.book.id);
  second.resolve(chunks[1]);
  await assert.rejects(task, { name: "AbortError" });
  assert.equal(await library.getBook(manifest.book.id), undefined);
  assert.equal(await library.getClip(manifest.book.id, "segment-1"), undefined);
  assert.equal(await library.getClip(manifest.book.id, "segment-2"), undefined);
  assert.deepEqual(await library.listBooks(), []);
}

async function testNewDownloadSupersedesOlderWriter() {
  globalThis.indexedDB = memoryIndexedDB();
  const library = new OfflineLibrary();
  const { chunks, clips } = await clipFixture(["old", "new"]);
  // Two valid manifests for the same ID but different audio hashes.
  const older = downloadManifest("overlap", [clips[0]]);
  const newer = downloadManifest("overlap", [clips[1]]);
  const firstRequest = deferred();
  const firstWaiting = deferred();
  const first = library.download(older, async () => {
    firstWaiting.resolve();
    return firstRequest.promise;
  });
  await firstWaiting.promise;
  const replacement = await library.download(newer, async () => chunks[1]);
  assert.equal(replacement.ready, true);
  firstRequest.resolve(chunks[0]);
  await assert.rejects(first, { name: "AbortError" });
  assert.equal((await library.getBook(newer.book.id)).ready, true);
  assert.equal((await library.getClip(newer.book.id, "segment-2")).size, chunks[1].size);
  assert.equal(await library.getClip(newer.book.id, "segment-1"), undefined);
}

async function testCancelAndResumePreservePartialProgress() {
  globalThis.indexedDB = memoryIndexedDB();
  const library = new OfflineLibrary();
  const { chunks, clips } = await clipFixture();
  const manifest = downloadManifest("cancel-retry", clips);
  const controller = new AbortController();
  const next = deferred();
  const enteredSecond = deferred();
  const task = library.download(manifest, async segmentId => {
    if (segmentId === "segment-1") return chunks[0];
    enteredSecond.resolve();
    return next.promise; // Simulates an upstream that ignores AbortSignal.
  }, () => {}, { signal: controller.signal });
  await enteredSecond.promise;
  controller.abort();
  next.resolve(chunks[1]);
  await assert.rejects(task, { name: "AbortError" });
  const partial = await library.getBook(manifest.book.id);
  assert.equal(partial.ready, false);
  assert.equal(partial.downloaded, 1);
  const requested = [];
  const finished = await library.download(manifest, async segmentId => {
    requested.push(segmentId);
    return chunks[1];
  });
  assert.deepEqual(requested, ["segment-2"],
    "valid first clip should be reused without downloading it again");
  assert.equal(finished.downloaded, 2);
  assert.equal(finished.ready, true);
}

async function testDeletePurgesOrphanedAudioFromPriorManifest() {
  const indexedDB = memoryIndexedDB();
  globalThis.indexedDB = indexedDB;
  const library = new OfflineLibrary();
  const id = "b-" + "a".repeat(24);
  const neighbor = "b-" + "a".repeat(23) + "b";
  const clipA = { segmentId: "old-segment" };
  const clipB = { segmentId: "new-segment" };

  await library.putBook({
    id, title: "Old manifest",
    manifest: { clips: [clipA] }
  });
  await library.putClip(id, clipA.segmentId, { size: 10 });
  await library.putBook({
    id, title: "New manifest",
    manifest: { clips: [clipB] }
  });
  await library.putClip(id, clipB.segmentId, { size: 20 });
  await library.putBook({
    id: neighbor, title: "Different book",
    manifest: { clips: [{ segmentId: "keep" }] }
  });
  await library.putClip(neighbor, "keep", { size: 30 });

  const raw = indexedDB.databases.get("character-voice-reader-offline").stores.get("clips");
  assert.equal(raw.has(id + ":old-segment"), true, "prior manifest clip must exist before deletion");
  await library.removeBook(id);
  assert.equal(raw.has(id + ":old-segment"), false, "orphan clip must be physically deleted");
  assert.equal(raw.has(id + ":new-segment"), false, "current manifest clip must be deleted");
  assert.equal(raw.has(neighbor + ":keep"), true, "another book's audio must remain untouched");
  assert.equal((await library.getClip(neighbor, "keep")).size, 30);
  assert.equal(await library.getBook(id), undefined);
  await library.removeBook(id);
  assert.equal(raw.has(neighbor + ":keep"), true, "repeated deletion must not affect other books");
}

await testFirstClipAccessMigratesItsLegacyOwner();
await testClipFirstAccessDoesNotImportLegacyOrphans();
await testDeletedLegacyBookDoesNotResurrect();
await testDeleteBeforeInitialListing();
await testDeletePurgesOrphanedAudioFromPriorManifest();
await testLateDownloadDoesNotUndoDeletion();
await testNewDownloadSupersedesOlderWriter();
await testCancelAndResumePreservePartialProgress();
console.log("PASS: Reader offline migration and download lifecycle regressions");
