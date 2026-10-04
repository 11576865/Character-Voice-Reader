from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_reader_uses_cvr_namespace_with_legacy_copy_forward():
    reader = (ROOT / "web" / "js" / "reader.js").read_text(encoding="utf-8")
    progress = (ROOT / "web" / "js" / "progress.js").read_text(encoding="utf-8")
    variants = (ROOT / "web" / "js" / "variants.js").read_text(encoding="utf-8")
    offline = (ROOT / "web" / "js" / "offline.js").read_text(encoding="utf-8")

    for key in (
        "cvr.voices.cache",
        "cvr.reader.fontSize",
        "cvr.reader.lineHeight",
        "cvr.reader.readingWidth",
        "cvr.reader.paragraphGap",
        "cvr.reader.theme",
        "cvr.reader.prefetchAhead",
        "cvr.bookmarks.v1:",
    ):
        assert key in reader

    assert 'PROGRESS_KEY_PREFIX = "cvr.reader.progress.v1:"' in progress
    assert 'LEGACY_PROGRESS_KEY_PREFIX = "cvs.reader.progress.v1:"' in progress
    assert 'DB_NAME = "character-voice-reader-variants"' in variants
    assert 'LEGACY_DB_NAME = "cvs-reader-variants"' in variants
    assert 'DB = "character-voice-reader-offline"' in offline
    assert 'LEGACY_DB = "cvs-offline-library"' in offline


def test_service_worker_and_entry_assets_share_explicit_revision():
    index = (ROOT / "web" / "index.html").read_text(encoding="utf-8")
    service_worker = (ROOT / "web" / "sw.js").read_text(encoding="utf-8")

    assert 'reader.css?v=4' in index
    assert 'reader.js?v=4' in index
    assert 'character-voice-reader-shell-v4' in service_worker
    assert 'ignoreSearch: true' in service_worker
    assert '"/reader-assets/reader.css"' in service_worker
    assert '"/reader-assets/js/api.js"' in service_worker
