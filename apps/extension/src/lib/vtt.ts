import type { SubtitleCue } from "../domain/types";

function parseTimestamp(value: string): number {
  const parts = value.trim().replace(",", ".").split(":").map(Number);
  if (parts.some(Number.isNaN)) throw new Error(`Invalid WebVTT timestamp: ${value}`);
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  throw new Error(`Invalid WebVTT timestamp: ${value}`);
}

function cleanCueText(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replace(/\s+/g, " ")
    .trim();
}

export function parseWebVtt(input: string): SubtitleCue[] {
  const normalized = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const blocks = normalized.split(/\n{2,}/);
  const cues: SubtitleCue[] = [];

  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trimEnd());
    if (!lines.length || lines[0]?.startsWith("WEBVTT") || lines[0]?.startsWith("NOTE")) {
      continue;
    }

    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const timing = lines[timingIndex]!.match(
      /^\s*([\d:,\.]+)\s*-->\s*([\d:,\.]+)(?:\s+.*)?$/,
    );
    if (!timing) continue;

    const text = cleanCueText(lines.slice(timingIndex + 1).join(" "));
    if (!text) continue;
    const explicitId = timingIndex > 0 ? lines[timingIndex - 1]!.trim() : "";
    cues.push({
      id: explicitId || `cue-${cues.length + 1}`,
      start: parseTimestamp(timing[1]!),
      end: parseTimestamp(timing[2]!),
      text,
    });
  }

  return cues;
}

export function findActiveCueIndex(cues: SubtitleCue[], time: number): number {
  let low = 0;
  let high = cues.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const cue = cues[middle]!;
    if (time < cue.start) high = middle - 1;
    else if (time > cue.end) low = middle + 1;
    else return middle;
  }
  return -1;
}

export function findCueIndexAtOrAfter(cues: SubtitleCue[], time: number): number {
  let low = 0;
  let high = cues.length - 1;
  let result = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (cues[middle]!.start >= time) {
      result = middle;
      high = middle - 1;
    } else {
      low = middle + 1;
    }
  }
  return result;
}
