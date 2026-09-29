export const PROGRESS_KEY_PREFIX = "cvs.reader.progress.v1:";
const VERSION = 1;

// Two independent 32-bit rolling hashes keep IDs stable on HTTP LAN pages,
// where Web Crypto's subtle API may be unavailable.
export function documentIdForFile(buffer, kind) {
  if (!(buffer instanceof ArrayBuffer) || !["txt", "epub", "md", "docx"].includes(kind)) {
    throw new Error("无法为此文件生成文档 ID。");
  }
  const bytes = new Uint8Array(buffer);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let i = 0; i < bytes.length; i += 1) {
    first = Math.imul(first ^ bytes[i], 0x01000193);
    second = Math.imul(second ^ (bytes[i] + (i & 255)), 0x5bd1e995);
  }
  const hex = value => (value >>> 0).toString(16).padStart(8, "0");
  return `file:${kind}:${bytes.length}:${hex(first)}${hex(second)}`;
}

function usableStorage(storage) {
  try {
    const key = `${PROGRESS_KEY_PREFIX}probe`;
    storage.setItem(key, "1");
    storage.removeItem(key);
    return true;
  } catch (_) {
    return false;
  }
}

export class ProgressStore {
  constructor(storage) {
    if (storage === undefined) {
      try { storage = globalThis.localStorage; }
      catch (_) { storage = null; }
    }
    this.storage = storage;
    this.available = Boolean(storage && usableStorage(storage));
    this.memory = new Map();
  }

  save({ documentId, title, chapterIndex, segmentIndex, audioTime }) {
    if (!documentId || !Number.isInteger(chapterIndex) || chapterIndex < 0 ||
        !Number.isInteger(segmentIndex) || segmentIndex < 0) return false;
    const record = {
      version: VERSION,
      documentId,
      title: String(title || ""),
      chapterIndex,
      segmentIndex,
      audioTime: Number.isFinite(audioTime) && audioTime >= 0 ? audioTime : 0,
      updatedAt: new Date().toISOString()
    };
    const key = PROGRESS_KEY_PREFIX + documentId;
    this.memory.set(key, record);
    if (!this.available) return false;
    try {
      this.storage.setItem(key, JSON.stringify(record));
      return true;
    } catch (_) {
      this.available = false;
      return false;
    }
  }

  load(documentId, document, segments) {
    if (!documentId || !Array.isArray(segments) || !segments.length) return null;
    const key = PROGRESS_KEY_PREFIX + documentId;
    let raw = null;
    if (this.available) {
      try { raw = this.storage.getItem(key); }
      catch (_) { this.available = false; }
    }
    const fallback = this.memory.get(key);
    let record;
    try { record = raw === null ? fallback : JSON.parse(raw); }
    catch (_) { return null; }
    if (!record || record.version !== VERSION || record.documentId !== documentId ||
        !Number.isInteger(record.chapterIndex) || !Number.isInteger(record.segmentIndex)) {
      return null;
    }
    let index = record.segmentIndex;
    if (index < 0 || index >= segments.length) {
      index = segments.findIndex(segment => segment.chapterIndex === record.chapterIndex);
      if (index < 0) index = 0;
    }
    const changedPosition = index !== record.segmentIndex;
    const segment = segments[index];
    const audioTime = !changedPosition && Number.isFinite(record.audioTime) && record.audioTime >= 0
      ? record.audioTime : 0;
    return {
      documentId,
      title: document.title,
      chapterIndex: segment.chapterIndex,
      segmentIndex: index,
      audioTime,
      updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : ""
    };
  }
}
