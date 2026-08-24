import {
  YOUTUBE_TRACKS_CHANNEL,
  YOUTUBE_TRACKS_REQUEST_EVENT,
  type YouTubeTimedTextMessage,
} from "../src/adapters/youtube";
import { languageMatches, uniqueLanguageCodes } from "../src/lib/languages";

interface YouTubeCaptionTrack {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
}

interface YouTubePlayerResponse {
  playabilityStatus?: { status?: string };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: YouTubeCaptionTrack[];
    };
  };
}

const ANDROID_CLIENT_VERSION = "20.10.38";

interface YouTubeConfig {
  get?: (key: string) => unknown;
}

interface YouTubePageWindow extends Window {
  ytInitialPlayerResponse?: YouTubePlayerResponse;
  ytInitialData?: unknown;
  ytcfg?: YouTubeConfig;
}

interface YouTubePlayerElement extends Element {
  getPlayerResponse?: () => YouTubePlayerResponse | string;
  getWatchNextResponse?: () => unknown;
  getOption?: (namespace: string, option: string, options?: unknown) => unknown;
  setOption?: (namespace: string, option: string, value: unknown) => void;
  toggleSubtitles?: () => void;
}

interface YouTubePlayerCaptionTrack extends YouTubeCaptionTrack {
  vss_id?: string;
  displayName?: string;
  is_servable?: boolean;
}

const proofOfOriginTokens = new Map<string, string>();

function captureTimedTextToken(value: unknown): void {
  if (typeof value !== "string" || !value.includes("/timedtext?")) return;
  try {
    const url = new URL(value, location.origin);
    const videoId = url.searchParams.get("v");
    const token = url.searchParams.get("pot");
    if (videoId && token) proofOfOriginTokens.set(videoId, token);
  } catch {
    // Ignore unrelated or malformed player requests.
  }
}

function installTimedTextTokenCapture(): void {
  const nativeOpen = XMLHttpRequest.prototype.open as unknown as (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ) => void;
  XMLHttpRequest.prototype.open = function openWithTimedTextCapture(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async: boolean = true,
    username?: string | null,
    password?: string | null,
  ): void {
    captureTimedTextToken(String(url));
    nativeOpen.call(this, method, url, async, username, password);
  } as typeof XMLHttpRequest.prototype.open;

  const nativeFetch = window.fetch;
  window.fetch = function fetchWithTimedTextCapture(
    this: Window,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    captureTimedTextToken(input instanceof Request ? input.url : String(input));
    return nativeFetch.call(this, input, init);
  } as typeof window.fetch;
}

function recoverTimedTextToken(videoId: string): string | undefined {
  const captured = proofOfOriginTokens.get(videoId);
  if (captured) return captured;
  for (const entry of performance.getEntriesByType("resource")) {
    captureTimedTextToken(entry.name);
  }
  return proofOfOriginTokens.get(videoId);
}

function currentVideoId(): string | undefined {
  return new URL(location.href).searchParams.get("v") ?? undefined;
}

function captionTracks(): YouTubeCaptionTrack[] {
  const pageWindow = window as YouTubePageWindow;
  const player = document.querySelector("#movie_player") as YouTubePlayerElement | null;
  let response = player?.getPlayerResponse?.();
  if (typeof response === "string") {
    try {
      response = JSON.parse(response) as YouTubePlayerResponse;
    } catch {
      response = undefined;
    }
  }
  const fromResponse = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (Array.isArray(fromResponse)) return fromResponse;
  const fromInitial = pageWindow.ytInitialPlayerResponse?.captions
    ?.playerCaptionsTracklistRenderer?.captionTracks;
  if (Array.isArray(fromInitial)) return fromInitial;
  const fromPlayerOption = player?.getOption?.("captions", "tracklist") as {
    captionTracks?: YouTubeCaptionTrack[];
  } | undefined;
  return Array.isArray(fromPlayerOption?.captionTracks)
    ? fromPlayerOption.captionTracks
    : [];
}

function playerCaptionTracks(): YouTubePlayerCaptionTrack[] {
  const player = document.querySelector("#movie_player") as YouTubePlayerElement | null;
  const tracks = player?.getOption?.("captions", "tracklist", { includeAsr: true });
  return Array.isArray(tracks) ? tracks as YouTubePlayerCaptionTrack[] : [];
}

function transcriptParams(): string | undefined {
  const pageWindow = window as YouTubePageWindow;
  const player = document.querySelector("#movie_player") as YouTubePlayerElement | null;
  const watchPage = document.querySelector("ytd-watch-flexy") as (Element & {
    data?: unknown;
  }) | null;
  const candidates = [
    pageWindow.ytInitialData,
    player?.getWatchNextResponse?.(),
    watchPage?.data,
  ];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth = 0): string | undefined => {
    if (!value || typeof value !== "object" || seen.has(value) || depth > 24) return undefined;
    seen.add(value);
    const record = value as Record<string, unknown>;
    const endpoint = record.getTranscriptEndpoint;
    if (endpoint && typeof endpoint === "object") {
      const params = (endpoint as Record<string, unknown>).params;
      if (typeof params === "string" && params) return params;
    }
    for (const child of Object.values(record)) {
      const found = visit(child, depth + 1);
      if (found) return found;
    }
    return undefined;
  };
  for (const candidate of candidates) {
    const found = visit(candidate);
    if (found) return found;
  }
  return undefined;
}

async function fetchTranscript(): Promise<string> {
  const pageWindow = window as YouTubePageWindow;
  const params = transcriptParams();
  if (!params) throw new Error("YouTube did not expose transcript parameters.");
  const context = pageWindow.ytcfg?.get?.("INNERTUBE_CONTEXT");
  if (!context || typeof context !== "object") {
    throw new Error("YouTube did not expose its transcript client context.");
  }
  const apiKey = pageWindow.ytcfg?.get?.("INNERTUBE_API_KEY");
  const clientName = pageWindow.ytcfg?.get?.("INNERTUBE_CONTEXT_CLIENT_NAME");
  const clientVersion = pageWindow.ytcfg?.get?.("INNERTUBE_CONTEXT_CLIENT_VERSION");
  const endpoint = new URL("/youtubei/v1/get_transcript", location.origin);
  endpoint.searchParams.set("prettyPrint", "false");
  if (typeof apiKey === "string" && apiKey) endpoint.searchParams.set("key", apiKey);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (typeof clientName === "number" || typeof clientName === "string") {
    headers["X-YouTube-Client-Name"] = String(clientName);
  }
  if (typeof clientVersion === "string") {
    headers["X-YouTube-Client-Version"] = clientVersion;
  }
  const response = await fetch(endpoint, {
    method: "POST",
    credentials: "include",
    headers,
    body: JSON.stringify({ context, params }),
  });
  if (!response.ok) {
    throw new Error(`YouTube transcript failed to load (${response.status}).`);
  }
  const body = await response.text();
  if (!body.trim()) throw new Error("YouTube returned an empty transcript.");
  return body;
}

function desiredLanguages(): { sourceLanguage: string; targetLanguage: string } {
  return {
    sourceLanguage: document.documentElement.dataset.polyglotMaxxingSourceLanguage || "de",
    targetLanguage: document.documentElement.dataset.polyglotMaxxingTargetLanguage || "en",
  };
}

function captionTrack(language: string): YouTubeCaptionTrack | undefined {
  return captionTracks()
    .filter((track) => languageMatches(track.languageCode, language))
    .sort((left, right) => Number(left.kind === "asr") - Number(right.kind === "asr"))[0];
}

async function androidCaptionTrack(
  videoId: string,
  language: string,
): Promise<YouTubeCaptionTrack | undefined> {
  const pageWindow = window as YouTubePageWindow;
  const apiKey = pageWindow.ytcfg?.get?.("INNERTUBE_API_KEY");
  if (typeof apiKey !== "string" || !apiKey) return undefined;

  const endpoint = new URL("/youtubei/v1/player", location.origin);
  endpoint.searchParams.set("prettyPrint", "false");
  endpoint.searchParams.set("key", apiKey);
  const response = await fetch(endpoint, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      context: {
        client: {
          clientName: "ANDROID",
          clientVersion: ANDROID_CLIENT_VERSION,
          androidSdkVersion: 35,
          hl: language,
          gl: language.toLocaleUpperCase("en"),
        },
      },
      videoId,
    }),
  });
  if (!response.ok) return undefined;
  const playerResponse = await response.json() as YouTubePlayerResponse;
  if (playerResponse.playabilityStatus?.status !== "OK") return undefined;
  const tracks = playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  return tracks
    ?.filter((track) => languageMatches(track.languageCode, language))
    .sort((left, right) => Number(left.kind === "asr") - Number(right.kind === "asr"))[0];
}

function ensurePlayerTrack(language: string): void {
  const player = document.querySelector("#movie_player") as YouTubePlayerElement | null;
  if (!player?.setOption) return;
  const tracks = playerCaptionTracks();
  const requested = tracks
    .filter((track) => languageMatches(track.languageCode, language))
    .sort((left, right) => Number(left.kind === "asr") - Number(right.kind === "asr"))[0];
  if (!requested) return;
  const selected = player.getOption?.("captions", "track") as YouTubePlayerCaptionTrack | undefined;
  if (selected?.vss_id !== requested.vss_id) {
    player.setOption("captions", "track", requested);
  }
}

async function timedTextToken(videoId: string, language: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const token = recoverTimedTextToken(videoId);
    if (token) return token;
    ensurePlayerTrack(language);
    await new Promise((resolve) => window.setTimeout(resolve, 750));
  }
  return recoverTimedTextToken(videoId);
}

function timedTextUrl(
  track: YouTubeCaptionTrack,
  format: "json3" | "vtt",
  videoId: string,
  token: string | undefined,
  targetLanguage?: string,
): URL {
  if (!track.baseUrl) throw new Error("The requested caption track has no URL.");
  const url = new URL(track.baseUrl);
  url.searchParams.set("fmt", format);
  if (targetLanguage) url.searchParams.set("tlang", targetLanguage);
  const effectiveToken = token ?? url.searchParams.get("pot") ?? undefined;
  if (effectiveToken) {
    url.searchParams.set("c", "WEB");
    url.searchParams.set("pot", effectiveToken);
  }
  if (!url.searchParams.get("v")) url.searchParams.set("v", videoId);
  return url;
}

async function fetchTimedText(
  track: YouTubeCaptionTrack,
  sourceLanguage: string,
  targetLanguage: string,
): Promise<{
  format: "json3" | "transcript" | "translated-json3" |
    "translated-webvtt" | "webvtt";
  body: string;
}> {
  if (!track.baseUrl) throw new Error("The requested caption track has no URL.");
  const videoId = currentVideoId();
  if (!videoId) throw new Error("The YouTube video id is unavailable.");
  const token = await timedTextToken(videoId, sourceLanguage);
  for (const format of ["json3", "vtt"] as const) {
    const url = timedTextUrl(track, format, videoId, token);
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) continue;
    const body = await response.text();
    if (body.trim()) {
      return { format: format === "vtt" ? "webvtt" : "json3", body };
    }
  }

  // Some YouTube pages expose a signed Web caption URL but never request a
  // proof-of-origin token (the native player even reports captions as
  // unavailable). The Android player response supplies an equivalent full
  // timed-text track that does not need that Web-only token. Fetch it before
  // falling back to visible one-line captions so playback still gets the
  // normal 24-cue prefetch pipeline.
  const androidTrack = await androidCaptionTrack(videoId, sourceLanguage);
  if (androidTrack?.baseUrl) {
    for (const format of ["json3", "vtt"] as const) {
      const url = timedTextUrl(androidTrack, format, videoId, undefined);
      const response = await fetch(url, { credentials: "include" });
      if (!response.ok) continue;
      const body = await response.text();
      if (body.trim()) {
        return { format: format === "vtt" ? "webvtt" : "json3", body };
      }
    }
  }

  for (const format of ["json3", "vtt"] as const) {
    const url = timedTextUrl(track, format, videoId, token, targetLanguage);
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) continue;
    const body = await response.text();
    if (body.trim()) {
      return {
        format: format === "vtt" ? "translated-webvtt" : "translated-json3",
        body,
      };
    }
  }
  return { format: "transcript", body: await fetchTranscript() };
}

async function publish(): Promise<void> {
  const episodeId = currentVideoId();
  if (!episodeId) return;
  let message: YouTubeTimedTextMessage;
  const { sourceLanguage, targetLanguage } = desiredLanguages();
  try {
    const track = captionTrack(sourceLanguage) ??
      await androidCaptionTrack(episodeId, sourceLanguage);
    if (!track) throw new Error(`No ${sourceLanguage} YouTube caption track was found.`);
    const timedText = await fetchTimedText(track, sourceLanguage, targetLanguage);
    message = {
      channel: YOUTUBE_TRACKS_CHANNEL,
      episodeId,
      ...timedText,
      sourceLanguage,
      availableLanguages: uniqueLanguageCodes(
        captionTracks().map((candidate) => candidate.languageCode),
      ),
    };
  } catch (error) {
    message = {
      channel: YOUTUBE_TRACKS_CHANNEL,
      episodeId,
      format: "json3",
      sourceLanguage,
      availableLanguages: uniqueLanguageCodes(
        captionTracks().map((candidate) => candidate.languageCode),
      ),
      error: error instanceof Error ? error.message : String(error),
    };
  }
  window.postMessage(message, location.origin);
}

export default defineContentScript({
  matches: ["https://www.youtube.com/*"],
  runAt: "document_start",
  world: "MAIN",
  main() {
    installTimedTextTokenCapture();
    window.addEventListener(YOUTUBE_TRACKS_REQUEST_EVENT, () => void publish());
  },
});
