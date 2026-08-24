import type { SubtitleSource } from "../domain/types";
import { normalizeEmbeddedPageData } from "../lib/embedded";
import { languageMatches, uniqueLanguageCodes } from "../lib/languages";

interface YouTubeCaptionTrack {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
}

export const YOUTUBE_TRACKS_CHANNEL = "polyglot-maxxing:youtube-timed-text";
export const YOUTUBE_TRACKS_REQUEST_EVENT = "polyglot-maxxing:request-youtube-timed-text";

export interface YouTubeTimedTextMessage {
  channel: typeof YOUTUBE_TRACKS_CHANNEL;
  episodeId: string;
  format: "json3" | "transcript" | "translated-json3" |
    "translated-webvtt" | "webvtt";
  body?: string;
  error?: string;
  sourceLanguage?: string;
  availableLanguages?: string[];
}

export function isYouTubeTimedTextMessage(value: unknown): value is YouTubeTimedTextMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<YouTubeTimedTextMessage>;
  return message.channel === YOUTUBE_TRACKS_CHANNEL &&
    typeof message.episodeId === "string" &&
    (message.format === "json3" || message.format === "transcript" ||
      message.format === "translated-json3" ||
      message.format === "translated-webvtt" || message.format === "webvtt") &&
    (message.body === undefined || typeof message.body === "string") &&
    (message.error === undefined || typeof message.error === "string") &&
    (message.sourceLanguage === undefined || typeof message.sourceLanguage === "string") &&
    (message.availableLanguages === undefined ||
      (Array.isArray(message.availableLanguages) &&
        message.availableLanguages.every((language) => typeof language === "string")));
}

function extractJsonArray(source: string, property: string): unknown[] | undefined {
  const marker = `"${property}"`;
  const start = source.indexOf(marker);
  if (start < 0) return undefined;
  const bracket = source.indexOf("[", start + marker.length);
  if (bracket < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = bracket; index < source.length; index += 1) {
    const character = source[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "[") depth += 1;
    else if (character === "]") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(source.slice(bracket, index + 1));
          return Array.isArray(parsed) ? parsed : undefined;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

export function extractYouTubeCaptionUrl(
  pageData: string,
  language = "de",
): string | undefined {
  const normalized = normalizeEmbeddedPageData(pageData);
  const tracks = extractJsonArray(normalized, "captionTracks") as YouTubeCaptionTrack[] | undefined;
  const track = tracks
    ?.filter((candidate) => languageMatches(candidate.languageCode, language))
    .sort((left, right) => Number(left.kind === "asr") - Number(right.kind === "asr"))[0];
  if (!track?.baseUrl) return undefined;
  const url = new URL(track.baseUrl);
  url.searchParams.set("fmt", "vtt");
  return url.toString();
}

export function extractYouTubeCaptionLanguages(pageData: string): string[] {
  const normalized = normalizeEmbeddedPageData(pageData);
  const tracks = extractJsonArray(normalized, "captionTracks") as YouTubeCaptionTrack[] | undefined;
  return uniqueLanguageCodes(tracks?.map((track) => track.languageCode) ?? []);
}

export function resolveYouTubeSource(
  pageUrl: string,
  pageData: string,
  language = "de",
): SubtitleSource {
  const url = new URL(pageUrl);
  const episodeId = url.searchParams.get("v") ?? url.pathname.split("/").filter(Boolean).at(-1);
  const subtitleUrl = extractYouTubeCaptionUrl(pageData, language) ?? "";
  const availableLanguages = extractYouTubeCaptionLanguages(pageData);
  if (!episodeId) throw new Error("The YouTube video id is not available.");
  return {
    site: "youtube",
    episodeId,
    pageUrl,
    language,
    availableLanguages,
    delivery: { kind: "webvtt", subtitleUrl },
  };
}
