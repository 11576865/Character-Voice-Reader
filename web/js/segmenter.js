const OPEN_TO_CLOSE = new Map([
  ["(", ")"], ["（", "）"], ["[", "]"], ["【", "】"],
  ["{", "}"], ["“", "”"], ["‘", "’"], ["「", "」"], ["『", "』"], ["\"", "\""]
]);
const QUOTES = new Set(["“", "‘", "「", "『", "\""]);
const SENTENCE_END = new Set(["。", "！", "？", ".", "!", "?"]);
const SOFT_BREAK = new Set(["，", ",", "；", ";", "：", ":", "、"]);

function sentenceRanges(text) {
  const ranges = [];
  const stack = [];
  let start = 0;
  let pendingEnd = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (stack.at(-1)?.close === char) {
      stack.pop();
    } else if (OPEN_TO_CLOSE.has(char)) {
      stack.push({ close: OPEN_TO_CLOSE.get(char), quote: QUOTES.has(char) });
    }

    // A decimal point is not the end of a sentence.
    const decimal = char === "." && /\d/.test(text[i - 1] || "") && /\d/.test(text[i + 1] || "");
    if (SENTENCE_END.has(char) && !decimal && stack.every(entry => entry.quote)) pendingEnd = true;
    if (pendingEnd && stack.length === 0 && !SENTENCE_END.has(text[i + 1])) {
      ranges.push([start, i + 1]);
      start = i + 1;
      pendingEnd = false;
    }
  }
  if (start < text.length) ranges.push([start, text.length]);
  return ranges;
}

function safeBreaks(text, start, end) {
  const breaks = [];
  const stack = [];
  for (let i = start; i < end; i += 1) {
    const char = text[i];
    if (stack.at(-1)?.close === char) stack.pop();
    else if (OPEN_TO_CLOSE.has(char)) stack.push({ close: OPEN_TO_CLOSE.get(char) });
    if (stack.length === 0 && (SOFT_BREAK.has(char) || /\s/.test(char))) {
      breaks.push(i + 1);
    }
  }
  return breaks;
}

function splitLongRange(text, start, end, maxChars) {
  const parts = [];
  let cursor = start;
  while (end - cursor > maxChars) {
    const candidates = safeBreaks(text, cursor, end);
    const preferred = candidates.filter(position => position <= cursor + maxChars).at(-1);
    const boundary = preferred || candidates.find(position => position > cursor + maxChars);
    if (!boundary) break; // Keep an unbroken quote, bracket, or word intact.
    parts.push([cursor, boundary]);
    cursor = boundary;
  }
  if (cursor < end) parts.push([cursor, end]);
  return parts;
}

function paragraphRanges(text, maxChars) {
  const sentences = sentenceRanges(text);
  const ranges = [];
  let pendingStart = null;
  let pendingEnd = null;
  for (const [start, end] of sentences) {
    if (end - start > maxChars) {
      if (pendingStart !== null) ranges.push([pendingStart, pendingEnd]);
      ranges.push(...splitLongRange(text, start, end, maxChars));
      pendingStart = null;
      pendingEnd = null;
    } else if (pendingStart === null) {
      pendingStart = start;
      pendingEnd = end;
    } else if (end - pendingStart <= maxChars) {
      pendingEnd = end;
    } else {
      ranges.push([pendingStart, pendingEnd]);
      pendingStart = start;
      pendingEnd = end;
    }
  }
  if (pendingStart !== null) ranges.push([pendingStart, pendingEnd]);
  return ranges;
}

export function segmentDocument(document, { maxChars = 180 } = {}) {
  if (!Number.isInteger(maxChars) || maxChars < 20) throw new Error("maxChars 至少为 20。");
  if (!document || !Array.isArray(document.chapters)) throw new Error("无效的 TextDocument。");
  const segments = [];
  document.chapters.forEach((chapter, chapterIndex) => {
    if (!Array.isArray(chapter.paragraphs)) throw new Error("章节缺少 paragraphs。 ");
    chapter.paragraphs.forEach((paragraph, paragraphIndex) => {
      if (typeof paragraph !== "string" || !paragraph.trim()) return;
      for (const [start, end] of paragraphRanges(paragraph, maxChars)) {
        const text = paragraph.slice(start, end);
        if (!text.trim()) continue;
        segments.push({
          index: segments.length,
          chapterIndex,
          chapterTitle: chapter.title,
          paragraphIndex,
          originalText: paragraph,
          start,
          end,
          text
        });
      }
    });
  });
  return segments;
}
