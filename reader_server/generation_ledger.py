"""Append-only generation provenance ledger for Reader-owned requests."""

from __future__ import annotations

import hashlib
import json
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


class GenerationLedger:
    """Persist immutable generation events without storing source text."""

    def __init__(self, root: Path):
        self.path = Path(root) / "generation-ledger.jsonl"
        self.lock = threading.RLock()

    def append(
        self,
        *,
        source: str,
        text: str,
        audio: bytes,
        metadata: dict[str, Any],
        book_id: str | None = None,
        segment_id: str | None = None,
    ) -> dict[str, Any]:
        if source not in {"interactive", "book"}:
            raise ValueError("generation source must be interactive or book")
        if not isinstance(text, str) or not text:
            raise ValueError("generation text must be non-empty")
        if not isinstance(audio, (bytes, bytearray)) or not audio:
            raise ValueError("generation audio must be non-empty bytes")

        record = {
            "id": "g-" + uuid.uuid4().hex,
            "createdAt": _now(),
            "source": source,
            "book_id": book_id,
            "segment_id": segment_id,
            "voice": metadata.get("voice"),
            "model": metadata.get("model") or metadata.get("model_id"),
            "model_revision": metadata.get("model_revision"),
            "engine": metadata.get("engine"),
            "runtime": metadata.get("runtime"),
            "runtime_revision": metadata.get("runtime_revision"),
            "binding": metadata.get("binding"),
            "binding_revision": metadata.get("binding_revision"),
            "generation_revision": metadata.get("generation_revision"),
            "reference_id": metadata.get("reference_id"),
            "speed": metadata.get("speed"),
            "request_id": metadata.get("request_id"),
            "input_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
            "output_sha256": _sha256_bytes(bytes(audio)),
            "output_bytes": len(audio),
        }

        self.path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(
            record,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        with self.lock:
            with self.path.open("a", encoding="utf-8", newline="\n") as handle:
                handle.write(line + "\n")
                handle.flush()
        return record

    def recent(
        self,
        *,
        limit: int = 50,
        book_id: str | None = None,
        segment_id: str | None = None,
    ) -> list[dict[str, Any]]:
        if not 1 <= int(limit) <= 200:
            raise ValueError("limit must be between 1 and 200")
        if not self.path.is_file():
            return []

        with self.lock:
            lines = self.path.read_text(encoding="utf-8").splitlines()

        result: list[dict[str, Any]] = []
        for line in reversed(lines):
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if book_id is not None and record.get("book_id") != book_id:
                continue
            if segment_id is not None and record.get("segment_id") != segment_id:
                continue
            result.append(record)
            if len(result) >= limit:
                break
        return result
