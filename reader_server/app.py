import hashlib
import hmac
import json
import threading
import time
import uuid
import wave
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from reader_server.book_library import BookLibrary
from reader_server.generation_ledger import GenerationLedger
from reader_server.config import ADMIN_TOKEN, DATA_DIR, HOST, PORT, WEB_DIR
from reader_server.cvs_client import CVSClient, CVSError
from reader_server.document_import import parse_document
from reader_server.emotion_router import choose_reference
from reader_server.epub_export import export_read_aloud
from reader_server.pronunciations import spoken_text
from reader_server.speaker_suggestions import suggest_speakers


app = FastAPI(title="Character Voice Reader", version="0.2.0")
app.mount("/reader-assets", StaticFiles(directory=WEB_DIR), name="reader-assets")
FOLIATE_DIR = WEB_DIR.parent / "vendor" / "foliate-js"
if FOLIATE_DIR.is_dir():
    app.mount("/foliate-assets", StaticFiles(directory=FOLIATE_DIR), name="foliate-assets")

library = BookLibrary(DATA_DIR)
generation_ledger = GenerationLedger(DATA_DIR)
cvs = CVSClient()
generation_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="cvr-book")
active_jobs: dict[str, threading.Event] = {}
pause_jobs: dict[str, threading.Event] = {}
jobs_lock = threading.Lock()


class SpeechRequest(BaseModel):
    voice: str
    model_id: str | None = None
    reference_id: str | None = None
    input: str
    response_format: str = "wav"
    speed: float = 1.0


class BookRequest(BaseModel):
    document: dict
    segments: list[dict]
    kind: str
    author: str = ""
    client_document_id: str | None = None


class GenerationRequest(BaseModel):
    voice: str
    model_id: str | None = None
    reference_id: str | None = None
    speed: float = 1.0
    continuous_emotion: bool = False
    scope: str = "all"
    chapter_index: int | None = None
    paragraph_index: int | None = None


class SelectionRequest(BaseModel):
    version_id: str


class LoginRequest(BaseModel):
    token: str


def _session_value() -> str:
    issued = str(int(time.time()))
    signature = hmac.new(ADMIN_TOKEN.encode(), issued.encode(), "sha256").hexdigest()
    return f"{issued}.{signature}"


def _valid_session(value: str | None) -> bool:
    if not value or "." not in value:
        return False
    issued, signature = value.split(".", 1)
    if not issued.isdigit() or abs(time.time() - int(issued)) > 7 * 24 * 3600:
        return False
    expected = hmac.new(ADMIN_TOKEN.encode(), issued.encode(), "sha256").hexdigest()
    return hmac.compare_digest(signature, expected)


def require_admin(request: Request, x_cvr_token: str | None = Header(default=None)):
    if not _valid_session(request.cookies.get("cvr_session")) and (
        not x_cvr_token or not hmac.compare_digest(x_cvr_token, ADMIN_TOKEN)
    ):
        raise HTTPException(status_code=401, detail="Invalid reader token")


def _cvs_error(exc: CVSError):
    raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


def get_book_or_404(book_id: str) -> dict:
    try:
        return library.get_book(book_id)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=404, detail="Book not found") from exc


def _voice_map() -> dict[str, dict]:
    try:
        payload = cvs.json("GET", "/v1/voices")
    except CVSError as exc:
        _cvs_error(exc)
    return {
        item["id"]: item
        for item in payload.get("voices", [])
        if isinstance(item, dict) and item.get("id") and not item.get("error")
    }


def _reference_profile(summary: dict) -> dict:
    return {
        "default_reference": summary["default_reference"],
        "references": {item["id"]: item for item in summary.get("references", [])},
    }


def _model_metadata(summary: dict, alias: str | None) -> tuple[str | None, dict]:
    effective = alias or summary.get("default_model")
    model = next((item for item in summary.get("models", []) if item.get("id") == effective), {})
    return effective, model


@app.get("/health/live")
def health_live():
    return {"status": "ok", "service": "character-voice-reader"}


@app.get("/health")
def health():
    return {"status": "ok", "service": "character-voice-reader", "cvs": cvs.health()}


@app.post("/v1/session")
def login(request: LoginRequest, http_request: Request):
    if not hmac.compare_digest(request.token, ADMIN_TOKEN):
        raise HTTPException(status_code=401, detail="Invalid reader token")
    secure = http_request.url.hostname not in {"127.0.0.1", "localhost"}
    response = Response(content=json.dumps({"authenticated": True}), media_type="application/json")
    response.set_cookie(
        "cvr_session", _session_value(), httponly=True, secure=secure,
        samesite="lax", max_age=7 * 24 * 3600, path="/"
    )
    return response


@app.get("/v1/voices")
def voices():
    try:
        return cvs.json("GET", "/v1/voices")
    except CVSError as exc:
        _cvs_error(exc)


@app.get("/v1/engines")
def engines():
    try:
        return cvs.json("GET", "/v1/engines")
    except CVSError as exc:
        _cvs_error(exc)


@app.post("/v1/audio/resolve")
def resolve_speech(request: SpeechRequest):
    if not request.input.strip():
        raise HTTPException(status_code=400, detail="input cannot be empty")
    try:
        return cvs.json("POST", "/v1/audio/resolve", body=request.model_dump())
    except CVSError as exc:
        _cvs_error(exc)


@app.post("/v1/audio/speech")
def speech(request: SpeechRequest):
    if not request.input.strip():
        raise HTTPException(status_code=400, detail="input cannot be empty")
    try:
        audio, headers = cvs.speech(request.model_dump())
    except CVSError as exc:
        _cvs_error(exc)
    forwarded = {}
    for name in (
        "x-selected-reference", "x-reference-reason",
        "x-cvs-voice", "x-cvs-model", "x-cvs-engine",
        "x-cvs-model-revision", "x-cvs-generation-revision",
        "x-cvs-runtime", "x-cvs-runtime-revision",
        "x-cvs-binding", "x-cvs-binding-revision",
        "x-cvs-request-id",
    ):
        if name in headers:
            forwarded[name] = headers[name]
    generation_ledger.append(
        source="interactive",
        text=request.input,
        audio=audio,
        metadata={
            "voice": headers.get("x-cvs-voice") or request.voice,
            "model": headers.get("x-cvs-model") or request.model_id,
            "model_revision": headers.get("x-cvs-model-revision"),
            "engine": headers.get("x-cvs-engine"),
            "runtime": headers.get("x-cvs-runtime"),
            "runtime_revision": headers.get("x-cvs-runtime-revision"),
            "binding": headers.get("x-cvs-binding"),
            "binding_revision": headers.get("x-cvs-binding-revision"),
            "generation_revision": headers.get("x-cvs-generation-revision"),
            "reference_id": headers.get("x-selected-reference") or request.reference_id,
            "speed": request.speed,
            "request_id": headers.get("x-cvs-request-id"),
        },
    )
    return Response(content=audio, media_type=headers.get("content-type", "audio/wav"), headers=forwarded)


@app.get("/v1/generation-history", dependencies=[Depends(require_admin)])
def generation_history(limit: int = 50):
    try:
        return {"items": generation_ledger.recent(limit=limit)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get(
    "/v1/books/{book_id}/generation-history",
    dependencies=[Depends(require_admin)],
)
def book_generation_history(book_id: str, limit: int = 50):
    get_book_or_404(book_id)
    try:
        return {"items": generation_ledger.recent(limit=limit, book_id=book_id)}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get(
    "/v1/voices/{voice_id}/references/{reference_id}/audio",
    dependencies=[Depends(require_admin)],
)
def reference_audio(voice_id: str, reference_id: str):
    try:
        content, media_type = cvs.bytes(
            f"/v1/voices/{voice_id}/references/{reference_id}/audio", admin=True
        )
    except CVSError as exc:
        _cvs_error(exc)
    return Response(content=content, media_type=media_type)


@app.get("/", include_in_schema=False)
@app.get("/test", include_in_schema=False)
def reader_page():
    return FileResponse(WEB_DIR / "index.html")


@app.get("/service-worker.js", include_in_schema=False)
def service_worker():
    return FileResponse(
        WEB_DIR / "sw.js", media_type="text/javascript",
        headers={"Service-Worker-Allowed": "/"},
    )


@app.get("/epub-prototype", include_in_schema=False)
def foliate_prototype():
    if not FOLIATE_DIR.is_dir():
        raise HTTPException(status_code=404, detail="foliate-js submodule is missing")
    return FileResponse(
        WEB_DIR / "foliate-prototype.html",
        headers={
            "Content-Security-Policy":
                "default-src 'self' blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                "object-src 'none'; base-uri 'self'; frame-src blob:; "
                "img-src 'self' blob: data:; media-src 'self' blob:"
        },
    )


@app.get("/v1/books", dependencies=[Depends(require_admin)])
def list_books():
    return {"books": library.list_books()}


@app.post("/v1/books", dependencies=[Depends(require_admin)])
def create_book(request: BookRequest):
    try:
        book = library.put_book(
            request.document, request.segments, kind=request.kind, author=request.author,
            client_document_id=request.client_document_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"id": book["id"], "title": book["title"], "segments": len(book["segments"])}


@app.get("/v1/books/{book_id}", dependencies=[Depends(require_admin)])
def get_book(book_id: str):
    return get_book_or_404(book_id)


@app.put("/v1/books/{book_id}/source", dependencies=[Depends(require_admin)])
async def save_book_source(book_id: str, request: Request, kind: str):
    get_book_or_404(book_id)
    source = await request.body()
    try:
        library.put_source(book_id, source, kind)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"stored": True, "bytes": len(source)}


@app.put("/v1/books/{book_id}/annotations", dependencies=[Depends(require_admin)])
def save_book_annotations(book_id: str, annotations: dict):
    get_book_or_404(book_id)
    try:
        library.save_annotations(book_id, annotations)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"saved": len(annotations)}


@app.get("/v1/books/{book_id}/speaker-suggestions", dependencies=[Depends(require_admin)])
def book_speaker_suggestions(book_id: str):
    return {"suggestions": suggest_speakers(get_book_or_404(book_id), voices()["voices"])}


@app.put("/v1/books/{book_id}/pronunciations", dependencies=[Depends(require_admin)])
def save_book_pronunciations(book_id: str, rules: dict):
    get_book_or_404(book_id)
    try:
        library.save_pronunciations(book_id, rules)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"saved": len(rules)}


@app.get("/v1/books/{book_id}/progress", dependencies=[Depends(require_admin)])
def get_book_progress(book_id: str):
    get_book_or_404(book_id)
    return library.progress(book_id)


@app.put("/v1/books/{book_id}/progress", dependencies=[Depends(require_admin)])
def save_book_progress(book_id: str, progress: dict):
    get_book_or_404(book_id)
    try:
        return library.save_progress(book_id, progress)
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/v1/books/{book_id}/versions", dependencies=[Depends(require_admin)])
def get_versions(book_id: str):
    get_book_or_404(book_id)
    return library.versions(book_id)


@app.get("/v1/books/{book_id}/audio/{segment_id}", dependencies=[Depends(require_admin)])
def get_selected_audio(book_id: str, segment_id: str):
    get_book_or_404(book_id)
    path = library.audio_path(book_id, segment_id)
    if not path:
        raise HTTPException(status_code=404, detail="Audio not generated")
    return FileResponse(path, media_type="audio/wav")


@app.get("/v1/books/{book_id}/offline-manifest", dependencies=[Depends(require_admin)])
def offline_manifest(book_id: str):
    get_book_or_404(book_id)
    try:
        manifest = library.offline_manifest(book_id)
        manifest["voices"] = voices()["voices"]
        return manifest
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except (RuntimeError, OSError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/v1/books/{book_id}/offline-audio/{segment_id}", dependencies=[Depends(require_admin)])
def offline_audio(book_id: str, segment_id: str):
    book = get_book_or_404(book_id)
    if not any(item["id"] == segment_id for item in book["segments"]):
        raise HTTPException(status_code=404, detail="Segment not found")
    try:
        path = library.compressed_audio(book_id, segment_id)
    except (RuntimeError, OSError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if path is None:
        raise HTTPException(status_code=404, detail="Audio not generated")
    return FileResponse(path, media_type="audio/mpeg")


@app.get("/v1/books/{book_id}/read-aloud.epub", dependencies=[Depends(require_admin)])
def read_aloud_epub(book_id: str):
    get_book_or_404(book_id)
    try:
        path = export_read_aloud(library, book_id)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except (RuntimeError, OSError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return FileResponse(
        path, filename=f"{book_id}-read-aloud.epub", media_type="application/epub+zip"
    )


@app.post("/v1/documents/parse", dependencies=[Depends(require_admin)])
async def parse_uploaded_document(request: Request, kind: str, name: str):
    data = await request.body()
    try:
        return {"document": parse_document(data, kind, name)}
    except (ValueError, UnicodeDecodeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/v1/books/{book_id}/complete.wav", dependencies=[Depends(require_admin)])
def complete_wav(book_id: str):
    get_book_or_404(book_id)
    try:
        path = library.combined_wav(book_id)
    except (ValueError, OSError, wave.Error) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return FileResponse(path, filename=f"{book_id}-complete.wav", media_type="audio/wav")


@app.post(
    "/v1/books/{book_id}/segments/{segment_id}/select",
    dependencies=[Depends(require_admin)],
)
def select_book_version(book_id: str, segment_id: str, request: SelectionRequest):
    get_book_or_404(book_id)
    try:
        library.select_version(book_id, segment_id, request.version_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"selected": request.version_id}


def _generation_segments(book_id: str, book: dict, settings: dict) -> list[dict]:
    scope = settings.get("scope") or "all"
    segments = list(book["segments"])
    if scope == "missing":
        return [
            segment for segment in segments
            if library.audio_path(book_id, segment["id"]) is None
        ]
    if scope == "chapter":
        chapter_index = settings.get("chapter_index")
        if not isinstance(chapter_index, int) or chapter_index < 0:
            raise ValueError("chapter_index is required for chapter generation")
        return [
            segment for segment in segments
            if segment["chapterIndex"] == chapter_index
        ]
    if scope == "paragraph":
        chapter_index = settings.get("chapter_index")
        paragraph_index = settings.get("paragraph_index")
        if (
            not isinstance(chapter_index, int) or chapter_index < 0
            or not isinstance(paragraph_index, int) or paragraph_index < 0
        ):
            raise ValueError(
                "chapter_index and paragraph_index are required for paragraph generation"
            )
        return [
            segment for segment in segments
            if segment["chapterIndex"] == chapter_index
            and segment["paragraphIndex"] == paragraph_index
        ]
    if scope != "all":
        raise ValueError(f"Unsupported generation scope: {scope}")
    return segments


def _generate_book(
    book_id: str,
    settings: dict,
    cancel: threading.Event,
    pause: threading.Event,
):
    book = library.get_book(book_id)
    target_segments = _generation_segments(book_id, book, settings)
    total = len(target_segments)
    job = {
        "status": "running", "completed": 0, "total": total,
        "error": None, "settings": settings, "updatedAt": _now_iso(),
        "current_segment": None, "failed_segment": None,
    }
    library.set_job(book_id, job)
    continuity = {
        "chapter": None, "voice": None, "paragraph": None,
        "reference": None, "held": False,
    }
    try:
        voice_map = _voice_map()
        for segment in target_segments:
            while pause.is_set() and not cancel.is_set():
                if job.get("status") != "paused":
                    job["status"] = "paused"
                    job["updatedAt"] = _now_iso()
                    library.set_job(book_id, job)
                time.sleep(0.2)

            if cancel.is_set():
                job["status"] = "cancelled"
                break

            if job.get("status") == "paused":
                job["status"] = "running"
                job["updatedAt"] = _now_iso()
                library.set_job(book_id, job)

            current_segment = {
                "id": segment["id"],
                "index": segment["index"],
                "chapterIndex": segment["chapterIndex"],
                "paragraphIndex": segment["paragraphIndex"],
            }
            job["current_segment"] = current_segment
            job["updatedAt"] = _now_iso()
            library.set_job(book_id, job)

            override = book.get("annotations", {}).get(
                f"{segment['chapterIndex']}:{segment['paragraphIndex']}", {}
            )
            voice = override.get("voice") or settings["voice"]
            summary = voice_map.get(voice)
            if not summary:
                raise ValueError(f"Voice is unavailable from Character Voice Service: {voice}")

            model_alias = override.get("model_id") or settings.get("model_id")
            model_alias, model_meta = _model_metadata(summary, model_alias)
            reference_id = override.get("reference_id") or settings.get("reference_id")
            text_to_speak = spoken_text(segment["text"], book.get("pronunciations", {}))

            if reference_id == "auto":
                profile = _reference_profile(summary)
                proposed, reason = choose_reference(profile, text_to_speak)
                if settings.get("continuous_emotion"):
                    paragraph = (segment["chapterIndex"], segment["paragraphIndex"])
                    same_context = (
                        continuity["chapter"] == segment["chapterIndex"]
                        and continuity["voice"] == voice
                    )
                    if (
                        reason.startswith("default: ambiguous or no emotion cue")
                        and same_context and continuity["reference"]
                        and not continuity["held"]
                    ):
                        reference_id = continuity["reference"]
                        continuity["held"] = True
                    else:
                        reference_id = proposed
                        continuity["held"] = False
                    continuity.update(
                        chapter=segment["chapterIndex"], voice=voice,
                        paragraph=paragraph, reference=reference_id,
                    )
                else:
                    reference_id = proposed

            if not reference_id:
                reference_id = summary.get("default_reference")

            payload = {
                "voice": voice,
                "model_id": model_alias,
                "reference_id": reference_id,
                "input": text_to_speak,
                "response_format": "wav",
                "speed": settings["speed"],
            }
            provenance = cvs.json("POST", "/v1/audio/resolve", body=payload)
            generation_revision = provenance.get("generation_revision")
            if not generation_revision:
                raise RuntimeError("Character Voice Service did not return generation provenance")

            fingerprint = hashlib.sha256(json.dumps({
                "text": text_to_speak,
                "generation_revision": generation_revision,
            }, sort_keys=True).encode()).hexdigest()

            existing = library.versions(book_id).get(segment["id"], {})
            chosen = next(
                (version for version in existing.get("versions", [])
                 if version["id"] == existing.get("selected")),
                None,
            )
            if (
                not chosen
                or chosen.get("metadata", {}).get("fingerprint") != fingerprint
                or not library.audio_path(book_id, segment["id"])
            ):
                audio, headers = cvs.speech(payload)
                actual_reference = headers.get("x-selected-reference") or reference_id
                actual_generation_revision = (
                    headers.get("x-cvs-generation-revision") or generation_revision
                )
                actual_fingerprint = hashlib.sha256(json.dumps({
                    "text": text_to_speak,
                    "generation_revision": actual_generation_revision,
                }, sort_keys=True).encode()).hexdigest()
                record = library.add_version(book_id, segment["id"], audio, {
                    "voice": voice,
                    "model_alias": model_alias,
                    "model_id": headers.get("x-cvs-model") or provenance.get("model"),
                    "model_revision": (
                        headers.get("x-cvs-model-revision")
                        or provenance.get("model_revision")
                    ),
                    "engine": headers.get("x-cvs-engine") or provenance.get("engine"),
                    "runtime": headers.get("x-cvs-runtime") or provenance.get("runtime"),
                    "runtime_revision": (
                        headers.get("x-cvs-runtime-revision")
                        or provenance.get("runtime_revision")
                    ),
                    "binding": headers.get("x-cvs-binding") or provenance.get("binding"),
                    "binding_revision": (
                        headers.get("x-cvs-binding-revision")
                        or provenance.get("binding_revision")
                    ),
                    "generation_revision": actual_generation_revision,
                    "reference_id": actual_reference,
                    "speed": settings["speed"],
                    "fingerprint": actual_fingerprint,
                    "pronunciationsUpdatedAt": book.get("pronunciationsUpdatedAt"),
                })
                metadata = record["metadata"]
                generation_ledger.append(
                    source="book",
                    text=text_to_speak,
                    audio=audio,
                    book_id=book_id,
                    segment_id=segment["id"],
                    metadata={
                        "voice": metadata.get("voice"),
                        "model": metadata.get("model_id"),
                        "model_revision": metadata.get("model_revision"),
                        "engine": metadata.get("engine"),
                        "runtime": metadata.get("runtime"),
                        "runtime_revision": metadata.get("runtime_revision"),
                        "binding": metadata.get("binding"),
                        "binding_revision": metadata.get("binding_revision"),
                        "generation_revision": metadata.get("generation_revision"),
                        "reference_id": metadata.get("reference_id"),
                        "speed": metadata.get("speed"),
                        "request_id": headers.get("x-cvs-request-id"),
                    },
                )


            job["completed"] += 1
            job["updatedAt"] = _now_iso()
            library.set_job(book_id, job)

        if job["status"] == "running":
            job["status"] = "completed"
            job["current_segment"] = None
    except Exception as exc:
        job["status"] = "failed"
        job["error"] = str(exc)
        job["failed_segment"] = job.get("current_segment")
    finally:
        job["updatedAt"] = _now_iso()
        try:
            library.set_job(book_id, job)
        finally:
            with jobs_lock:
                active_jobs.pop(book_id, None)
                pause_jobs.pop(book_id, None)


def _now_iso():
    return datetime.now().astimezone().isoformat()


@app.post("/v1/books/{book_id}/generate", dependencies=[Depends(require_admin)])
def generate_book(book_id: str, request: GenerationRequest):
    book = get_book_or_404(book_id)
    if request.speed <= 0:
        raise HTTPException(status_code=400, detail="Speed must be positive")
    if request.voice not in _voice_map():
        raise HTTPException(status_code=404, detail="Voice is unavailable")
    if request.scope not in {"all", "missing", "chapter", "paragraph"}:
        raise HTTPException(status_code=400, detail="Unsupported generation scope")
    if request.scope == "chapter":
        if request.chapter_index is None or request.chapter_index < 0:
            raise HTTPException(status_code=400, detail="chapter_index is required")
        chapter_count = len(book.get("document", {}).get("chapters", []))
        if request.chapter_index >= chapter_count:
            raise HTTPException(status_code=400, detail="chapter_index is out of range")
    if request.scope == "paragraph":
        if (
            request.chapter_index is None or request.chapter_index < 0
            or request.paragraph_index is None or request.paragraph_index < 0
        ):
            raise HTTPException(
                status_code=400,
                detail="chapter_index and paragraph_index are required",
            )
        chapters = book.get("document", {}).get("chapters", [])
        if request.chapter_index >= len(chapters):
            raise HTTPException(status_code=400, detail="chapter_index is out of range")
        paragraphs = chapters[request.chapter_index].get("paragraphs", [])
        if request.paragraph_index >= len(paragraphs):
            raise HTTPException(status_code=400, detail="paragraph_index is out of range")
    with jobs_lock:
        if book_id in active_jobs:
            raise HTTPException(status_code=409, detail="Book generation already running")
        cancel = threading.Event()
        pause = threading.Event()
        active_jobs[book_id] = cancel
        pause_jobs[book_id] = pause
    settings = request.model_dump()
    try:
        target_total = len(_generation_segments(book_id, book, settings))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    library.set_job(book_id, {
        "status": "queued", "completed": 0,
        "total": target_total,
        "settings": settings, "updatedAt": _now_iso(), "error": None,
        "current_segment": None, "failed_segment": None,
    })
    generation_pool.submit(_generate_book, book_id, settings, cancel, pause)
    return {"status": "queued", "book_id": book_id}


@app.post("/v1/books/{book_id}/retry", dependencies=[Depends(require_admin)])
def retry_book_job(book_id: str):
    get_book_or_404(book_id)
    previous = library.job(book_id)
    if previous.get("status") not in {"failed", "interrupted", "cancelled"}:
        raise HTTPException(status_code=409, detail="Book generation is not retryable")
    settings = previous.get("settings")
    if not isinstance(settings, dict) or not settings.get("voice"):
        raise HTTPException(status_code=409, detail="Previous generation settings are unavailable")
    if settings["voice"] not in _voice_map():
        raise HTTPException(status_code=404, detail="Voice is unavailable")

    with jobs_lock:
        if book_id in active_jobs:
            raise HTTPException(status_code=409, detail="Book generation already running")
        cancel = threading.Event()
        pause = threading.Event()
        active_jobs[book_id] = cancel
        pause_jobs[book_id] = pause

    book = get_book_or_404(book_id)
    try:
        target_total = len(_generation_segments(book_id, book, settings))
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    library.set_job(book_id, {
        "status": "queued",
        "completed": 0,
        "total": target_total,
        "settings": settings,
        "updatedAt": _now_iso(),
        "error": None,
        "current_segment": None,
        "failed_segment": previous.get("failed_segment"),
        "retry_of_updatedAt": previous.get("updatedAt"),
    })
    generation_pool.submit(_generate_book, book_id, settings, cancel, pause)
    return {
        "status": "queued",
        "book_id": book_id,
        "retrying_segment": previous.get("failed_segment"),
    }


@app.get("/v1/books/{book_id}/job", dependencies=[Depends(require_admin)])
def book_job(book_id: str):
    get_book_or_404(book_id)
    job = library.job(book_id)
    with jobs_lock:
        active = book_id in active_jobs
    if job["status"] in {"running", "queued", "paused", "pausing"} and not active:
        job["status"] = "interrupted"
    return job


@app.post("/v1/books/{book_id}/pause", dependencies=[Depends(require_admin)])
def pause_book_job(book_id: str):
    get_book_or_404(book_id)
    with jobs_lock:
        cancel = active_jobs.get(book_id)
        pause = pause_jobs.get(book_id)
    if not cancel or not pause or cancel.is_set():
        raise HTTPException(status_code=409, detail="Book generation is not running")
    pause.set()
    job = library.job(book_id)
    if job.get("status") in {"running", "queued"}:
        job["status"] = "pausing"
        job["updatedAt"] = _now_iso()
        library.set_job(book_id, job)
    return {"pausing": True}


@app.post("/v1/books/{book_id}/resume", dependencies=[Depends(require_admin)])
def resume_book_job(book_id: str):
    get_book_or_404(book_id)
    with jobs_lock:
        cancel = active_jobs.get(book_id)
        pause = pause_jobs.get(book_id)
    if not cancel or not pause or cancel.is_set():
        raise HTTPException(status_code=409, detail="Book generation is not running")
    if not pause.is_set():
        raise HTTPException(status_code=409, detail="Book generation is not paused")
    pause.clear()
    job = library.job(book_id)
    if job.get("status") in {"paused", "pausing"}:
        job["status"] = "running"
        job["updatedAt"] = _now_iso()
        library.set_job(book_id, job)
    return {"resumed": True}


@app.post("/v1/books/{book_id}/cancel", dependencies=[Depends(require_admin)])
def cancel_book_job(book_id: str):
    get_book_or_404(book_id)
    with jobs_lock:
        cancel = active_jobs.get(book_id)
        pause = pause_jobs.get(book_id)
    if cancel:
        cancel.set()
        if pause:
            pause.clear()
    return {"cancelling": bool(cancel)}


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT)
