import type {
  PartialWordInsights,
  WordInsightRequest,
  WordInsightResponse,
  WordInsightStreamEvent,
} from "../domain/types";
import { WORD_INSIGHT_STREAM_PORT } from "../domain/types";
import { parsePartialWordInsights } from "./partial-word-insights";

export function streamWordInsight(
  request: WordInsightRequest,
  signal: AbortSignal,
  onProgress?: (insights: PartialWordInsights) => void,
): Promise<WordInsightResponse> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }

    let port: ReturnType<typeof browser.runtime.connect>;
    try {
      port = browser.runtime.connect({ name: WORD_INSIGHT_STREAM_PORT });
    } catch (error) {
      reject(error);
      return;
    }

    let settled = false;
    let streamedContent = "";
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      port.onMessage.removeListener(message);
      port.onDisconnect.removeListener(disconnect);
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      port.disconnect();
      callback();
    };
    const abort = () => finish(() => reject(new DOMException("Aborted", "AbortError")));
    const disconnect = () => finish(() => reject(new Error("ChatGPT stream disconnected.")));
    const message = (event: WordInsightStreamEvent) => {
      if (event.type === "error") {
        finish(() => reject(new Error(event.error)));
        return;
      }
      if (event.type === "delta") {
        streamedContent += event.delta;
        onProgress?.(parsePartialWordInsights(streamedContent));
        return;
      }
      finish(() => resolve({
        insights: event.insights,
        model: event.model,
        cached: event.cached,
      }));
    };

    signal.addEventListener("abort", abort, { once: true });
    port.onMessage.addListener(message);
    port.onDisconnect.addListener(disconnect);
    try {
      port.postMessage({ type: "start", request });
    } catch (error) {
      finish(() => reject(error));
    }
  });
}
