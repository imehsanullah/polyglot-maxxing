import { describe, expect, it } from "vitest";
import { findActiveCueIndex, findCueIndexAtOrAfter, parseWebVtt } from "../src/lib/vtt";

const sample = `WEBVTT

1
00:00:01.200 --> 00:00:03.400 align:center
<c.white>Guten Morgen!</c>

00:03.500 --> 00:05.000
Wie geht es Ihnen?<br>Alles gut?
`;

describe("WebVTT parser", () => {
  it("parses cue IDs, timing, settings, tags and multiline text", () => {
    expect(parseWebVtt(sample)).toEqual([
      { id: "1", start: 1.2, end: 3.4, text: "Guten Morgen!" },
      { id: "cue-2", start: 3.5, end: 5, text: "Wie geht es Ihnen? Alles gut?" },
    ]);
  });

  it("finds active cues using binary search", () => {
    const cues = parseWebVtt(sample);
    expect(findActiveCueIndex(cues, 2)).toBe(0);
    expect(findActiveCueIndex(cues, 4)).toBe(1);
    expect(findActiveCueIndex(cues, 9)).toBe(-1);
  });

  it("finds the next cue when seeking into a subtitle gap", () => {
    const cues = parseWebVtt(sample);
    expect(findCueIndexAtOrAfter(cues, 3.45)).toBe(1);
    expect(findCueIndexAtOrAfter(cues, 20)).toBe(-1);
  });
});
