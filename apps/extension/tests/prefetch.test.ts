import { describe, expect, it } from "vitest";
import { alignedSubtitleChunks } from "../src/lib/prefetch";

describe("subtitle prefetch planning", () => {
  it("keeps moving playback aligned to complete 24-cue batches", () => {
    expect(alignedSubtitleChunks(200, 1)).toEqual([
      { start: 0, end: 24 },
      { start: 24, end: 48 },
      { start: 48, end: 72 },
    ]);
    expect(alignedSubtitleChunks(200, 23)[0]).toEqual({ start: 0, end: 24 });
    expect(alignedSubtitleChunks(200, 24)[0]).toEqual({ start: 24, end: 48 });
  });

  it("anchors a seek in the middle and truncates only the final episode batch", () => {
    expect(alignedSubtitleChunks(101, 77)).toEqual([
      { start: 72, end: 96 },
      { start: 96, end: 101 },
    ]);
  });
});
