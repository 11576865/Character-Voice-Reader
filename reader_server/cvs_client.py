import httpx

from reader_server.config import CVS_ADMIN_TOKEN, CVS_BASE_URL


MAX_ERROR_DETAIL = 500


def _normalized_error(response: httpx.Response) -> str:
    """Return a short human-readable upstream error without dumping HTML pages."""
    content_type = (response.headers.get("content-type") or "").lower()
    if "application/json" in content_type or content_type.endswith("+json"):
        try:
            payload = response.json()
            if isinstance(payload, dict):
                detail = payload.get("detail") or payload.get("error") or payload.get("message")
                if detail:
                    return str(detail)[:MAX_ERROR_DETAIL]
        except Exception:
            pass

    status = response.status_code
    if status in {502, 503, 504}:
        return f"Character Voice Service upstream unavailable (HTTP {status})"
    if "text/html" in content_type:
        return f"Character Voice Service returned an HTML error page (HTTP {status})"

    text = (response.text or "").strip()
    if not text:
        return f"Character Voice Service request failed (HTTP {status})"
    single_line = " ".join(text.split())
    if len(single_line) > MAX_ERROR_DETAIL:
        single_line = single_line[:MAX_ERROR_DETAIL].rstrip() + "…"
    return single_line


class CVSError(RuntimeError):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


class CVSClient:
    def __init__(self, base_url: str = CVS_BASE_URL, admin_token: str = CVS_ADMIN_TOKEN):
        self.base_url = base_url.rstrip("/")
        self.admin_token = admin_token

    def _url(self, path: str) -> str:
        return self.base_url + (path if path.startswith("/") else "/" + path)

    def _headers(self, *, admin: bool = False) -> dict[str, str]:
        headers: dict[str, str] = {}
        if admin and self.admin_token:
            headers["X-CVS-Token"] = self.admin_token
        return headers

    def _request(self, method: str, path: str, *, timeout: float, **kwargs) -> httpx.Response:
        try:
            response = httpx.request(
                method,
                self._url(path),
                headers=self._headers(admin=bool(kwargs.pop("admin", False))),
                timeout=timeout,
                **kwargs,
            )
        except httpx.TimeoutException as exc:
            raise CVSError(504, "Character Voice Service request timed out") from exc
        except httpx.HTTPError as exc:
            raise CVSError(503, f"Character Voice Service unavailable: {exc}") from exc

        if response.status_code >= 400:
            raise CVSError(response.status_code, _normalized_error(response))
        return response

    def json(self, method: str, path: str, *, body=None, admin: bool = False, timeout: float = 30):
        response = self._request(
            method, path, timeout=timeout, json=body, admin=admin
        )
        try:
            return response.json()
        except Exception as exc:
            raise CVSError(
                502,
                f"Character Voice Service returned invalid JSON ({response.headers.get('content-type', 'unknown')})",
            ) from exc

    def speech(self, payload: dict) -> tuple[bytes, dict]:
        response = self._request(
            "POST", "/v1/audio/speech", timeout=180, json=payload
        )
        content_type = (response.headers.get("content-type") or "").lower()
        if not (content_type.startswith("audio/wav") or content_type.startswith("audio/x-wav")):
            raise CVSError(
                502,
                f"Character Voice Service returned non-WAV audio response: {content_type or 'unknown'}",
            )
        return response.content, dict(response.headers)

    def bytes(self, path: str, *, admin: bool = False) -> tuple[bytes, str]:
        response = self._request("GET", path, timeout=30, admin=admin)
        return response.content, response.headers.get(
            "content-type", "application/octet-stream"
        )

    def health(self) -> dict:
        try:
            return self.json("GET", "/health", timeout=3)
        except CVSError as exc:
            return {"status": "offline", "error": str(exc)}
