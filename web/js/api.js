export class ReaderApiError extends Error {
  constructor(message, { status = 0, code = "request_failed", detail = null } = {}) {
    super(message);
    this.name = "ReaderApiError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function conciseStatusMessage(status) {
  if (status === 502) return "语音服务上游不可用（HTTP 502）";
  if (status === 503) return "Character Voice Service 不可用（HTTP 503）";
  if (status === 504) return "语音服务请求超时（HTTP 504）";
  if (status === 401 || status === 403) return `请求未授权（HTTP ${status}）`;
  if (status >= 400 && status < 500) return `请求被拒绝（HTTP ${status}）`;
  if (status >= 500) return `语音服务内部错误（HTTP ${status}）`;
  return `请求失败（HTTP ${status || "unknown"}）`;
}

export async function readError(response) {
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("json")) {
    try {
      const body = await response.json();
      const detail = body?.detail || body?.error || body?.message;
      if (detail) {
        const text = String(detail);
        const generic = conciseStatusMessage(response.status);
        return new ReaderApiError(
          response.status >= 500 ? generic : text,
          { status: response.status, detail: text }
        );
      }
    } catch (_) {}
  }
  return new ReaderApiError(conciseStatusMessage(response.status), {
    status: response.status,
    code: contentType.includes("text/html") ? "html_upstream_error" : "http_error"
  });
}

export async function fetchJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    throw new ReaderApiError("无法连接到 Character Voice Reader 服务。", {
      code: "network_error", detail: error?.message || String(error)
    });
  }
  if (!response.ok) throw await readError(response);
  try {
    return await response.json();
  } catch (error) {
    throw new ReaderApiError("服务返回了无效 JSON。", {
      status: response.status, code: "invalid_json", detail: error?.message || String(error)
    });
  }
}

export async function fetchSpeech(payload, { signal } = {}) {
  let response;
  try {
    response = await fetch("/v1/audio/speech", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify(payload)
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new ReaderApiError("无法连接到语音服务。", {
      code: "network_error", detail: error?.message || String(error)
    });
  }
  if (!response.ok) throw await readError(response);
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.startsWith("audio/wav") && !contentType.startsWith("audio/x-wav")) {
    throw new ReaderApiError(`语音服务返回了非 WAV 响应：${contentType || "unknown"}`, {
      status: response.status, code: "non_audio_response"
    });
  }
  return response;
}
