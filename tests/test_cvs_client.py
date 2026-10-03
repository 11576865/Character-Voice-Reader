import httpx
import pytest

from reader_server.cvs_client import CVSClient, CVSError


def test_html_502_is_normalized(monkeypatch):
    def fake_request(*args, **kwargs):
        return httpx.Response(
            502,
            headers={"content-type": "text/html; charset=UTF-8"},
            text="<!DOCTYPE html><html><body>" + ("bad gateway " * 1000) + "</body></html>",
            request=httpx.Request("POST", "https://example.invalid/v1/audio/speech"),
        )

    monkeypatch.setattr(httpx, "request", fake_request)
    client = CVSClient("https://example.invalid")

    with pytest.raises(CVSError) as exc:
        client.speech({"voice": "test", "input": "hello"})

    assert exc.value.status_code == 502
    assert str(exc.value) == "Character Voice Service upstream unavailable (HTTP 502)"
    assert "<!DOCTYPE" not in str(exc.value)


def test_json_error_detail_is_preserved(monkeypatch):
    def fake_request(*args, **kwargs):
        return httpx.Response(
            400,
            headers={"content-type": "application/json"},
            json={"detail": "reference not found"},
            request=httpx.Request("POST", "https://example.invalid/v1/audio/speech"),
        )

    monkeypatch.setattr(httpx, "request", fake_request)
    client = CVSClient("https://example.invalid")

    with pytest.raises(CVSError) as exc:
        client.speech({"voice": "test", "input": "hello"})

    assert exc.value.status_code == 400
    assert str(exc.value) == "reference not found"


def test_non_wav_success_is_rejected(monkeypatch):
    def fake_request(*args, **kwargs):
        return httpx.Response(
            200,
            headers={"content-type": "text/html"},
            text="<html>unexpected proxy page</html>",
            request=httpx.Request("POST", "https://example.invalid/v1/audio/speech"),
        )

    monkeypatch.setattr(httpx, "request", fake_request)
    client = CVSClient("https://example.invalid")

    with pytest.raises(CVSError) as exc:
        client.speech({"voice": "test", "input": "hello"})

    assert exc.value.status_code == 502
    assert "non-WAV" in str(exc.value)
