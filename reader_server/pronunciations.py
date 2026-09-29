"""Book-specific spoken-text substitutions; displayed book text stays unchanged."""


def validate_rules(rules: dict) -> dict[str, str]:
    if not isinstance(rules, dict) or len(rules) > 100:
        raise ValueError("Pronunciation rules must be an object with at most 100 entries")
    clean = {}
    for source, replacement in rules.items():
        if not isinstance(source, str) or not isinstance(replacement, str) or \
                not 1 <= len(source.strip()) <= 100 or not 1 <= len(replacement.strip()) <= 100:
            raise ValueError("Pronunciation source and replacement must be 1–100 characters")
        clean[source.strip()] = replacement.strip()
    return clean


def spoken_text(text: str, rules: dict[str, str]) -> str:
    for source in sorted(rules, key=len, reverse=True):
        text = text.replace(source, rules[source])
    return text
