// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import {
  parseTimedText,
  parseTtml,
  parseYouTubeJson3,
  parseYouTubeTranscript,
} from "../src/lib/timed-text";

const netflixTtml = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:tickRate="10000000">
  <body begin="1s"><div begin="500ms">
    <p xml:id="subtitle-1" begin="10000000t" end="32000000t">Das ist <span>gut.</span></p>
    <p begin="4s" dur="2s">Noch eine<br/>Zeile.</p>
  </div></body>
</tt>`;

describe("Netflix timed-text parsing", () => {
  it("parses TTML tick timing, inherited offsets, spans, and line breaks", () => {
    expect(parseTtml(netflixTtml)).toEqual([
      { id: "subtitle-1", start: 2.5, end: 4.7, text: "Das ist gut." },
      { id: "cue-2", start: 5.5, end: 7.5, text: "Noch eine Zeile." },
    ]);
  });

  it("continues to accept WebVTT through the shared timed-text parser", () => {
    expect(parseTimedText("WEBVTT\n\n00:01.000 --> 00:02.000\nHallo!")).toEqual([
      { id: "cue-1", start: 1, end: 2, text: "Hallo!" },
    ]);
  });
});

describe("YouTube JSON3 parsing", () => {
  it("turns timed caption events into subtitle cues", () => {
    expect(parseYouTubeJson3(JSON.stringify({
      events: [
        { tStartMs: 1250, dDurationMs: 2400, segs: [{ utf8: "Guten " }, { utf8: "Morgen!" }] },
        { tStartMs: 3650, dDurationMs: 1000 },
      ],
    }))).toEqual([
      {
        id: "youtube-1-1250",
        start: 1.25,
        end: 3.65,
        text: "Guten Morgen!",
      },
    ]);
  });

  it("extracts timed cues from YouTube's transcript response", () => {
    expect(parseYouTubeTranscript(JSON.stringify({
      actions: [{
        updateEngagementPanelAction: {
          content: {
            transcriptRenderer: {
              body: {
                transcriptSegmentListRenderer: {
                  initialSegments: [{
                    transcriptSegmentRenderer: {
                      startMs: "5000",
                      endMs: "7250",
                      snippet: { runs: [{ text: "Wie " }, { text: "geht's?" }] },
                    },
                  }],
                },
              },
            },
          },
        },
      }],
    }))).toEqual([
      {
        id: "youtube-transcript-5000-1",
        start: 5,
        end: 7.25,
        text: "Wie geht's?",
      },
    ]);
  });
});
