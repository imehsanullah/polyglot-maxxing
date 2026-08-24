import type { SubtitleSource } from "../domain/types";
import { findFirstStringValue, normalizeEmbeddedPageData } from "../lib/embedded";
import {
  languageMatches,
  SubtitleTrackUnavailableError,
  uniqueLanguageCodes,
} from "../lib/languages";

type JsonFetcher = (url: string, headers?: Record<string, string>) => Promise<unknown>;

const WEBVTT_PATTERN =
  /https:\/\/api\.ardmediathek\.de\/player-service\/subtitle\/webvtt\/[^"'<>\s]+\.vtt/;

export function extractArdWebVttUrl(pageData: string): string | undefined {
  return normalizeEmbeddedPageData(pageData).match(WEBVTT_PATTERN)?.[0];
}

function episodeIdFromUrl(pageUrl: string): string {
  const pathname = new URL(pageUrl).pathname.replace(/\/$/, "");
  return decodeURIComponent(pathname.split("/").at(-1) || pathname);
}

export async function resolveArdSource(
  pageUrl: string,
  pageData: string,
  fetchJson: JsonFetcher,
  language = "de",
): Promise<SubtitleSource> {
  const episodeId = episodeIdFromUrl(pageUrl);
  let subtitleUrl = languageMatches("de", language)
    ? extractArdWebVttUrl(pageData)
    : undefined;
  let availableLanguages = subtitleUrl ? ["de"] : [];

  if (!subtitleUrl) {
    const metadataUrl = `https://api.ardmediathek.de/page-gateway/mediacollectionv6/${encodeURIComponent(episodeId)}?isTv=false`;
    const metadata = await fetchJson(metadataUrl);
    const tracks: Array<{ language: string; url: string }> = [];
    const visit = (value: unknown, inheritedLanguage = "de"): void => {
      if (!value || typeof value !== "object") return;
      const record = value as Record<string, unknown>;
      const recordLanguage = [record.language, record.languageCode, record.lang, record.bcp47]
        .find((candidate): candidate is string => typeof candidate === "string") ??
        inheritedLanguage;
      for (const child of Object.values(record)) {
        if (
          typeof child === "string" &&
          child.includes("/player-service/subtitle/webvtt/") &&
          child.endsWith(".vtt")
        ) {
          tracks.push({ language: recordLanguage, url: child });
        } else {
          visit(child, recordLanguage);
        }
      }
    };
    visit(metadata);
    availableLanguages = uniqueLanguageCodes(tracks.map((track) => track.language));
    subtitleUrl = tracks.find((track) => languageMatches(track.language, language))?.url ??
      (languageMatches("de", language)
        ? findFirstStringValue(
          metadata,
          (key, value) =>
            key === "url" &&
            value.includes("/player-service/subtitle/webvtt/") &&
            value.endsWith(".vtt"),
        )
        : undefined);
  }

  if (!subtitleUrl) {
    throw new SubtitleTrackUnavailableError(language, availableLanguages);
  }

  return {
    site: "ard",
    episodeId,
    pageUrl,
    language,
    availableLanguages,
    delivery: { kind: "webvtt", subtitleUrl },
  };
}
