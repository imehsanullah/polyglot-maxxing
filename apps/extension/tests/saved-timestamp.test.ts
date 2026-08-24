// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import {
  savedTimestampFromUrl,
  savedTimestampUrl,
  seekToSavedTimestamp,
} from "../src/lib/saved-timestamp";

describe("saved video timestamps", () => {
  it("adds a Polyglot Maxxing timestamp to every source and a native YouTube time", () => {
    const ard = savedTimestampUrl("https://www.ardmediathek.de/video/example", 42.5);
    const youtube = savedTimestampUrl("https://www.youtube.com/watch?v=abc", 91.8);

    expect(ard).toContain("#polyglot-maxxing-t=42.5");
    expect(youtube).toContain("t=91s");
    expect(youtube).toContain("#polyglot-maxxing-t=91.8");
    expect(savedTimestampFromUrl(ard)).toBe(42.5);
    expect(savedTimestampFromUrl("https://example.test/#polyglot-maxxing-t=invalid")).toBeUndefined();
  });

  it("seeks immediately when metadata is ready", () => {
    const video = document.createElement("video");
    Object.defineProperties(video, {
      readyState: { value: 1, configurable: true },
      duration: { value: 120, configurable: true },
    });
    const controller = new AbortController();

    seekToSavedTimestamp(
      video,
      "https://www.zdf.de/play/example#polyglot-maxxing-t=37.25",
      controller.signal,
    );

    expect(video.currentTime).toBe(37.25);
  });
});
