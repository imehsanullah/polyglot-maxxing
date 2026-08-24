import { describe, expect, it } from "vitest";
import { parsePartialWordInsights } from "../src/lib/partial-word-insights";

describe("partial structured word insights", () => {
  it("exposes each field while its JSON string is still arriving", () => {
    expect(parsePartialWordInsights('{"explain":"Used as el')).toEqual({
      explain: "Used as el",
    });
    expect(parsePartialWordInsights(
      '{"explain":"Used as else.","examples":"Noch jemand? — Any',
    )).toEqual({
      explain: "Used as else.",
      examples: "Noch jemand? — Any",
    });
  });

  it("decodes escaped formatting and quoted text across incomplete output", () => {
    expect(parsePartialWordInsights(
      '{"explain":"Line one\\nLine \\"two\\"","examples":"A \\u2014 B",'
      + '"grammar":"Adverb',
    )).toEqual({
      explain: 'Line one\nLine "two"',
      examples: "A — B",
      grammar: "Adverb",
    });
  });
});
