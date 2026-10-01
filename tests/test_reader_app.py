import json

from fastapi.testclient import TestClient

import reader_server.app as app_module
from reader_server.book_library import BookLibrary
from reader_server.cvs_client import CVSError


client = TestClient(app_module.app)


class FakeLedger:
    def __init__(self):
        self.items = []

    def append(self, **kwargs):
        record = {
            "id": f"g-{len(self.items) + 1}",
            "createdAt": "2026-10-02T00:00:00+00:00",
            "source": kwargs["source"],
            "book_id": kwargs.get("book_id"),
            "segment_id": kwargs.get("segment_id"),
            "voice": kwargs["metadata"].get("voice"),
            "model": kwargs["metadata"].get("model"),
            "engine": kwargs["metadata"].get("engine"),
            "runtime": kwargs["metadata"].get("runtime"),
            "runtime_revision": kwargs["metadata"].get("runtime_revision"),
            "generation_revision": kwargs["metadata"].get("generation_revision"),
            "input_sha256": "i" * 64,
            "output_sha256": "o" * 64,
            "output_bytes": len(kwargs["audio"]),
        }
        self.items.append(record)
        return record

    def recent(self, *, limit=50, book_id=None, segment_id=None):
        items = list(reversed(self.items))
        if book_id is not None:
            items = [item for item in items if item.get("book_id") == book_id]
        if segment_id is not None:
            items = [item for item in items if item.get("segment_id") == segment_id]
        return items[:limit]


class FakeCVS:
    def health(self):
        return {"status": "ok"}

    def json(self, method, path, **kwargs):
        if path == "/v1/voices":
            return {"voices": [{
                "id": "march-7th",
                "name": "March 7th",
                "default_model": "local-v4",
                "models": [{
                    "id": "local-v4",
                    "name": "Local v4",
                    "model_id": "march7-gsv-v4-a",
                    "revision": "abc",
                }],
                "default_reference": "neutral",
                "references": [{
                    "id": "neutral",
                    "name": "Neutral",
                    "language": "en",
                    "emotion": "neutral",
                    "quality": "good",
                    "intensity": 0.5,
                }],
            }]}
        if path == "/v1/audio/resolve":
            payload = kwargs.get("body") or {}
            return {
                "voice": payload.get("voice"),
                "model": "march7-gsv-v4-a",
                "model_revision": "abc",
                "engine": "gpt-sovits",
                "runtime": "gpt-sovits-local",
                "runtime_revision": "r" * 64,
                "binding": "march-gpt",
                "binding_revision": "b" * 64,
                "reference": payload.get("reference_id") or "neutral",
                "reference_reason": "manual",
                "generation_revision": "g" * 64,
            }
        raise AssertionError(path)

    def speech(self, payload):
        return b"RIFF....WAVE", {
            "content-type": "audio/wav",
            "x-selected-reference": payload.get("reference_id") or "neutral",
            "x-cvs-engine": "gpt-sovits",
            "x-cvs-model": "march7-gsv-v4-a",
            "x-cvs-model-revision": "abc",
            "x-cvs-runtime": "gpt-sovits-local",
            "x-cvs-runtime-revision": "r" * 64,
            "x-cvs-binding": "march-gpt",
            "x-cvs-binding-revision": "b" * 64,
            "x-cvs-generation-revision": "g" * 64,
        }

    def bytes(self, path, **kwargs):
        return b"RIFF....WAVE", "audio/wav"


def test_reader_root_and_health(monkeypatch):
    monkeypatch.setattr(app_module, "cvs", FakeCVS())
    assert client.get("/").status_code == 200
    assert "Character Voice" in client.get("/").text
    health = client.get("/health").json()
    assert health["service"] == "character-voice-reader"


def test_voice_and_speech_are_cvs_contract_proxies(monkeypatch):
    monkeypatch.setattr(app_module, "cvs", FakeCVS())
    ledger = FakeLedger()
    monkeypatch.setattr(app_module, "generation_ledger", ledger)
    voices = client.get("/v1/voices")
    assert voices.status_code == 200
    assert voices.json()["voices"][0]["id"] == "march-7th"

    speech = client.post("/v1/audio/speech", json={
        "voice": "march-7th",
        "model_id": "local-v4",
        "reference_id": "neutral",
        "input": "Hello",
        "speed": 1.0,
    })
    assert speech.status_code == 200
    assert speech.content.startswith(b"RIFF")
    assert speech.headers["x-selected-reference"] == "neutral"
    assert speech.headers["x-cvs-generation-revision"] == "g" * 64
    assert speech.headers["x-cvs-runtime"] == "gpt-sovits-local"
    assert speech.headers["x-cvs-runtime-revision"] == "r" * 64
    assert speech.headers["x-cvs-binding"] == "march-gpt"
    assert ledger.items[0]["source"] == "interactive"
    assert ledger.items[0]["runtime"] == "gpt-sovits-local"


def test_generation_resolve_is_cvs_contract_proxy(monkeypatch):
    monkeypatch.setattr(app_module, "cvs", FakeCVS())
    response = client.post("/v1/audio/resolve", json={
        "voice": "march-7th",
        "model_id": "local-v4",
        "reference_id": "neutral",
        "input": "Hello",
        "speed": 1.0,
    })
    assert response.status_code == 200
    payload = response.json()
    assert payload["engine"] == "gpt-sovits"
    assert payload["runtime"] == "gpt-sovits-local"
    assert payload["runtime_revision"] == "r" * 64
    assert payload["generation_revision"] == "g" * 64


def test_book_library_is_reader_owned(tmp_path, monkeypatch):
    monkeypatch.setattr(app_module, "cvs", FakeCVS())
    monkeypatch.setattr(app_module, "library", BookLibrary(tmp_path / "data"))

    document = {"title": "Test", "chapters": [{"title": "One", "paragraphs": ["Hello."]}]}
    segments = [{
        "chapterIndex": 0, "paragraphIndex": 0,
        "start": 0, "end": 6, "text": "Hello.",
    }]
    created = app_module.library.put_book(document, segments, kind="txt")
    assert created["title"] == "Test"
    assert app_module.library.list_books()[0]["id"] == created["id"]


def test_book_generation_persists_runtime_provenance(tmp_path, monkeypatch):
    fake = FakeCVS()
    monkeypatch.setattr(app_module, "cvs", fake)
    library = BookLibrary(tmp_path / "data")
    monkeypatch.setattr(app_module, "library", library)
    ledger = FakeLedger()
    monkeypatch.setattr(app_module, "generation_ledger", ledger)
    ledger = FakeLedger()
    monkeypatch.setattr(app_module, "generation_ledger", ledger)

    document = {"title": "Test", "chapters": [{"title": "One", "paragraphs": ["Hello."]}]}
    segments = [{
        "chapterIndex": 0, "paragraphIndex": 0,
        "start": 0, "end": 6, "text": "Hello.",
    }]
    book = library.put_book(document, segments, kind="txt")

    app_module._generate_book(
        book["id"],
        {
            "voice": "march-7th",
            "model_id": "local-v4",
            "reference_id": "neutral",
            "speed": 1.0,
            "continuous_emotion": False,
        },
        __import__("threading").Event(),
        __import__("threading").Event(),
    )

    state = library.versions(book["id"])
    item = next(iter(state.values()))
    version = item["versions"][0]
    metadata = version["metadata"]
    assert metadata["engine"] == "gpt-sovits"
    assert metadata["runtime"] == "gpt-sovits-local"
    assert metadata["runtime_revision"] == "r" * 64
    assert metadata["binding"] == "march-gpt"
    assert metadata["generation_revision"] == "g" * 64
    assert metadata["fingerprint"]


def test_generation_history_endpoint_is_admin_protected(monkeypatch):
    ledger = FakeLedger()
    ledger.append(
        source="interactive",
        text="Hello",
        audio=b"RIFF....WAVE",
        metadata={
            "voice": "march-7th",
            "model": "march7-gsv-v4-a",
            "engine": "gpt-sovits",
            "runtime": "gpt-sovits-local",
            "runtime_revision": "r" * 64,
            "generation_revision": "g" * 64,
        },
    )
    monkeypatch.setattr(app_module, "generation_ledger", ledger)

    assert client.get("/v1/generation-history").status_code == 401
    response = client.get(
        "/v1/generation-history?limit=10",
        headers={"X-CVR-Token": app_module.ADMIN_TOKEN},
    )
    assert response.status_code == 200
    item = response.json()["items"][0]
    assert item["engine"] == "gpt-sovits"
    assert item["runtime"] == "gpt-sovits-local"
    assert item["input_sha256"] == "i" * 64
    assert item["output_sha256"] == "o" * 64


def test_failed_book_generation_can_be_retried(tmp_path, monkeypatch):
    fake = FakeCVS()
    monkeypatch.setattr(app_module, "cvs", fake)
    library = BookLibrary(tmp_path / "data")
    monkeypatch.setattr(app_module, "library", library)
    monkeypatch.setattr(app_module, "generation_ledger", FakeLedger())

    document = {"title": "Retry", "chapters": [{"title": "One", "paragraphs": ["Hello."]}]}
    segments = [{
        "chapterIndex": 0, "paragraphIndex": 0,
        "start": 0, "end": 6, "text": "Hello.",
    }]
    book = library.put_book(document, segments, kind="txt")
    failed_segment = {
        "id": book["segments"][0]["id"],
        "index": 0,
        "chapterIndex": 0,
        "paragraphIndex": 0,
    }
    library.set_job(book["id"], {
        "status": "failed",
        "completed": 0,
        "total": 1,
        "settings": {
            "voice": "march-7th",
            "model_id": "local-v4",
            "reference_id": "neutral",
            "speed": 1.0,
            "continuous_emotion": False,
        },
        "updatedAt": "2026-10-02T00:00:00+00:00",
        "error": "temporary failure",
        "current_segment": failed_segment,
        "failed_segment": failed_segment,
    })

    class ImmediatePool:
        def submit(self, fn, *args):
            fn(*args)

    monkeypatch.setattr(app_module, "generation_pool", ImmediatePool())

    response = client.post(
        f"/v1/books/{book['id']}/retry",
        headers={"X-CVR-Token": app_module.ADMIN_TOKEN},
    )
    assert response.status_code == 200
    assert response.json()["retrying_segment"]["id"] == failed_segment["id"]

    job = library.job(book["id"])
    assert job["status"] == "completed"
    assert job["error"] is None
    state = library.versions(book["id"])
    assert book["segments"][0]["id"] in state


def test_book_generation_can_pause_and_resume(tmp_path, monkeypatch):
    fake = FakeCVS()
    monkeypatch.setattr(app_module, "cvs", fake)
    library = BookLibrary(tmp_path / "data")
    monkeypatch.setattr(app_module, "library", library)
    monkeypatch.setattr(app_module, "generation_ledger", FakeLedger())

    document = {
        "title": "Pause",
        "chapters": [{"title": "One", "paragraphs": ["Hello.", "World."]}],
    }
    segments = [
        {"chapterIndex": 0, "paragraphIndex": 0, "start": 0, "end": 6, "text": "Hello."},
        {"chapterIndex": 0, "paragraphIndex": 1, "start": 0, "end": 6, "text": "World."},
    ]
    book = library.put_book(document, segments, kind="txt")

    cancel = __import__("threading").Event()
    pause = __import__("threading").Event()
    app_module.active_jobs[book["id"]] = cancel
    app_module.pause_jobs[book["id"]] = pause
    library.set_job(book["id"], {
        "status": "running",
        "completed": 0,
        "total": 2,
        "settings": {
            "voice": "march-7th",
            "model_id": "local-v4",
            "reference_id": "neutral",
            "speed": 1.0,
            "continuous_emotion": False,
        },
        "updatedAt": "2026-10-02T00:00:00+00:00",
        "error": None,
        "current_segment": None,
        "failed_segment": None,
    })

    pause_response = client.post(
        f"/v1/books/{book['id']}/pause",
        headers={"X-CVR-Token": app_module.ADMIN_TOKEN},
    )
    assert pause_response.status_code == 200
    assert pause.is_set()
    assert library.job(book["id"])["status"] == "pausing"

    resume_response = client.post(
        f"/v1/books/{book['id']}/resume",
        headers={"X-CVR-Token": app_module.ADMIN_TOKEN},
    )
    assert resume_response.status_code == 200
    assert not pause.is_set()
    assert library.job(book["id"])["status"] == "running"

    app_module.active_jobs.pop(book["id"], None)
    app_module.pause_jobs.pop(book["id"], None)


def test_cancel_wakes_paused_book_generation(tmp_path, monkeypatch):
    library = BookLibrary(tmp_path / "data")
    monkeypatch.setattr(app_module, "library", library)

    document = {"title": "Cancel", "chapters": [{"title": "One", "paragraphs": ["Hello."]}]}
    segments = [{
        "chapterIndex": 0, "paragraphIndex": 0,
        "start": 0, "end": 6, "text": "Hello.",
    }]
    book = library.put_book(document, segments, kind="txt")

    cancel = __import__("threading").Event()
    pause = __import__("threading").Event()
    pause.set()
    app_module.active_jobs[book["id"]] = cancel
    app_module.pause_jobs[book["id"]] = pause

    response = client.post(
        f"/v1/books/{book['id']}/cancel",
        headers={"X-CVR-Token": app_module.ADMIN_TOKEN},
    )
    assert response.status_code == 200
    assert cancel.is_set()
    assert not pause.is_set()

    app_module.active_jobs.pop(book["id"], None)
    app_module.pause_jobs.pop(book["id"], None)


def test_scoped_book_generation_supports_missing_and_chapter(tmp_path, monkeypatch):
    fake = FakeCVS()
    monkeypatch.setattr(app_module, "cvs", fake)
    library = BookLibrary(tmp_path / "data")
    monkeypatch.setattr(app_module, "library", library)
    monkeypatch.setattr(app_module, "generation_ledger", FakeLedger())

    document = {
        "title": "Scoped",
        "chapters": [
            {"title": "One", "paragraphs": ["A.", "B."]},
            {"title": "Two", "paragraphs": ["C."]},
        ],
    }
    segments = [
        {"chapterIndex": 0, "paragraphIndex": 0, "start": 0, "end": 2, "text": "A."},
        {"chapterIndex": 0, "paragraphIndex": 1, "start": 0, "end": 2, "text": "B."},
        {"chapterIndex": 1, "paragraphIndex": 0, "start": 0, "end": 2, "text": "C."},
    ]
    book = library.put_book(document, segments, kind="txt")

    first = book["segments"][0]
    library.add_version(
        book["id"],
        first["id"],
        b"RIFF....WAVE",
        {
            "voice": "march-7th",
            "model_alias": "local-v4",
            "model_id": "march7-gsv-v4-a",
            "generation_revision": "g" * 64,
            "fingerprint": "existing",
        },
    )

    missing = app_module._generation_segments(
        book["id"],
        book,
        {"scope": "missing"},
    )
    assert [item["id"] for item in missing] == [
        book["segments"][1]["id"],
        book["segments"][2]["id"],
    ]

    chapter = app_module._generation_segments(
        book["id"],
        book,
        {"scope": "chapter", "chapter_index": 1},
    )
    assert [item["id"] for item in chapter] == [book["segments"][2]["id"]]


def test_generate_endpoint_accepts_chapter_scope(tmp_path, monkeypatch):
    fake = FakeCVS()
    monkeypatch.setattr(app_module, "cvs", fake)
    library = BookLibrary(tmp_path / "data")
    monkeypatch.setattr(app_module, "library", library)
    monkeypatch.setattr(app_module, "generation_ledger", FakeLedger())

    document = {
        "title": "Chapter",
        "chapters": [
            {"title": "One", "paragraphs": ["A."]},
            {"title": "Two", "paragraphs": ["B."]},
        ],
    }
    segments = [
        {"chapterIndex": 0, "paragraphIndex": 0, "start": 0, "end": 2, "text": "A."},
        {"chapterIndex": 1, "paragraphIndex": 0, "start": 0, "end": 2, "text": "B."},
    ]
    book = library.put_book(document, segments, kind="txt")

    class ImmediatePool:
        def submit(self, fn, *args):
            fn(*args)

    monkeypatch.setattr(app_module, "generation_pool", ImmediatePool())

    response = client.post(
        f"/v1/books/{book['id']}/generate",
        headers={"X-CVR-Token": app_module.ADMIN_TOKEN},
        json={
            "voice": "march-7th",
            "model_id": "local-v4",
            "reference_id": "neutral",
            "speed": 1.0,
            "continuous_emotion": False,
            "scope": "chapter",
            "chapter_index": 1,
        },
    )
    assert response.status_code == 200
    state = library.versions(book["id"])
    assert book["segments"][0]["id"] not in state
    assert book["segments"][1]["id"] in state
