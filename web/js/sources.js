const CHAPTER_HEADING = /^(?:第[零一二三四五六七八九十百千万两\d]+[章节回卷部篇](?:\s|[:：.、-]|$)|chapter\s+\d+\b)/i;

export function paragraphsFromText(text) {
  return String(text).replace(/\r\n?/g, "\n")
    .split(/\n[\t \u3000]*\n+/)
    .map(paragraph => paragraph.trim())
    .filter(Boolean);
}

export function documentFromManual(text) {
  return {
    title: "手动输入",
    chapters: [{ title: "正文", paragraphs: paragraphsFromText(text) }]
  };
}

export function documentFromTxt(text, title = "TXT 文档") {
  const chapters = [];
  let current = { title: "正文", paragraphs: [] };
  for (const paragraph of paragraphsFromText(text)) {
    if (!paragraph.includes("\n") && CHAPTER_HEADING.test(paragraph)) {
      if (current.paragraphs.length) chapters.push(current);
      current = { title: paragraph, paragraphs: [] };
    } else {
      current.paragraphs.push(paragraph);
    }
  }
  if (current.paragraphs.length || chapters.length === 0) chapters.push(current);
  return { title, chapters };
}

export async function readTxtFile(file, buffer = null) {
  if (!file || !/\.txt$/i.test(file.name)) {
    throw new Error("请选择 .txt 文件。");
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer || await file.arrayBuffer());
  } catch (error) {
    throw new Error("TXT 文件必须使用 UTF-8 编码。", { cause: error });
  }
  const title = file.name.replace(/\.txt$/i, "");
  return documentFromTxt(text, title);
}
