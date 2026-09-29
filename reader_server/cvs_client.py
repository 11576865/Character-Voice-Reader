import httpx

from reader_server.config import CVS_ADMIN_TOKEN, CVS_BASE_URL


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

    def json(self, method: str, path: str, *, body=None, admin: bool = False, timeout: float = 30):
        try:
            response = httpx.request(
                method,
                self._url(path),
                json=body,
                headers=self._headers(admin=admin),
                timeout=timeout,
            )
        except httpx.HTTPError as exc:
            raise CVSError(503, f"Character Voice Service unavailable: {exc}") from exc
        if response.status_code >= 400:
            try:
                detail = response.json().get("detail")
            except Exception:
                detail = response.text
            raise CVSError(response.status_code, str(detail or response.text))
        return response.json()

    def speech(self, payload: dict) -> tuple[bytes, dict]:
        try:
            response = httpx.post(self._url("/v1/audio/speech"), json=payload, timeout=180)
        except httpx.HTTPError as exc:
            raise CVSError(503, f"Character Voice Service unavailable: {exc}") from exc
        if response.status_code >= 400:
            try:
                detail = response.json().get("detail")
            except Exception:
                detail = response.text
            raise CVSError(response.status_code, str(detail or response.text))
        return response.content, dict(response.headers)

    def bytes(self, path: str, *, admin: bool = False) -> tuple[bytes, str]:
        try:
            response = httpx.get(
                self._url(path),
                headers=self._headers(admin=admin),
                timeout=30,
            )
        except httpx.HTTPError as exc:
            raise CVSError(503, f"Character Voice Service unavailable: {exc}") from exc
        if response.status_code >= 400:
            raise CVSError(response.status_code, response.text)
        return response.content, response.headers.get(
            "content-type", "application/octet-stream"
        )

    def health(self) -> dict:
        try:
            return self.json("GET", "/health", timeout=3)
        except CVSError as exc:
            return {"status": "offline", "error": str(exc)}
