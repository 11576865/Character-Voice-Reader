const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_ENTRY_BYTES = 20 * 1024 * 1024;
const MAX_ENTRIES = 5000;
const decoder = new TextDecoder("utf-8", { fatal: true });

function normalizePath(path) {
  const parts = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) throw new Error("EPUB 资源路径超出压缩包范围。");
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}

function resolveHref(basePath, href) {
  const cleanHref = href.split(/[?#]/, 1)[0];
  const decoded = decodeURIComponent(cleanHref);
  const directory = basePath.includes("/") ? basePath.slice(0, basePath.lastIndexOf("/") + 1) : "";
  return normalizePath(directory + decoded);
}

function findEndOfCentralDirectory(view) {
  const lowerBound = Math.max(0, view.byteLength - 65557);
  for (let offset = view.byteLength - 22; offset >= lowerBound; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50 &&
        offset + 22 + view.getUint16(offset + 20, true) === view.byteLength) {
      return offset;
    }
  }
  throw new Error("无法读取 EPUB ZIP 目录。");
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

class EpubArchive {
  constructor(buffer) {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength > MAX_ARCHIVE_BYTES) {
      throw new Error("EPUB 文件无效或超过 100 MB。 ");
    }
    this.buffer = buffer;
    this.view = new DataView(buffer);
    this.files = new Map();
    const end = findEndOfCentralDirectory(this.view);
    const count = this.view.getUint16(end + 10, true);
    const directorySize = this.view.getUint32(end + 12, true);
    const directoryOffset = this.view.getUint32(end + 16, true);
    if (this.view.getUint16(end + 4, true) !== 0 ||
        count !== this.view.getUint16(end + 8, true) ||
        count === 0xffff || directorySize === 0xffffffff ||
        directoryOffset === 0xffffffff || count > MAX_ENTRIES ||
        directoryOffset + directorySize > end) {
      throw new Error("不支持此 EPUB ZIP 目录结构。");
    }
    let offset = directoryOffset;
    for (let i = 0; i < count; i += 1) {
      if (offset + 46 > end || this.view.getUint32(offset, true) !== 0x02014b50) {
        throw new Error("EPUB ZIP 目录已损坏。");
      }
      const flags = this.view.getUint16(offset + 8, true);
      const method = this.view.getUint16(offset + 10, true);
      const checksum = this.view.getUint32(offset + 16, true);
      const compressedSize = this.view.getUint32(offset + 20, true);
      const uncompressedSize = this.view.getUint32(offset + 24, true);
      const nameLength = this.view.getUint16(offset + 28, true);
      const extraLength = this.view.getUint16(offset + 30, true);
      const commentLength = this.view.getUint16(offset + 32, true);
      const localOffset = this.view.getUint32(offset + 42, true);
      const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
      if (nextOffset > end || flags & 1 || ![0, 8].includes(method) ||
          compressedSize === 0xffffffff || uncompressedSize === 0xffffffff ||
          localOffset === 0xffffffff) {
        throw new Error("EPUB 包含不支持或过大的 ZIP 项。");
      }
      const name = decoder.decode(new Uint8Array(buffer, offset + 46, nameLength));
      const path = normalizePath(name);
      if (path && !name.endsWith("/")) {
        this.files.set(path, { method, checksum, compressedSize, uncompressedSize, localOffset });
      }
      offset = nextOffset;
    }
  }

  async readText(path) {
    const entry = this.files.get(normalizePath(path));
    if (!entry) throw new Error(`EPUB 缺少资源：${path}`);
    if (entry.compressedSize > MAX_ENTRY_BYTES || entry.uncompressedSize > MAX_ENTRY_BYTES) {
      throw new Error(`EPUB 文本资源超过 20 MB：${path}`);
    }
    const offset = entry.localOffset;
    const view = this.view;
    if (offset + 30 > view.byteLength || view.getUint32(offset, true) !== 0x04034b50) {
      throw new Error(`EPUB ZIP 项已损坏：${path}`);
    }
    const dataOffset = offset + 30 + view.getUint16(offset + 26, true) + view.getUint16(offset + 28, true);
    if (dataOffset + entry.compressedSize > view.byteLength) {
      throw new Error(`EPUB ZIP 项不完整：${path}`);
    }
    const bytes = new Uint8Array(this.buffer, dataOffset, entry.compressedSize);
    let plain;
    if (entry.method === 0) {
      plain = bytes;
    } else {
      if (typeof DecompressionStream === "undefined") {
        throw new Error("当前浏览器不支持 EPUB ZIP 解压。");
      }
      const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      const reader = stream.getReader();
      const chunks = [];
      let length = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > MAX_ENTRY_BYTES || length > entry.uncompressedSize) {
            await reader.cancel();
            throw new Error(`EPUB ZIP 项解压后过大：${path}`);
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      plain = new Uint8Array(length);
      let cursor = 0;
      for (const chunk of chunks) {
        plain.set(chunk, cursor);
        cursor += chunk.byteLength;
      }
    }
    if (plain.byteLength !== entry.uncompressedSize) {
      throw new Error(`EPUB ZIP 项大小不匹配：${path}`);
    }
    if (crc32(plain) !== entry.checksum) {
      throw new Error(`EPUB ZIP 项校验失败：${path}`);
    }
    return decoder.decode(plain);
  }
}

function parseXml(text, label, type = "application/xml") {
  const xml = new DOMParser().parseFromString(text, type);
  if (xml.getElementsByTagName("parsererror").length) {
    throw new Error(`EPUB ${label} XML 无效。`);
  }
  return xml;
}

function descendants(node, localName) {
  return Array.from(node.getElementsByTagName("*"))
    .filter(element => element.localName === localName);
}

function firstText(node, localName) {
  return descendants(node, localName)[0]?.textContent.trim() || "";
}

function cleanText(element) {
  const copy = element.cloneNode(true);
  for (const unwanted of copy.querySelectorAll("script, style, svg, math, rt, rp")) {
    unwanted.remove();
  }
  for (const br of copy.querySelectorAll("br")) br.replaceWith(" ");
  return copy.textContent.replace(/\s+/g, " ").trim();
}

function chapterFromXhtml(xml, fallbackTitle) {
  const body = descendants(xml, "body")[0];
  if (!body) return null;
  const heading = body.querySelector("h1, h2") || xml.querySelector("title");
  const title = (heading && cleanText(heading)) || fallbackTitle;
  const paragraphs = [];
  for (const element of body.querySelectorAll("p, li, h1, h2, h3, h4, blockquote, pre")) {
    if (["blockquote", "li"].includes(element.localName) && element.querySelector("p, li")) continue;
    const paragraph = cleanText(element);
    if (paragraph) paragraphs.push(paragraph);
  }
  if (!paragraphs.length) {
    const fallback = cleanText(body);
    if (fallback) paragraphs.push(fallback);
  }
  return paragraphs.length ? { title, paragraphs } : null;
}

export async function parseEpub(buffer, fallbackTitle = "EPUB 文档") {
  const archive = new EpubArchive(buffer);
  const container = parseXml(await archive.readText("META-INF/container.xml"), "container");
  const packagePath = descendants(container, "rootfile")[0]?.getAttribute("full-path");
  if (!packagePath) throw new Error("EPUB 缺少 OPF 包路径。");
  const packageXml = parseXml(await archive.readText(packagePath), "OPF");
  const metadata = descendants(packageXml, "metadata")[0];
  const title = (metadata && firstText(metadata, "title")) || fallbackTitle;
  const author = (metadata && firstText(metadata, "creator")) || "";
  const manifest = new Map();
  for (const item of descendants(packageXml, "item")) {
    manifest.set(item.getAttribute("id"), {
      href: item.getAttribute("href"),
      mediaType: item.getAttribute("media-type"),
      properties: item.getAttribute("properties") || ""
    });
  }
  const spine = descendants(packageXml, "spine")[0];
  if (!spine) throw new Error("EPUB 缺少阅读顺序 spine。");
  const chapters = [];
  for (const reference of descendants(spine, "itemref")) {
    if (reference.getAttribute("linear") === "no") continue;
    const item = manifest.get(reference.getAttribute("idref"));
    if (!item || !item.href) throw new Error("EPUB spine 引用了缺失资源。");
    if (item.mediaType !== "application/xhtml+xml" || item.properties.split(/\s+/).includes("nav")) continue;
    const xhtmlPath = resolveHref(packagePath, item.href);
    const xhtml = parseXml(await archive.readText(xhtmlPath), xhtmlPath, "application/xhtml+xml");
    const chapter = chapterFromXhtml(xhtml, item.href.split("/").at(-1));
    if (chapter) chapters.push(chapter);
  }
  if (!chapters.length) throw new Error("EPUB 没有可朗读的 XHTML 正文。");
  return {
    document: { title, chapters },
    metadata: { title, author }
  };
}

export async function readEpubFile(file, buffer = null) {
  if (!file || !/\.epub$/i.test(file.name)) throw new Error("请选择 .epub 文件。");
  if (file.size > MAX_ARCHIVE_BYTES) throw new Error("EPUB 文件超过 100 MB。 ");
  return parseEpub(buffer || await file.arrayBuffer(), file.name.replace(/\.epub$/i, ""));
}
