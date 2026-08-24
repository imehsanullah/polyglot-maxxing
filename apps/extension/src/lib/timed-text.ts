import type { SubtitleCue } from "../domain/types";
import { parseWebVtt } from "./vtt";

interface TtmlRates {
  frameRate: number;
  tickRate: number;
}

function numericAttribute(element: Element, localName: string): number | undefined {
  const attribute = Array.from(element.attributes).find((candidate) =>
    candidate.localName === localName || candidate.name.endsWith(`:${localName}`),
  );
  if (!attribute) return undefined;
  const value = Number(attribute.value);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseTtmlTime(value: string | null, rates: TtmlRates): number | undefined {
  if (!value) return undefined;
  const clock = value.match(/^(\d+):(\d{2}):(\d{2})(?:[.,](\d+))?$/);
  if (clock) {
    const fraction = clock[4] ? Number(`0.${clock[4]}`) : 0;
    return Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]) + fraction;
  }
  const frames = value.match(/^(\d+):(\d{2}):(\d{2}):(\d+(?:\.\d+)?)$/);
  if (frames) {
    return Number(frames[1]) * 3600 + Number(frames[2]) * 60 + Number(frames[3]) +
      Number(frames[4]) / rates.frameRate;
  }
  const offset = value.match(/^(-?\d+(?:\.\d+)?)(h|m|s|ms|f|t)$/);
  if (!offset) return undefined;
  const amount = Number(offset[1]);
  switch (offset[2]) {
    case "h": return amount * 3600;
    case "m": return amount * 60;
    case "s": return amount;
    case "ms": return amount / 1000;
    case "f": return amount / rates.frameRate;
    case "t": return amount / rates.tickRate;
    default: return undefined;
  }
}

function inheritedBegin(element: Element, rates: TtmlRates): number {
  let offset = 0;
  let current: Element | null = element.parentElement;
  while (current) {
    offset += parseTtmlTime(current.getAttribute("begin"), rates) ?? 0;
    current = current.parentElement;
  }
  return offset;
}

function ttmlText(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  for (const lineBreak of Array.from(clone.querySelectorAll("br"))) {
    lineBreak.replaceWith(" ");
  }
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
}

export function parseTtml(input: string): SubtitleCue[] {
  const document = new DOMParser().parseFromString(input, "application/xml");
  if (document.querySelector("parsererror")) return [];
  const root = document.documentElement;
  const rates: TtmlRates = {
    frameRate: numericAttribute(root, "frameRate") ?? 30,
    tickRate: numericAttribute(root, "tickRate") ?? 1,
  };
  const cues: SubtitleCue[] = [];
  const paragraphs = Array.from(document.getElementsByTagName("*"))
    .filter((element) => element.localName === "p" || element.tagName.toLowerCase() === "p");
  for (const paragraph of paragraphs) {
    const parentOffset = inheritedBegin(paragraph, rates);
    const localBegin = parseTtmlTime(paragraph.getAttribute("begin"), rates);
    if (localBegin === undefined) continue;
    const start = parentOffset + localBegin;
    const localEnd = parseTtmlTime(paragraph.getAttribute("end"), rates);
    const duration = parseTtmlTime(paragraph.getAttribute("dur"), rates);
    const end = localEnd !== undefined
      ? parentOffset + localEnd
      : duration !== undefined
        ? start + duration
        : undefined;
    const text = ttmlText(paragraph);
    if (!text || end === undefined || end <= start) continue;
    cues.push({
      id: paragraph.getAttribute("xml:id") || paragraph.getAttribute("id") || `cue-${cues.length + 1}`,
      start,
      end,
      text,
    });
  }
  return cues.sort((left, right) => left.start - right.start || left.end - right.end);
}

export function parseTimedText(input: string): SubtitleCue[] {
  const trimmed = input.trimStart();
  if (/^(?:\uFEFF)?WEBVTT/i.test(trimmed)) return parseWebVtt(input);
  const ttml = parseTtml(input);
  return ttml.length ? ttml : parseWebVtt(input);
}

interface YouTubeJson3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Array<{ utf8?: string }>;
}

export function parseYouTubeJson3(input: string): SubtitleCue[] {
  let parsed: { events?: YouTubeJson3Event[] };
  try {
    parsed = JSON.parse(input) as { events?: YouTubeJson3Event[] };
  } catch {
    return [];
  }
  if (!Array.isArray(parsed.events)) return [];
  const cues: SubtitleCue[] = [];
  for (const event of parsed.events) {
    if (!Number.isFinite(event.tStartMs) || !Array.isArray(event.segs)) continue;
    const text = event.segs
      .map((segment) => segment.utf8 ?? "")
      .join("")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    const start = Number(event.tStartMs) / 1_000;
    const duration = Number.isFinite(event.dDurationMs)
      ? Math.max(Number(event.dDurationMs) / 1_000, 0.1)
      : 4;
    cues.push({
      id: `youtube-${cues.length + 1}-${Math.round(start * 1_000)}`,
      start,
      end: start + duration,
      text,
    });
  }
  return cues;
}

export function parseYouTubeTranscript(input: string): SubtitleCue[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input) as unknown;
  } catch {
    return [];
  }
  const renderers: Array<Record<string, unknown>> = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    const record = value as Record<string, unknown>;
    const renderer = record.transcriptSegmentRenderer;
    if (renderer && typeof renderer === "object") {
      renderers.push(renderer as Record<string, unknown>);
    }
    Object.values(record).forEach(visit);
  };
  visit(parsed);
  const cues: SubtitleCue[] = [];
  for (const renderer of renderers) {
    const startMs = Number(renderer.startMs);
    const endMs = Number(renderer.endMs);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) continue;
    const snippet = renderer.snippet as {
      runs?: Array<{ text?: string }>;
      simpleText?: string;
    } | undefined;
    const text = (snippet?.runs?.map((run) => run.text ?? "").join("") ??
      snippet?.simpleText ?? "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    cues.push({
      id: `youtube-transcript-${Math.round(startMs)}-${cues.length + 1}`,
      start: startMs / 1_000,
      end: endMs / 1_000,
      text,
    });
  }
  return cues.sort((left, right) => left.start - right.start || left.end - right.end);
}
