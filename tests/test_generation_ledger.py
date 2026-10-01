import hashlib

from reader_server.generation_ledger import GenerationLedger


def test_generation_ledger_is_append_only_and_filters(tmp_path):
    ledger = GenerationLedger(tmp_path / "data")

    first = ledger.append(
        source="interactive",
        text="Hello",
        audio=b"RIFF....WAVE",
        metadata={
            "voice": "march-7th",
            "model": "model-a",
            "engine": "gpt-sovits",
            "runtime": "gpt-local",
            "runtime_revision": "r1",
            "generation_revision": "g1",
        },
    )
    second = ledger.append(
        source="book",
        text="World",
        audio=b"RIFF....WAVE2",
        book_id="b-" + "a" * 24,
        segment_id="s-" + "b" * 24,
        metadata={
            "voice": "march-7th",
            "model": "model-b",
            "engine": "index-tts",
            "runtime": "index-local",
            "runtime_revision": "r2",
            "generation_revision": "g2",
        },
    )

    assert first["input_sha256"] == hashlib.sha256(b"Hello").hexdigest()
    assert second["output_sha256"] == hashlib.sha256(b"RIFF....WAVE2").hexdigest()

    recent = ledger.recent(limit=10)
    assert [item["id"] for item in recent] == [second["id"], first["id"]]

    filtered = ledger.recent(limit=10, book_id="b-" + "a" * 24)
    assert [item["id"] for item in filtered] == [second["id"]]

    lines = ledger.path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 2
