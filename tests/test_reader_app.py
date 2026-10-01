import json

from fastapi.testclient import TestClient

import reader_server.app as app_module
from reader_server.book_library import BookLibrary
from reader_server.cvs_client import CVSError


client = TestClient(app_module.app)


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
