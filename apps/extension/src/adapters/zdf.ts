import type { SubtitleSource } from "../domain/types";
import { normalizeEmbeddedPageData } from "../lib/embedded";
import {
  languageMatches,
  SubtitleTrackUnavailableError,
  uniqueLanguageCodes,
} from "../lib/languages";

type JsonFetcher = (url: string, headers?: Record<string, string>) => Promise<unknown>;

interface ZdfCaption {
  format?: string;
  language?: string;
  uri?: string;
}

interface ZdfPtmd {
  captions?: ZdfCaption[];
}

export interface ZdfPlayerMetadata {
  apiToken: string;
  ptmdTemplate: string;
  playerId: string;
}

export function extractZdfPlayerMetadata(pageData: string): ZdfPlayerMetadata | undefined {
  const normalized = normalizeEmbeddedPageData(pageData);
  const apiToken = normalized.match(
    /"videoToken"\s*:\s*\{\s*"apiToken"\s*:\s*"([A-Za-z0-9_-]+)"/,
  )?.[1];
  const ptmdTemplate = normalized.match(
    /"ptmdTemplate"\s*:\s*"(\/tmd\/2\/\{playerId\}\/vod\/ptmd\/[^"?]+)"/,
  )?.[1];
  const playerId =
    normalized.match(/"ptmdPlayerId"\s*:\s*"([A-Za-z0-9_-]+)"/)?.[1] ??
    "ngplayer_2_5";

  if (!apiToken || !ptmdTemplate) return undefined;
  return { apiToken, ptmdTemplate, playerId };
}

function episodeIdFromUrl(pageUrl: string): string {
  const pathname = new URL(pageUrl).pathname.replace(/\/$/, "");
  return decodeURIComponent(pathname.split("/").at(-1) || pathname);
}

export async function resolveZdfSource(
  pageUrl: string,
  pageData: string,
  fetchJson: JsonFetcher,
  language = "de",
): Promise<SubtitleSource> {
  const metadata = extractZdfPlayerMetadata(pageData);
  if (!metadata) {
    throw new Error("ZDF player metadata is not available yet.");
  }

  const ptmdUrl = new URL(
    metadata.ptmdTemplate.replace("{playerId}", metadata.playerId),
    "https://api.zdf.de",
  ).toString();
  const ptmd = (await fetchJson(ptmdUrl, {
    Accept: "application/vnd.de.zdf.v1.0+json",
    "Api-Auth": `Bearer ${metadata.apiToken}`,
  })) as ZdfPtmd;
  const webVttCaptions = ptmd.captions?.filter(
    (candidate) =>
      candidate.format?.toLowerCase() === "webvtt" && Boolean(candidate.uri),
  ) ?? [];
  const caption = webVttCaptions.find((candidate) =>
    languageMatches(candidate.language, language));
  const availableLanguages = uniqueLanguageCodes(
    webVttCaptions.map((candidate) => candidate.language),
  );

  if (!caption?.uri) {
    throw new SubtitleTrackUnavailableError(language, availableLanguages);
  }

  return {
    site: "zdf",
    episodeId: episodeIdFromUrl(pageUrl),
    pageUrl,
    language,
    availableLanguages,
    delivery: { kind: "webvtt", subtitleUrl: caption.uri },
  };
}
