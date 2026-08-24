import type {
  PartialWordInsights,
  WordInsightKind,
} from "../domain/types";

const INSIGHT_KINDS: readonly WordInsightKind[] = ["explain", "examples", "grammar"];

function decodeJsonString(source: string, openingQuote: number): string {
  let value = "";
  for (let index = openingQuote + 1; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === '"') return value;
    if (character !== "\\") {
      value += character;
      continue;
    }

    const escaped = source[index + 1];
    if (escaped === undefined) break;
    if (escaped === "u") {
      const digits = source.slice(index + 2, index + 6);
      if (digits.length < 4 || !/^[0-9a-f]{4}$/i.test(digits)) break;
      value += String.fromCharCode(Number.parseInt(digits, 16));
      index += 5;
      continue;
    }
    const replacements: Record<string, string> = {
      '"': '"',
      "\\": "\\",
      "/": "/",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
    };
    value += replacements[escaped] ?? escaped;
    index += 1;
  }
  return value;
}

function partialField(source: string, kind: WordInsightKind): string | undefined {
  const marker = `"${kind}"`;
  let markerIndex = source.indexOf(marker);
  while (markerIndex >= 0) {
    let cursor = markerIndex + marker.length;
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    if (source[cursor] !== ":") {
      markerIndex = source.indexOf(marker, markerIndex + marker.length);
      continue;
    }
    cursor += 1;
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    if (source[cursor] !== '"') return undefined;
    return decodeJsonString(source, cursor);
  }
  return undefined;
}

/** Extract usable text from an incomplete structured word-insight JSON stream. */
export function parsePartialWordInsights(source: string): PartialWordInsights {
  const result: PartialWordInsights = {};
  for (const kind of INSIGHT_KINDS) {
    const value = partialField(source, kind);
    if (value !== undefined) result[kind] = value;
  }
  return result;
}
