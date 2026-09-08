export function sanitizeDiagnostics(value, limit = 12_000) {
  return String(value || "")
    .replace(/AIzaSy[A-Za-z0-9_-]{33}/g, "[redacted-key]")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[redacted-email]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(/((?:["']?(?:access[_-]?token|refresh[_-]?token|authorization|api[_-]?key|secret)["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s&,;}]+)/gi, "$1[redacted]")
    .slice(-limit);
}

function lastMatch(value, expression) {
  const matches = [...value.matchAll(expression)];
  return matches.at(-1) || null;
}

export function extractAgyFailure(logText) {
  // Analyze the full log; truncate only diagnostics delivered to the caller.
  const log = sanitizeDiagnostics(logText, Infinity);
  const modelFailure = lastMatch(
    log,
    /calling model:\s*([A-Z][A-Z_]+)\s*\(code\s+(\d+)\):\s*([^\r\n]+)/g,
  );
  const deniedTool = lastMatch(
    log,
    /Print mode:\s*soft-denying tool confirmation\s+"([^"]+)"/g,
  );
  if (modelFailure && (!deniedTool || modelFailure.index > deniedTool.index)) {
    const message = modelFailure[3].trim();
    return {
      layer: "gemini_model_backend",
      code: modelFailure[1],
      http_status: Number(modelFailure[2]),
      reason: /user location is not supported/i.test(message)
        ? "USER_LOCATION_NOT_SUPPORTED"
        : "MODEL_REQUEST_REJECTED",
      message,
    };
  }

  if (deniedTool) {
    return {
      layer: "antigravity_tool_permission",
      code: "TOOL_CONFIRMATION_DENIED",
      tool: deniedTool[1],
      reason: "HEADLESS_PERMISSION_CONFIRMATION_UNAVAILABLE",
      message: `AGY print 模式无法交互确认工具 ${deniedTool[1]}，因此自动拒绝了调用。`,
    };
  }

  return null;
}

export function enrichAgyResult(result, logText) {
  if (result?.error) result = { ...result, error: sanitizeDiagnostics(result.error) };
  const failure = extractAgyFailure(logText);
  if (!failure) return result;

  // A recovered intermediate backend error must not override final success.
  if (result?.status === "SUCCESS" && failure.layer === "gemini_model_backend") {
    return { ...result, diagnostic_warning: failure };
  }

  if (failure.layer === "gemini_model_backend") {
    return {
      ...(result || { status: "ERROR", response: "" }),
      status: "ERROR",
      error:
        `Gemini 后端错误：${failure.code} (HTTP ${failure.http_status}): ${failure.message}`,
      error_details: failure,
    };
  }

  const hasResponse = Boolean(String(result?.response || "").trim());
  if (result?.status === "SUCCESS" && hasResponse) return result;
  return {
    ...(result || { response: "" }),
    status: "ERROR",
    error: failure.message,
    error_details: failure,
  };
}
