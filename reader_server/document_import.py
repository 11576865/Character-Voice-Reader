"""Extract headings and body paragraphs for document voiceover."""

import io
import re
import xml.etree.ElementTree as ET
import zipfile


def _chapters(title: str, blocks: list[tuple[str, bool]]) -> dict:
    chapters = []
    current = {"title": title, "paragraphs": []}
    for text, heading in blocks:
        text = text.strip()
        if not text:
            continue
        if heading:
            if current["paragraphs"]:
                chapters.append(current)
            current = {"title": text, "paragraphs": [text]}
        else:
            current["paragraphs"].append(text)
    if current["paragraphs"]:
        chapters.append(current)
    if not chapters:
        raise ValueError("Document contains no readable text")
    return {"title": title, "chapters": chapters}


def parse_document(data: bytes, kind: str, name: str) -> dict:
    if len(data) > 30 * 1024 * 1024:
        raise ValueError("Document exceeds 30 MB")
    title = name.rsplit(".", 1)[0].strip() or "Document"
    if kind in {"txt", "md"}:
        text = data.decode("utf-8-sig")
        if kind == "md":
            blocks = []
            for line in text.splitlines():
                line = line.strip()
                if line.startswith("#"):
                    blocks.append((line.lstrip("# "), True))
                elif line and not line.startswith(("```", "<!--", "![")):
                    clean = re.sub(r"\[([^]]+)\]\([^)]+\)", r"\1", line)
                    blocks.append((re.sub(r"[*_`]+", "", clean), False))
        else:
            blocks = [(paragraph, False) for paragraph in re.split(r"\n\s*\n", text)]
        return _chapters(title, blocks)
    if kind != "docx":
        raise ValueError("Unsupported document type")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            info = archive.getinfo("word/document.xml")
            if info.file_size > 30 * 1024 * 1024:
                raise ValueError("DOCX text is too large")
            root = ET.fromstring(archive.read(info))
    except (zipfile.BadZipFile, KeyError, ET.ParseError) as exc:
        raise ValueError("Invalid DOCX document") from exc
    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    blocks = []
    for paragraph in root.findall(".//w:body/w:p", ns):
        content = "".join(node.text or "" for node in paragraph.findall(".//w:t", ns))
        style = paragraph.find("./w:pPr/w:pStyle", ns)
        style_name = style.get(f"{{{ns['w']}}}val", "") if style is not None else ""
        blocks.append((content, style_name.lower().startswith(("heading", "title"))))
    return _chapters(title, blocks)
