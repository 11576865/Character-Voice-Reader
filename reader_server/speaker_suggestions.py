"""Suggest only explicit character-name prefixes; never silently assign speakers."""

import re


_PREFIX = re.compile(r"^\s*([^:：\n]{1,32})\s*[:：]\s*\S")


def suggest_speakers(book: dict, voices: list[dict]) -> list[dict]:
    names = {}
    for voice in voices:
        if voice.get("error"):
            continue
        for label in (voice.get("id"), voice.get("name")):
            if label:
                names.setdefault(str(label).casefold(), set()).add(voice["id"])
    suggestions = []
    for chapter_index, chapter in enumerate(book["document"]["chapters"]):
        for paragraph_index, paragraph in enumerate(chapter["paragraphs"]):
            key = f"{chapter_index}:{paragraph_index}"
            if key in book.get("annotations", {}):
                continue
            match = _PREFIX.match(paragraph)
            if not match:
                continue
            candidates = names.get(match.group(1).strip().casefold(), set())
            if len(candidates) == 1:
                suggestions.append({"paragraph": key, "voice": next(iter(candidates)),
                                    "reason": "explicit name prefix", "text": paragraph[:100]})
    return suggestions
