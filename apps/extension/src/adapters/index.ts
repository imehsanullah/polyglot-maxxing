import type { SubtitleSource } from "../domain/types";
import { resolveArdSource } from "./ard";
import { resolveNetflixSource } from "./netflix";
import { resolveYouTubeSource } from "./youtube";
import { resolveZdfSource } from "./zdf";

type JsonFetcher = (url: string, headers?: Record<string, string>) => Promise<unknown>;

export async function resolveSubtitleSource(
  pageUrl: string,
  pageData: string,
  fetchJson: JsonFetcher,
  language = "de",
): Promise<SubtitleSource> {
  const hostname = new URL(pageUrl).hostname;
  if (hostname === "www.ardmediathek.de" || hostname === "ardmediathek.de") {
    return resolveArdSource(pageUrl, pageData, fetchJson, language);
  }
  if (hostname === "www.zdf.de" || hostname === "zdf.de") {
    return resolveZdfSource(pageUrl, pageData, fetchJson, language);
  }
  if (hostname === "www.youtube.com" || hostname === "youtube.com") {
    return resolveYouTubeSource(pageUrl, pageData, language);
  }
  if (hostname === "www.netflix.com" || hostname === "netflix.com") {
    return resolveNetflixSource(pageUrl, language);
  }
  throw new Error(`Unsupported site: ${hostname}`);
}
