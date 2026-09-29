import os
import secrets
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = PROJECT_ROOT / "web"
DATA_DIR = Path(os.environ.get("CVR_DATA_DIR", str(PROJECT_ROOT / "data"))).expanduser()

CVS_BASE_URL = os.environ.get("CVS_BASE_URL", "http://127.0.0.1:9881").rstrip("/")
CVS_ADMIN_TOKEN = os.environ.get("CVS_ADMIN_TOKEN", "").strip()

HOST = os.environ.get("CVR_HOST", "0.0.0.0")
PORT = int(os.environ.get("CVR_PORT", "9890"))


def _admin_token() -> str:
    configured = os.environ.get("CVR_ADMIN_TOKEN", "").strip()
    if configured:
        return configured
    path = DATA_DIR / "admin-token.txt"
    if path.exists():
        return path.read_text(encoding="utf-8").strip()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    generated = secrets.token_urlsafe(32)
    path.write_text(generated + "\n", encoding="utf-8")
    return generated


ADMIN_TOKEN = _admin_token()
