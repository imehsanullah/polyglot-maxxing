import type { SubtitleSource } from "../domain/types";
import { languageMatches } from "../lib/languages";

export const NETFLIX_TRACKS_CHANNEL = "polyglot-maxxing:netflix-timed-text";
export const NETFLIX_TRACKS_REQUEST_EVENT = "polyglot-maxxing:request-netflix-timed-text";

export interface NetflixTimedTextTrack {
  language: string;
  urls: string[];
  isSdh: boolean;
}

export interface NetflixTimedTextMessage {
  channel: typeof NETFLIX_TRACKS_CHANNEL;
  episodeId: string;
  tracks: NetflixTimedTextTrack[];
}

function netflixTrackLanguage(track: Record<string, unknown>): string | undefined {
  const value = track.bcp47 ?? track.language ?? track.languageCode;
  if (typeof value === "string") return value.replace(/[^A-Za-z0-9_.-]/g, "");
  if (value && typeof value === "object") {
    const nested = value as Record<string, unknown>;
    const nestedValue = nested.bcp47 ?? nested.code;
    if (typeof nestedValue === "string") {
      return nestedValue.replace(/[^A-Za-z0-9_.-]/g, "");
    }
  }
  return undefined;
}

export function isNetflixTimedTextUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      (url.hostname === "nflxvideo.net" || url.hostname.endsWith(".nflxvideo.net"));
  } catch {
    return false;
  }
}

export function extractNetflixTimedTextTrack(
  value: unknown,
): NetflixTimedTextTrack | undefined {
  if (!value || typeof value !== "object") return undefined;
  try {
    const record = value as Record<string, unknown>;
    if (
      record.isNoneTrack === true ||
      record.isForcedNarrative === true ||
      record.forcedNarrative === true
    ) {
      return undefined;
    }
    const serialized = JSON.stringify(value);
    const language = netflixTrackLanguage(record);
    if (!language) return undefined;
    const matches = serialized.match(/https:\\?\/\\?\/[^"'\\\s]+/g) ?? [];
    const urls = Array.from(new Set(matches
      .map((url) => url
        .replace(/\\\//g, "/")
        .replace(/\\u0026/gi, "&"))
      .filter(isNetflixTimedTextUrl)));
    if (!urls.length) return undefined;
    return {
      language,
      urls,
      isSdh: /(?:sdh|closed.?caption|assistive)/i.test(serialized),
    };
  } catch {
    return undefined;
  }
}

export function selectNetflixTrack(
  tracks: NetflixTimedTextTrack[],
  language = "de",
): NetflixTimedTextTrack | undefined {
  return tracks
    .filter((track) => languageMatches(track.language, language))
    .filter((track) => track.urls.some(isNetflixTimedTextUrl))
    .sort((left, right) => Number(left.isSdh) - Number(right.isSdh))[0];
}

export function isNetflixTimedTextMessage(value: unknown): value is NetflixTimedTextMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<NetflixTimedTextMessage>;
  if (
    candidate.channel !== NETFLIX_TRACKS_CHANNEL ||
    typeof candidate.episodeId !== "string" ||
    !Array.isArray(candidate.tracks)
  ) {
    return false;
  }
  return candidate.tracks.every((track) =>
    track &&
    typeof track.language === "string" &&
    typeof track.isSdh === "boolean" &&
    Array.isArray(track.urls) &&
    track.urls.every((url) => typeof url === "string" && isNetflixTimedTextUrl(url))
  );
}

export function resolveNetflixSource(pageUrl: string, language = "de"): SubtitleSource {
  const pathname = new URL(pageUrl).pathname.replace(/\/$/, "");
  const episodeId = pathname.split("/").filter(Boolean).at(-1);
  if (!episodeId) throw new Error("The Netflix video id is not available.");
  return {
    site: "netflix",
    episodeId,
    pageUrl,
    language,
    delivery: {
      kind: "netflix",
      captionSelector:
        `html[data-polyglot-maxxing-netflix-language='${language}'] .player-timedtext-text-container`,
    },
  };
}
