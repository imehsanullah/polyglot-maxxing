import type {
  BackgroundRequest,
  BackgroundResponse,
  WordInsightStreamEvent,
  WordInsightStreamStart,
} from "../src/domain/types";
import { WORD_INSIGHT_STREAM_PORT } from "../src/domain/types";

const COMPANION_BASE_URL = "http://127.0.0.1:8765";

async function request<T>(message: BackgroundRequest): Promise<BackgroundResponse<T>> {
  try {
    const isCompanion = message.type === "COMPANION_REQUEST";
    const url = isCompanion ? `${COMPANION_BASE_URL}${message.path}` : message.url;
    const response = await fetch(url, {
      method: isCompanion ? message.method ?? "GET" : "GET",
      credentials: isCompanion ? "same-origin" : "include",
      headers: {
        ...(isCompanion && message.body ? { "Content-Type": "application/json" } : {}),
        ...(!isCompanion ? message.headers : {}),
      },
      body: isCompanion && message.body ? JSON.stringify(message.body) : undefined,
    });
    const contentType = response.headers.get("content-type") ?? "";
    const data = contentType.includes("application/json")
      ? await response.json()
      : await response.text();
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error:
          typeof data === "string"
            ? data
            : JSON.stringify(data),
      };
    }
    return { ok: true, status: response.status, data: data as T };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message: BackgroundRequest) => request(message));

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== WORD_INSIGHT_STREAM_PORT) return;
    const controller = new AbortController();
    let started = false;
    port.onDisconnect.addListener(() => controller.abort());
    port.onMessage.addListener((message: WordInsightStreamStart) => {
      if (started || message.type !== "start") return;
      started = true;
      void streamWordInsight(port, message, controller.signal);
    });
  });
});

async function streamWordInsight(
  port: Parameters<Parameters<typeof browser.runtime.onConnect.addListener>[0]>[0],
  message: WordInsightStreamStart,
  signal: AbortSignal,
): Promise<void> {
  const post = (event: WordInsightStreamEvent) => {
    if (!signal.aborted) port.postMessage(event);
  };
  try {
    const response = await fetch(`${COMPANION_BASE_URL}/v1/words/insight/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message.request),
      signal,
    });
    if (!response.ok) {
      throw new Error((await response.text()) || `Request failed (${response.status})`);
    }
    if (!response.body) throw new Error("The ChatGPT stream did not include a response body.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let terminalReceived = false;
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as WordInsightStreamEvent;
        if (event.type === "done" || event.type === "error") terminalReceived = true;
        post(event);
      }
      if (done) break;
    }
    if (buffer.trim()) {
      const event = JSON.parse(buffer) as WordInsightStreamEvent;
      if (event.type === "done" || event.type === "error") terminalReceived = true;
      post(event);
    }
    if (!signal.aborted && !terminalReceived) {
      post({ type: "error", error: "ChatGPT stream ended before completion." });
    }
  } catch (error) {
    if (signal.aborted) return;
    post({
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
