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
        raise AssertionError(path)

    def speech(self, payload):
        return b"RIFF....WAVE", {
            "content-type": "audio/wav",
            "x-selected-reference": payload.get("reference_id") or "neutral",
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
