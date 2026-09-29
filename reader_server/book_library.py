"""Local book, audio-version, and resumable generation state."""

import hashlib
import json
import shutil
import subprocess
import threading
import uuid
import wave
from reader_server.pronunciations import validate_rules
from datetime import datetime, timezone
from pathlib import Path


def _now():
    return datetime.now(timezone.utc).isoformat()


def _atomic_json(path: Path, value: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + f".{uuid.uuid4().hex}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


class BookLibrary:
    def __init__(self, root: Path):
        self.root = root
        self.lock = threading.RLock()

    def _folder(self, book_id: str) -> Path:
        if not book_id.startswith("b-") or len(book_id) != 26 or not all(
                char in "0123456789abcdef" for char in book_id[2:]):
            raise ValueError("Invalid book ID")
        return self.root / "books" / book_id

    def put_book(self, document: dict, segments: list[dict], *, kind: str, author: str = "",
                 client_document_id: str | None = None) -> dict:
        if kind not in {"txt", "epub", "manual", "md", "docx"}:
            raise ValueError("Unsupported book format")
        chapters = document.get("chapters") if isinstance(document, dict) else None
        if not isinstance(chapters, list) or not chapters or not isinstance(document.get("title"), str):
            raise ValueError("Book must have a title and chapters")
        if not isinstance(segments, list) or not segments or len(segments) > 100000:
            raise ValueError("Book must have readable segments")
        canonical = json.dumps({"document": document, "kind": kind}, ensure_ascii=False,
                               sort_keys=True, separators=(",", ":")).encode("utf-8")
        book_id = "b-" + hashlib.sha256(canonical).hexdigest()[:24]
        clean_segments = []
        for index, raw in enumerate(segments):
            try:
                chapter_index = raw["chapterIndex"]
                paragraph_index = raw["paragraphIndex"]
                start = raw["start"]
                end = raw["end"]
                text = raw["text"]
                paragraph = chapters[chapter_index]["paragraphs"][paragraph_index]
            except (KeyError, IndexError, TypeError) as exc:
                raise ValueError(f"Invalid segment {index}") from exc
            if not all(isinstance(x, int) and x >= 0 for x in
                       (chapter_index, paragraph_index, start, end)) or not isinstance(text, str) or \
                    not isinstance(paragraph, str) or paragraph[start:end] != text or not text.strip():
                raise ValueError(f"Segment {index} does not match book text")
            segment_id = "s-" + hashlib.sha256(
                f"{chapter_index}:{paragraph_index}:{start}:{end}:{text}".encode("utf-8")
            ).hexdigest()[:24]
            clean_segments.append({"id": segment_id, "index": index, "chapterIndex": chapter_index,
                                   "paragraphIndex": paragraph_index, "start": start, "end": end,
                                   "text": text})
        payload = {"id": book_id, "title": document["title"], "author": author,
                   "kind": kind, "document": document, "segments": clean_segments,
                   "clientDocumentId": client_document_id if isinstance(client_document_id, str) else None,
                   "createdAt": _now()}
        with self.lock:
            path = self._folder(book_id) / "book.json"
            if path.exists():
                return json.loads(path.read_text(encoding="utf-8"))
            _atomic_json(path, payload)
        return payload

    def list_books(self) -> list[dict]:
        with self.lock:
            result = []
            for path in sorted((self.root / "books").glob("b-*/book.json")):
                try:
                    item = json.loads(path.read_text(encoding="utf-8"))
                    result.append({key: item[key] for key in ("id", "title", "author", "kind", "createdAt")})
                except (OSError, ValueError, KeyError):
                    continue
            return result

    def get_book(self, book_id: str) -> dict:
        path = self._folder(book_id) / "book.json"
        with self.lock:
            return json.loads(path.read_text(encoding="utf-8"))

    def save_annotations(self, book_id: str, annotations: dict):
        book = self.get_book(book_id)
        valid = {f"{item['chapterIndex']}:{item['paragraphIndex']}" for item in book["segments"]}
        if not isinstance(annotations, dict) or any(
                key not in valid or not isinstance(value, dict) or
                not isinstance(value.get("voice"), str) for key, value in annotations.items()):
            raise ValueError("Invalid paragraph annotations")
        book["annotations"] = annotations
        book["annotationsUpdatedAt"] = _now()
        with self.lock:
            _atomic_json(self._folder(book_id) / "book.json", book)

    def save_pronunciations(self, book_id: str, rules: dict):
        book = self.get_book(book_id)
        book["pronunciations"] = validate_rules(rules)
        book["pronunciationsUpdatedAt"] = _now()
        with self.lock:
            _atomic_json(self._folder(book_id) / "book.json", book)

    def progress(self, book_id: str) -> dict:
        self.get_book(book_id)
        path = self._folder(book_id) / "progress.json"
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}

    def save_progress(self, book_id: str, value: dict):
        book = self.get_book(book_id)
        index = value.get("segmentIndex")
        if not isinstance(index, int) or not 0 <= index < len(book["segments"]):
            raise ValueError("Invalid reading position")
        record = {"segmentIndex": index, "audioTime": max(0, float(value.get("audioTime") or 0)),
                  "updatedAt": _now()}
        with self.lock:
            _atomic_json(self._folder(book_id) / "progress.json", record)
        return record

    def put_source(self, book_id: str, source: bytes, suffix: str):
        if suffix not in {"txt", "epub", "md", "docx"} or len(source) > 100 * 1024 * 1024:
            raise ValueError("Unsupported or oversized source file")
        if self.get_book(book_id)["kind"] != suffix:
            raise ValueError("Source format does not match the book")
        path = self._folder(book_id) / f"source.{suffix}"
        if not path.exists():
            path.write_bytes(source)

    def _versions_path(self, book_id: str) -> Path:
        return self._folder(book_id) / "versions.json"

    def versions(self, book_id: str) -> dict:
        self.get_book(book_id)
        path = self._versions_path(book_id)
        with self.lock:
            if not path.exists():
                return {}
            return json.loads(path.read_text(encoding="utf-8"))

    def add_version(self, book_id: str, segment_id: str, audio: bytes, metadata: dict) -> dict:
        book = self.get_book(book_id)
        if not any(item["id"] == segment_id for item in book["segments"]):
            raise ValueError("Segment does not belong to book")
        if not audio.startswith(b"RIFF") or b"WAVE" not in audio[:16]:
            raise ValueError("Generated audio is not WAV")
        version_id = "v-" + uuid.uuid4().hex
        record = {"id": version_id, "createdAt": _now(), "metadata": metadata,
                  "bytes": len(audio)}
        with self.lock:
            state = self.versions(book_id)
            item = state.setdefault(segment_id, {"selected": None, "versions": []})
            audio_dir = self._folder(book_id) / "audio" / segment_id
            audio_dir.mkdir(parents=True, exist_ok=True)
            (audio_dir / f"{version_id}.wav").write_bytes(audio)
            item["versions"].append(record)
            item["selected"] = version_id
            while len(item["versions"]) > 7:
                old = next((v for v in item["versions"] if v["id"] != item["selected"]), None)
                if not old:
                    break
                item["versions"].remove(old)
                (audio_dir / f"{old['id']}.wav").unlink(missing_ok=True)
            _atomic_json(self._versions_path(book_id), state)
        return record

    def select_version(self, book_id: str, segment_id: str, version_id: str):
        with self.lock:
            state = self.versions(book_id)
            item = state.get(segment_id)
            if not item or not any(v["id"] == version_id for v in item["versions"]):
                raise ValueError("Audio version not found")
            item["selected"] = version_id
            _atomic_json(self._versions_path(book_id), state)

    def audio_path(self, book_id: str, segment_id: str) -> Path | None:
        item = self.versions(book_id).get(segment_id)
        if not item or not item.get("selected"):
            return None
        path = self._folder(book_id) / "audio" / segment_id / f"{item['selected']}.wav"
        return path if path.is_file() else None

    def compressed_audio(self, book_id: str, segment_id: str) -> Path | None:
        wav = self.audio_path(book_id, segment_id)
        if wav is None:
            return None
        target = wav.with_suffix(".mp3")
        if target.is_file():
            return target
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            raise RuntimeError("ffmpeg is required for offline audio export")
        staging = target.with_suffix(".tmp.mp3")
        try:
            subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
                            "-i", str(wav), "-codec:a", "libmp3lame", "-q:a", "5",
                            str(staging)], check=True, timeout=120)
            staging.replace(target)
        finally:
            staging.unlink(missing_ok=True)
        return target

    def offline_manifest(self, book_id: str) -> dict:
        book = self.get_book(book_id)
        clips = []
        for segment in book["segments"]:
            audio = self.compressed_audio(book_id, segment["id"])
            if audio is None:
                raise ValueError("Book generation is incomplete")
            data = audio.read_bytes()
            clips.append({"segmentId": segment["id"], "chapterIndex": segment["chapterIndex"],
                          "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
        return {"book": book, "clips": clips, "totalBytes": sum(item["bytes"] for item in clips)}

    def combined_wav(self, book_id: str) -> Path:
        book = self.get_book(book_id)
        target = self._folder(book_id) / f"{book_id}-complete.wav"
        first_params = None
        try:
            with wave.open(str(target), "wb") as output:
                for segment in book["segments"]:
                    source = self.audio_path(book_id, segment["id"])
                    if source is None:
                        raise ValueError("Book generation is incomplete")
                    with wave.open(str(source), "rb") as audio:
                        params = audio.getparams()
                        format_params = (params.nchannels, params.sampwidth, params.framerate, params.comptype)
                        if first_params is None:
                            first_params = format_params
                            output.setparams(params)
                        elif format_params != first_params:
                            raise ValueError("Generated WAV segments have different formats")
                        output.writeframes(audio.readframes(params.nframes))
        except Exception:
            target.unlink(missing_ok=True)
            raise
        return target

    def job_path(self, book_id: str) -> Path:
        self.get_book(book_id)
        return self._folder(book_id) / "job.json"

    def job(self, book_id: str) -> dict:
        path = self.job_path(book_id)
        with self.lock:
            if not path.exists():
                return {"status": "none", "completed": 0, "total": len(self.get_book(book_id)["segments"])}
            return json.loads(path.read_text(encoding="utf-8"))

    def set_job(self, book_id: str, value: dict):
        with self.lock:
            _atomic_json(self.job_path(book_id), value)
