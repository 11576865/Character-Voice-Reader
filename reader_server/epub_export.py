"""EPUB 3 read-aloud export using paragraph/segment media overlays."""

import html
import wave
import zipfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

from reader_server.book_library import BookLibrary


def _duration(wav: Path) -> float:
    with wave.open(str(wav), "rb") as stream:
        return stream.getnframes() / stream.getframerate()


def _clock(seconds: float) -> str:
    hours = int(seconds // 3600)
    minutes = int(seconds % 3600 // 60)
    return f"{hours:02d}:{minutes:02d}:{seconds % 60:06.3f}"


def export_read_aloud(library: BookLibrary, book_id: str) -> Path:
    book = library.get_book(book_id)
    manifest = library.offline_manifest(book_id)
    audio = {item["segmentId"]: library.compressed_audio(book_id, item["segmentId"])
             for item in manifest["clips"]}
    chapters = book["document"]["chapters"]
    sample = " ".join(paragraph for chapter in chapters for paragraph in chapter["paragraphs"][:10])
    han = sum("\u4e00" <= character <= "\u9fff" for character in sample)
    latin = sum(character.isascii() and character.isalpha() for character in sample)
    language = "zh-CN" if han > latin else "en"
    grouped = {}
    for segment in book["segments"]:
        grouped.setdefault((segment["chapterIndex"], segment["paragraphIndex"]), []).append(segment)
    chapter_files = []
    smil_files = []
    durations = []
    for chapter_index, chapter in enumerate(chapters):
        chapter_name = f"chapter-{chapter_index + 1:04d}.xhtml"
        smil_name = f"chapter-{chapter_index + 1:04d}.smil"
        parts = [f'<section><h1>{html.escape(chapter.get("title") or f"Chapter {chapter_index + 1}")}</h1>']
        overlays = []
        total = 0.0
        for paragraph_index, paragraph in enumerate(chapter["paragraphs"]):
            pieces = grouped.get((chapter_index, paragraph_index), [])
            if not pieces:
                parts.append(f"<p>{html.escape(paragraph)}</p>")
                continue
            spans = []
            for piece in pieces:
                segment_id = piece["id"]
                wav = library.audio_path(book_id, segment_id)
                if not wav or not audio.get(segment_id):
                    raise ValueError(f"Missing audio for {segment_id}")
                duration = _duration(wav)
                total += duration
                spans.append(f'<span id="{segment_id}">{html.escape(piece["text"])}</span>')
                overlays.append(
                    f'<par id="par-{segment_id}"><text src="{chapter_name}#{segment_id}"/>'
                    f'<audio src="audio/{segment_id}.mp3" clipBegin="0s" '
                    f'clipEnd="{duration:.3f}s"/></par>')
            parts.append("<p>" + "".join(spans) + "</p>")
        parts.append("</section>")
        xhtml = ('<?xml version="1.0" encoding="utf-8"?>'
                 f'<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="{language}">'
                 f'<head><title>{html.escape(chapter.get("title") or book["title"])}</title></head>'
                 '<body>' + "".join(parts) + '</body></html>')
        smil = ('<?xml version="1.0" encoding="utf-8"?>'
                '<smil xmlns="http://www.w3.org/ns/SMIL" version="3.0">'
                '<body><seq>' + "".join(overlays) + '</seq></body></smil>')
        chapter_files.append((chapter_name, xhtml))
        smil_files.append((smil_name, smil))
        durations.append(total)
    metadata = (
        f'<dc:identifier id="pub-id">urn:uuid:{book_id}</dc:identifier>'
        f'<dc:title>{html.escape(book["title"])}</dc:title>'
        f'<dc:language>{language}</dc:language>'
        f'<meta property="dcterms:modified">{datetime.now(timezone.utc):%Y-%m-%dT%H:%M:%SZ}</meta>'
        f'<meta property="media:duration">{_clock(sum(durations))}</meta>'
    )
    if book.get("author"):
        metadata += f'<dc:creator>{html.escape(book["author"])}</dc:creator>'
    items = ['<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>']
    spine = []
    for index, ((chapter_name, _), (smil_name, _)) in enumerate(zip(chapter_files, smil_files), 1):
        items.append(f'<item id="c{index}" href="{chapter_name}" media-type="application/xhtml+xml" media-overlay="m{index}"/>')
        items.append(f'<item id="m{index}" href="{smil_name}" media-type="application/smil+xml"/>')
        metadata += f'<meta refines="#m{index}" property="media:duration">{_clock(durations[index - 1])}</meta>'
        spine.append(f'<itemref idref="c{index}"/>')
    for segment_id in audio:
        items.append(f'<item id="a-{segment_id}" href="audio/{segment_id}.mp3" media-type="audio/mpeg"/>')
    opf = ('<?xml version="1.0" encoding="utf-8"?>'
           '<package xmlns="http://www.idpf.org/2007/opf" '
           'xmlns:dc="http://purl.org/dc/elements/1.1/" version="3.0" '
           'unique-identifier="pub-id"><metadata>' + metadata + '</metadata>'
           '<manifest>' + "".join(items) + '</manifest><spine>' + "".join(spine) + '</spine></package>')
    toc = "".join(f'<li><a href="{name}">{html.escape(chapters[i].get("title") or str(i + 1))}</a></li>'
                  for i, (name, _) in enumerate(chapter_files))
    nav = ('<?xml version="1.0" encoding="utf-8"?>'
           '<html xmlns="http://www.w3.org/1999/xhtml" '
           'xmlns:epub="http://www.idpf.org/2007/ops"><head>'
           f'<title>{html.escape(book["title"])}</title></head><body>'
           f'<nav epub:type="toc"><h1>目录</h1><ol>{toc}</ol></nav></body></html>')
    container = ('<?xml version="1.0" encoding="utf-8"?>'
                 '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">'
                 '<rootfiles><rootfile full-path="OEBPS/content.opf" '
                 'media-type="application/oebps-package+xml"/></rootfiles></container>')
    target = library._folder(book_id) / f"{book_id}-read-aloud.epub"
    staging = target.with_name(f"{target.stem}.{uuid.uuid4().hex}.tmp.epub")
    with zipfile.ZipFile(staging, "w") as package:
        package.writestr("mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        package.writestr("META-INF/container.xml", container)
        package.writestr("OEBPS/content.opf", opf)
        package.writestr("OEBPS/nav.xhtml", nav)
        for name, content in chapter_files + smil_files:
            package.writestr("OEBPS/" + name, content)
        for segment_id, path in audio.items():
            package.write(path, "OEBPS/audio/" + segment_id + ".mp3")
    staging.replace(target)
    return target
