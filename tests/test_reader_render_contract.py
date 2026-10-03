from pathlib import Path


READER_JS = Path(__file__).resolve().parents[1] / "web" / "js" / "reader.js"


def _function_body(source: str, name: str, next_name: str) -> str:
    start = source.index(f"function {name}(")
    end = source.index(f"function {next_name}(", start)
    return source[start:end]


def test_render_body_does_not_write_progress_from_undefined_locals():
    source = READER_JS.read_text(encoding="utf-8")
    body = _function_body(source, "renderBody", "fillParagraphReferences")

    assert "/progress" not in body
    assert "position.index" not in body
    assert "audioTime: time" not in body


def test_progress_write_remains_owned_by_explicit_progress_paths():
    source = READER_JS.read_text(encoding="utf-8")

    assert "function saveProgress(" in source
    assert "/progress" in source
