import { resolveSubtitleSource } from "../src/adapters";
import {
  isNetflixTimedTextMessage,
  NETFLIX_TRACKS_REQUEST_EVENT,
  selectNetflixTrack,
} from "../src/adapters/netflix";
import {
  isYouTubeTimedTextMessage,
  YOUTUBE_TRACKS_REQUEST_EVENT,
  type YouTubeTimedTextMessage,
} from "../src/adapters/youtube";
import type {
  BackgroundRequest,
  BackgroundResponse,
  PartialWordInsights,
  ProcessCuesResponse,
  ProcessedCue,
  SavedWord,
  SavedWordInput,
  SubtitleSource,
  SubtitleCue,
  SupportedSite,
  TokenAnalysis,
  WordInsightRequest,
  WordInsightResponse,
} from "../src/domain/types";
import {
  PREFETCH_BATCH_COUNT,
  SUBTITLE_BATCH_SIZE,
  alignedSubtitleChunks,
} from "../src/lib/prefetch";
import {
  parseTimedText,
  parseYouTubeJson3,
  parseYouTubeTranscript,
} from "../src/lib/timed-text";
import { findActiveCueIndex, findCueIndexAtOrAfter, parseWebVtt } from "../src/lib/vtt";
import {
  loadSubtitlePreferences,
  normalizeSubtitlePreferences,
  PREFERENCES_STORAGE_KEY,
  saveSubtitlePreferences,
} from "../src/lib/preferences";
import { seekToSavedTimestamp } from "../src/lib/saved-timestamp";
import { streamWordInsight } from "../src/lib/word-insight-stream";
import { SubtitleOverlay } from "../src/ui/overlay";
import {
  normalizeLanguageCode,
  SubtitleTrackUnavailableError,
  uniqueLanguageCodes,
} from "../src/lib/languages";

const CONTEXT_INVALIDATED_EVENT = "polyglot-maxxing:extension-context-invalidated";
const LANGUAGES_CHANGED_EVENT = "polyglot-maxxing:languages-changed";
const VIDEO_LANGUAGE_OVERRIDE_KEY = "polyglotMaxxingVideoLanguages";

class ExtensionContextInvalidatedError extends Error {
  constructor() {
    super("Extension context invalidated. Refresh this video tab after reloading Polyglot Maxxing.");
    this.name = "ExtensionContextInvalidatedError";
  }
}

function isExtensionContextInvalidated(error: unknown): boolean {
  return error instanceof ExtensionContextInvalidatedError ||
    /extension context invalidated/i.test(
      error instanceof Error ? error.message : String(error),
    );
}

async function backgroundRequest<T>(message: BackgroundRequest): Promise<T> {
  try {
    const response = (await browser.runtime.sendMessage(message)) as BackgroundResponse<T>;
    if (!response.ok) throw new Error(response.error || `Request failed (${response.status})`);
    return response.data as T;
  } catch (error) {
    if (isExtensionContextInvalidated(error)) {
      window.dispatchEvent(new Event(CONTEXT_INVALIDATED_EVENT));
      throw new ExtensionContextInvalidatedError();
    }
    throw error;
  }
}

function pageData(): string {
  return Array.from(document.scripts)
    .map((script) => script.textContent || "")
    .join("\n");
}

function fallbackTokenAnalysis(text: string, language: string): TokenAnalysis[] {
  const useGermanLemmaKey = normalizeLanguageCode(language) === "de";
  return Array.from(text.matchAll(/[\p{L}\p{M}]+(?:[’'-][\p{L}\p{M}]+)*/gu)).map((match) => ({
    surface: match[0],
    lemma: useGermanLemmaKey ? match[0].toLocaleLowerCase(language) : match[0],
    pos: "",
    morphology: {},
    start: match.index,
    end: match.index + match[0].length,
    meanings: [],
  }));
}

function requestYouTubeTimedText(
  episodeId: string,
  sourceLanguage: string,
  targetLanguage: string,
  signal: AbortSignal,
): Promise<YouTubeTimedTextMessage> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for YouTube's ${sourceLanguage} caption track.`));
    }, 15_000);
    const onMessage = (event: MessageEvent<unknown>) => {
      if (
        event.source !== window ||
        event.origin !== location.origin ||
        !isYouTubeTimedTextMessage(event.data) ||
        event.data.episodeId !== episodeId ||
        (event.data.sourceLanguage !== undefined &&
          normalizeLanguageCode(event.data.sourceLanguage) !== normalizeLanguageCode(sourceLanguage))
      ) return;
      cleanup();
      // Missing captions are a valid page result, not an exceptional transport
      // failure. Let PageRuntime render the language notice explicitly instead
      // of relying on a custom Error surviving the bundled async boundary.
      resolve(event.data);
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const cleanup = () => {
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      signal.removeEventListener("abort", onAbort);
    };
    window.addEventListener("message", onMessage);
    signal.addEventListener("abort", onAbort, { once: true });
    document.documentElement.dataset.polyglotMaxxingSourceLanguage = sourceLanguage;
    document.documentElement.dataset.polyglotMaxxingTargetLanguage = targetLanguage;
    window.dispatchEvent(new Event(YOUTUBE_TRACKS_REQUEST_EVENT));
  });
}

function supportedSite(pageUrl: string): SupportedSite {
  const hostname = new URL(pageUrl).hostname;
  if (hostname.includes("ardmediathek.de")) return "ard";
  if (hostname.includes("zdf.de")) return "zdf";
  if (hostname.includes("youtube.com")) return "youtube";
  return "netflix";
}

function isVideoPage(pageUrl: string): boolean {
  const url = new URL(pageUrl);
  if (url.hostname.includes("youtube.com")) {
    return url.pathname === "/watch" && Boolean(url.searchParams.get("v"));
  }
  if (url.hostname.includes("netflix.com")) {
    return url.pathname.startsWith("/watch/");
  }
  return true;
}

function videoLanguageOverride(): { sourceLanguage: string; targetLanguage: string } | undefined {
  try {
    const value = JSON.parse(sessionStorage.getItem(VIDEO_LANGUAGE_OVERRIDE_KEY) ?? "null") as {
      pageUrl?: unknown;
      sourceLanguage?: unknown;
      targetLanguage?: unknown;
    } | null;
    if (!value || value.pageUrl !== location.href) return undefined;
    if (typeof value.sourceLanguage !== "string" || typeof value.targetLanguage !== "string") {
      return undefined;
    }
    return {
      sourceLanguage: normalizeLanguageCode(value.sourceLanguage, "de"),
      targetLanguage: normalizeLanguageCode(value.targetLanguage, "en"),
    };
  } catch {
    return undefined;
  }
}

async function waitForVideo(signal: AbortSignal): Promise<HTMLVideoElement> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const video = document.querySelector("video");
    if (video) return video;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("The video player did not become available.");
}

class PageRuntime {
  private readonly abortController = new AbortController();
  private overlay?: SubtitleOverlay;
  private video?: HTMLVideoElement;
  private cues: SubtitleCue[] = [];
  private readonly processed = new Map<string, ProcessedCue>();
  private readonly pending = new Set<string>();
  private readonly priorityPending = new Set<string>();
  private translationRetryAfter = 0;
  private timeHandler?: () => void;
  private liveObserver?: MutationObserver;
  private liveCue?: SubtitleCue;
  private liveImmediateCue?: ProcessedCue;
  private youtubeTranslations: SubtitleCue[] = [];
  private source?: SubtitleSource;
  private preferenceHandler?: Parameters<typeof browser.storage.onChanged.addListener>[0];
  private visibilityHandler?: () => void;
  private desiredChunkAnchor?: number;
  private activeChunkAnchor?: number;
  private translationWorker?: Promise<void>;
  private readonly coveredChunkAnchors = new Set<number>();
  private isSeeking = false;
  private prioritizeNextCue = false;
  private timedPlaybackStarted = false;
  private netflixTrackLoading = false;
  private netflixTrackSignature = "";
  private enabled = true;
  private liveCaptionSelector?: string;
  private sourceLanguage = "de";
  private targetLanguage = "en";
  private codexModel = "gpt-5.6-luna";
  private codexEffort = "low";
  private hasVideoLanguageOverride = false;

  constructor(private readonly pageUrl: string) {}

  async start(): Promise<void> {
    const preferences = await loadSubtitlePreferences();
    const languageOverride = videoLanguageOverride();
    this.hasVideoLanguageOverride = Boolean(languageOverride);
    this.sourceLanguage = languageOverride?.sourceLanguage ?? preferences.learningLanguage;
    this.targetLanguage = languageOverride?.targetLanguage ?? preferences.translationLanguage;
    this.codexModel = preferences.codexModel;
    this.codexEffort = preferences.codexEffort;
    document.documentElement.dataset.polyglotMaxxingSourceLanguage = this.sourceLanguage;
    document.documentElement.dataset.polyglotMaxxingTargetLanguage = this.targetLanguage;
    let source: SubtitleSource;
    try {
      source = await resolveSubtitleSource(
        this.pageUrl,
        pageData(),
        (url, headers) => backgroundRequest({ type: "FETCH_JSON", url, headers }),
        this.sourceLanguage,
      );
    } catch (error) {
      if (error instanceof SubtitleTrackUnavailableError) {
        await this.mountUnavailable(preferences, error);
        return;
      }
      throw error;
    }
    let useYouTubeLiveCaptions = false;
    let unavailable: SubtitleTrackUnavailableError | undefined;
    this.source = source;
    if (source.delivery.kind === "webvtt") {
      if (source.site === "youtube") {
        try {
          const timedText = await requestYouTubeTimedText(
            source.episodeId,
            this.sourceLanguage,
            this.targetLanguage,
            this.abortController.signal,
          );
          if (timedText.error) {
            unavailable = new SubtitleTrackUnavailableError(
              this.sourceLanguage,
              timedText.availableLanguages ?? [],
              timedText.error,
            );
          } else {
            const timedTextBody = timedText.body ?? "";
            if (timedText.format === "translated-json3") {
              this.youtubeTranslations = parseYouTubeJson3(timedTextBody);
            } else if (timedText.format === "translated-webvtt") {
              this.youtubeTranslations = parseWebVtt(timedTextBody);
            } else {
              this.cues = timedText.format === "json3"
                ? parseYouTubeJson3(timedTextBody)
                : timedText.format === "transcript"
                  ? parseYouTubeTranscript(timedTextBody)
                  : parseWebVtt(timedTextBody);
              if (this.cues.length) {
                console.info(
                  `[Polyglot Maxxing] Loaded ${this.cues.length} ${this.sourceLanguage} YouTube timed-text cues.`,
                );
              }
            }
          }
        } catch (pageContextError) {
          console.info(
            "[Polyglot Maxxing] YouTube page-context captions were unavailable",
            pageContextError instanceof Error ? pageContextError.message : String(pageContextError),
          );
          if (source.delivery.subtitleUrl) {
            const vtt = await backgroundRequest<string>({
              type: "FETCH_TEXT",
              url: source.delivery.subtitleUrl,
              headers: source.delivery.requestHeaders,
            });
            this.cues = parseWebVtt(vtt);
          } else {
            throw pageContextError;
          }
        }
      } else {
        const vtt = await backgroundRequest<string>({
          type: "FETCH_TEXT",
          url: source.delivery.subtitleUrl,
          headers: source.delivery.requestHeaders,
        });
        this.cues = parseWebVtt(vtt);
      }
      if (!this.cues.length && source.site === "youtube") {
        useYouTubeLiveCaptions = true;
      } else if (!this.cues.length) {
        throw new Error("The subtitle file did not contain any cues.");
      }
    }
    try {
      this.video = await waitForVideo(this.abortController.signal);
    } catch (error) {
      if (unavailable && source.site === "youtube") {
        // Removed/private YouTube videos have neither captions nor a usable
        // video element. There is no player on which an extension notice can
        // be mounted, so settle quietly instead of creating an Errors entry.
        console.info("[Polyglot Maxxing] YouTube video is not playable", unavailable.message);
        return;
      }
      throw error;
    }
    seekToSavedTimestamp(this.video, this.pageUrl, this.abortController.signal);
    const savedWords = await this.loadSavedWords();
    this.enabled = preferences.enabledBySite[source.site];
    this.overlay = new SubtitleOverlay(
      source.episodeId,
      this.pageUrl,
      this.video,
      source.site,
      this.sourceLanguage,
      this.targetLanguage,
      uniqueLanguageCodes([
        ...(source.availableLanguages ?? []),
        ...(unavailable?.availableLanguages ?? []),
      ]),
      (word, mode) => this.saveWord(word, mode),
      (request, signal, onProgress) => this.loadInsight(request, signal, onProgress),
      preferences,
      savedWords,
      (enabled) => this.persistSiteEnabled(source.site, enabled),
      (sourceLanguage, targetLanguage) =>
        this.persistVideoLanguages(sourceLanguage, targetLanguage),
    );
    this.installPreferenceHandler(source.site);
    if (unavailable) {
      this.overlay.setNotice(unavailable.message);
      return;
    }
    this.visibilityHandler = () => {
      if (document.hidden) {
        this.desiredChunkAnchor = undefined;
        return;
      }
      if (this.cues.length) {
        this.prioritizeNextCue = true;
        this.onTimeUpdate();
      } else if (this.liveCaptionSelector) {
        this.readLiveCaption(this.liveCaptionSelector);
      }
    };
    document.addEventListener("visibilitychange", this.visibilityHandler, {
      signal: this.abortController.signal,
    });

    if (useYouTubeLiveCaptions) {
      this.startLiveCaptions(".ytp-caption-window-container");
    } else if (source.delivery.kind === "netflix") {
      this.startLiveCaptions(source.delivery.captionSelector);
      this.startNetflixTrackDiscovery();
    } else {
      this.startTimedPlayback();
    }
  }

  destroy(): void {
    this.abortController.abort();
    if (this.preferenceHandler) {
      try {
        browser.storage.onChanged.removeListener(this.preferenceHandler);
      } catch (error) {
        if (!isExtensionContextInvalidated(error)) throw error;
      }
    }
    this.liveObserver?.disconnect();
    this.overlay?.destroy();
  }

  private onTimeUpdate(): void {
    if (!this.video || !this.overlay) return;
    if (!this.enabled || document.hidden) return;
    const index = findActiveCueIndex(this.cues, this.video.currentTime);
    if (index < 0) {
      this.overlay.setCue(undefined);
    } else {
      const cue = this.cues[index]!;
      this.overlay.setCue(this.processed.get(cue.id) ?? cue);
      this.processSeekPriority(index);
    }
    const prefetchIndex = index >= 0
      ? index
      : findCueIndexAtOrAfter(this.cues, this.video.currentTime);
    if (prefetchIndex >= 0) this.schedulePrefetch(prefetchIndex);
  }

  private onSeeked(): void {
    if (!this.video || !this.overlay) return;
    this.isSeeking = false;
    if (!this.enabled || document.hidden) return;
    this.prioritizeNextCue = true;
    const index = findActiveCueIndex(this.cues, this.video.currentTime);
    if (index < 0) {
      this.overlay.setCue(undefined);
    } else {
      const cue = this.cues[index]!;
      this.overlay.setCue(this.processed.get(cue.id) ?? cue);
      this.processSeekPriority(index);
    }
    const prefetchIndex = index >= 0
      ? index
      : findCueIndexAtOrAfter(this.cues, this.video.currentTime);
    if (prefetchIndex >= 0) this.schedulePrefetch(prefetchIndex);
  }

  private startTimedPlayback(): void {
    if (this.timedPlaybackStarted || !this.video) return;
    this.timedPlaybackStarted = true;
    this.timeHandler = () => {
      if (!this.isSeeking && !this.video?.seeking) this.onTimeUpdate();
    };
    this.video.addEventListener("timeupdate", this.timeHandler, {
      signal: this.abortController.signal,
    });
    this.video.addEventListener("seeking", () => {
      this.isSeeking = true;
    }, {
      signal: this.abortController.signal,
    });
    this.video.addEventListener("seeked", () => this.onSeeked(), {
      signal: this.abortController.signal,
    });
    // Translate the cue currently on screen through the urgent lane while the
    // surrounding 24-cue chunk is prefetched in parallel.
    this.prioritizeNextCue = true;
    this.onTimeUpdate();
  }

  private schedulePrefetch(cueIndex: number): void {
    if (!this.enabled || document.hidden) return;
    const anchor = alignedSubtitleChunks(this.cues.length, cueIndex)[0]?.start;
    if (anchor === undefined || this.coveredChunkAnchors.has(anchor)) return;
    if (this.activeChunkAnchor === anchor || this.desiredChunkAnchor === anchor) return;
    this.desiredChunkAnchor = anchor;
    this.startTranslationWorker();
  }

  private startTranslationWorker(): void {
    if (this.translationWorker) return;
    this.translationWorker = this.runTranslationWorker().finally(() => {
      this.translationWorker = undefined;
      if (this.desiredChunkAnchor !== undefined && !this.abortController.signal.aborted) {
        this.startTranslationWorker();
      }
    });
  }

  private async runTranslationWorker(): Promise<void> {
    while (
      !this.abortController.signal.aborted &&
      this.enabled &&
      !document.hidden &&
      this.desiredChunkAnchor !== undefined
    ) {
      const anchor = this.desiredChunkAnchor;
      this.desiredChunkAnchor = undefined;
      this.activeChunkAnchor = anchor;
      const chunks = alignedSubtitleChunks(
        this.cues.length,
        anchor,
        SUBTITLE_BATCH_SIZE,
        PREFETCH_BATCH_COUNT,
      );
      for (const chunk of chunks) {
        if (
          this.abortController.signal.aborted ||
          !this.enabled ||
          document.hidden ||
          (this.desiredChunkAnchor !== undefined && this.desiredChunkAnchor !== anchor)
        ) {
          break;
        }
        const chunkCues = this.cues.slice(chunk.start, chunk.end);
        const batch = chunkCues
          .map((cue, offset) => ({ cue, index: chunk.start + offset }))
          .filter(({ cue }) => !this.processed.has(cue.id) && !this.pending.has(cue.id));
        if (batch.length && !(await this.processBatch(batch))) {
          break;
        }
        if (chunkCues.every((cue) => this.processed.has(cue.id))) {
          this.coveredChunkAnchors.add(chunk.start);
        }
      }
      this.activeChunkAnchor = undefined;
    }
  }

  private async processPriorityCue(index: number): Promise<void> {
    if (!this.enabled || document.hidden) return;
    const cue = this.cues[index];
    if (!cue || this.processed.has(cue.id) || this.priorityPending.has(cue.id)) return;
    this.priorityPending.add(cue.id);
    try {
      await this.processBatch([{ cue, index }]);
    } finally {
      this.priorityPending.delete(cue.id);
    }
  }

  private processSeekPriority(index: number): void {
    if (!this.prioritizeNextCue) return;
    this.prioritizeNextCue = false;
    void this.processPriorityCue(index);
  }

  private async processBatch(
    batch: Array<{ cue: SubtitleCue; index: number }>,
  ): Promise<boolean> {
    if (!this.enabled || document.hidden) return false;
    if (Date.now() < this.translationRetryAfter) return false;
    const claimedPending = batch
      .map(({ cue }) => cue.id)
      .filter((id) => !this.pending.has(id));
    batch.forEach(({ cue }) => this.pending.add(cue.id));
    try {
      const response = await backgroundRequest<ProcessCuesResponse>({
        type: "COMPANION_REQUEST",
        path: "/v1/cues/process",
        method: "POST",
        body: {
          sourceLanguage: this.sourceLanguage,
          targetLanguage: this.targetLanguage,
          model: this.codexModel,
          effort: this.codexEffort,
          cues: batch.map(({ cue, index }) => ({
            ...cue,
            contextBefore: index > 0 ? this.cues[index - 1]?.text : undefined,
            contextAfter: index + 1 < this.cues.length ? this.cues[index + 1]?.text : undefined,
          })),
        },
      });
      response.cues.forEach((cue) => this.processed.set(cue.id, cue));
      this.renderCurrentCue();
      return true;
    } catch (error) {
      if (isExtensionContextInvalidated(error)) return false;
      this.translationRetryAfter = Date.now() + 5_000;
      console.warn(
        "[Polyglot Maxxing] Subtitle batch processing failed",
        error instanceof Error ? error.message : String(error),
      );
      return false;
    } finally {
      claimedPending.forEach((id) => this.pending.delete(id));
    }
  }

  private renderCurrentCue(): void {
    if (!this.enabled || !this.video || !this.overlay || !this.cues.length) return;
    const index = findActiveCueIndex(this.cues, this.video.currentTime);
    if (index < 0) {
      this.overlay.setCue(undefined);
      return;
    }
    const cue = this.cues[index]!;
    this.overlay.setCue(this.processed.get(cue.id) ?? cue);
  }

  private startNetflixTrackDiscovery(): void {
    window.addEventListener(
      "message",
      (event: MessageEvent<unknown>) => {
        if (
          event.source !== window ||
          event.origin !== location.origin ||
          !isNetflixTimedTextMessage(event.data) ||
          event.data.episodeId !== this.source?.episodeId ||
          this.cues.length
        ) {
          return;
        }
        const track = selectNetflixTrack(event.data.tracks, this.sourceLanguage);
        if (!track) {
          this.overlay?.setNotice(new SubtitleTrackUnavailableError(
            this.sourceLanguage,
            uniqueLanguageCodes(event.data.tracks.map((candidate) => candidate.language)),
          ).message);
          return;
        }
        if (this.netflixTrackLoading) return;
        const signature = `${track.language}|${track.urls.join("|")}`;
        if (signature === this.netflixTrackSignature) return;
        void this.loadNetflixTrack(track.urls, signature);
      },
      { signal: this.abortController.signal },
    );
    window.dispatchEvent(new Event(NETFLIX_TRACKS_REQUEST_EVENT));
  }

  private async loadNetflixTrack(urls: string[], signature: string): Promise<void> {
    this.netflixTrackLoading = true;
    try {
      for (const url of urls) {
        try {
          const subtitleText = await backgroundRequest<string>({
            type: "FETCH_TEXT",
            url,
          });
          const cues = parseTimedText(subtitleText);
          if (!cues.length) continue;
          this.netflixTrackSignature = signature;
          this.cues = cues;
          this.liveCue = undefined;
          this.liveObserver?.disconnect();
          this.coveredChunkAnchors.clear();
          this.startTimedPlayback();
          console.info(
            `[Polyglot Maxxing] Loaded ${cues.length} ${this.sourceLanguage} Netflix timed-text cues.`,
          );
          return;
        } catch (error) {
          if (isExtensionContextInvalidated(error)) return;
          console.debug(
            "[Polyglot Maxxing] Netflix timed-text candidate was unavailable",
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      if (!this.abortController.signal.aborted) {
        window.setTimeout(() => {
          if (!this.abortController.signal.aborted && !this.cues.length) {
            window.dispatchEvent(new Event(NETFLIX_TRACKS_REQUEST_EVENT));
          }
        }, 3_000);
      }
    } finally {
      this.netflixTrackLoading = false;
    }
  }

  private async loadSavedWords(): Promise<SavedWord[]> {
    try {
      return await backgroundRequest<SavedWord[]>({
        type: "COMPANION_REQUEST",
        path: "/v1/saved-words",
        method: "GET",
      });
    } catch (error) {
      if (isExtensionContextInvalidated(error)) throw error;
      return [];
    }
  }

  private async saveWord(
    word: SavedWordInput,
    mode: "save" | "toggle" = "save",
  ): Promise<SavedWord> {
    return backgroundRequest<SavedWord>({
      type: "COMPANION_REQUEST",
      path: mode === "toggle" ? "/v1/saved-words/toggle-stage" : "/v1/saved-words",
      method: "POST",
      body: word,
    });
  }

  private async loadInsight(
    request: WordInsightRequest,
    signal: AbortSignal,
    onProgress?: (insights: PartialWordInsights) => void,
  ): Promise<WordInsightResponse> {
    try {
      return await streamWordInsight(request, signal, onProgress);
    } catch (error) {
      if (isExtensionContextInvalidated(error)) {
        window.dispatchEvent(new Event(CONTEXT_INVALIDATED_EVENT));
      }
      throw error;
    }
  }

  private startLiveCaptions(selector: string): void {
    this.liveCaptionSelector = selector;
    let queued = false;
    const update = () => {
      if (queued || this.abortController.signal.aborted) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        this.readLiveCaption(selector);
      });
    };
    this.liveObserver = new MutationObserver(update);
    this.liveObserver.observe(document.documentElement, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    this.timeHandler = update;
    this.video?.addEventListener("timeupdate", update, { signal: this.abortController.signal });
    update();
  }

  private readLiveCaption(selector: string): void {
    if (
      !this.enabled || document.hidden || !this.video || !this.overlay || this.cues.length
    ) return;
    const caption = document.querySelector<HTMLElement>(selector);
    const text = (caption?.innerText || caption?.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) {
      if (this.liveCue) {
        this.liveCue = undefined;
        this.liveImmediateCue = undefined;
        this.overlay.setCue(undefined);
      }
      return;
    }
    if (this.liveCue?.text === text) {
      const processed = this.processed.get(this.liveCue.id);
      this.overlay.setCue(processed ?? this.liveImmediateCue ?? this.liveCue);
      return;
    }
    const start = Math.max(0, this.video.currentTime);
    const id = `live-${Math.round(start * 10)}-${hashText(text)}`;
    this.liveCue = { id, start, end: start + 12, text };
    this.liveImmediateCue = undefined;
    const translationIndex = findActiveCueIndex(this.youtubeTranslations, start);
    const translatedCue = translationIndex >= 0
      ? this.youtubeTranslations[translationIndex]
      : undefined;
    if (translatedCue) {
      this.liveImmediateCue = {
        ...this.liveCue,
        translation: translatedCue.text,
        tokens: fallbackTokenAnalysis(text, this.sourceLanguage),
      };
    }
    this.overlay.setCue(this.liveImmediateCue ?? this.liveCue);
    void this.processLiveCue(this.liveCue);
  }

  private async processLiveCue(cue: SubtitleCue): Promise<void> {
    if (!this.enabled) return;
    if (this.pending.has(cue.id) || this.processed.has(cue.id)) return;
    this.pending.add(cue.id);
    try {
      const response = await backgroundRequest<ProcessCuesResponse>({
        type: "COMPANION_REQUEST",
        path: "/v1/cues/process",
        method: "POST",
        body: {
          sourceLanguage: this.sourceLanguage,
          targetLanguage: this.targetLanguage,
          model: this.codexModel,
          effort: this.codexEffort,
          cues: [cue],
        },
      });
      const processed = response.cues[0];
      if (!processed) return;
      const normalized: ProcessedCue = {
        ...processed,
        id: cue.id,
        start: cue.start,
        end: cue.end,
        text: cue.text,
      };
      this.processed.set(cue.id, normalized);
      if (this.liveCue?.text === cue.text) {
        this.liveImmediateCue = normalized;
        this.overlay?.setCue(normalized);
      }
    } catch (error) {
      if (isExtensionContextInvalidated(error)) return;
      console.warn(
        "[Polyglot Maxxing] Live caption translation failed",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      this.pending.delete(cue.id);
    }
  }

  private setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) {
      this.overlay?.setEnabled(enabled);
      return;
    }
    this.enabled = enabled;
    this.overlay?.setEnabled(enabled);
    if (!enabled) {
      this.desiredChunkAnchor = undefined;
      return;
    }
    if (this.cues.length) this.onTimeUpdate();
    else if (this.liveCaptionSelector) this.readLiveCaption(this.liveCaptionSelector);
  }

  private async persistSiteEnabled(
    site: SupportedSite,
    enabled: boolean,
  ): Promise<void> {
    this.setEnabled(enabled);
    const current = await loadSubtitlePreferences();
    await saveSubtitlePreferences({
      ...current,
      enabledBySite: {
        ...current.enabledBySite,
        [site]: enabled,
      },
    });
  }

  private async persistVideoLanguages(
    sourceLanguage: string,
    targetLanguage: string,
  ): Promise<void> {
    sessionStorage.setItem(VIDEO_LANGUAGE_OVERRIDE_KEY, JSON.stringify({
      pageUrl: location.href,
      sourceLanguage: normalizeLanguageCode(sourceLanguage, "de"),
      targetLanguage: normalizeLanguageCode(targetLanguage, "en"),
    }));
    window.dispatchEvent(new Event(LANGUAGES_CHANGED_EVENT));
  }

  private installPreferenceHandler(site: SupportedSite): void {
    this.preferenceHandler = (changes, areaName) => {
      if (areaName !== "local" || !changes[PREFERENCES_STORAGE_KEY]) return;
      const updated = normalizeSubtitlePreferences(
        changes[PREFERENCES_STORAGE_KEY]?.newValue,
      );
      this.overlay?.setPreferences(updated);
      this.codexModel = updated.codexModel;
      this.codexEffort = updated.codexEffort;
      this.setEnabled(updated.enabledBySite[site]);
      if (
        !this.hasVideoLanguageOverride &&
        (updated.learningLanguage !== this.sourceLanguage ||
          updated.translationLanguage !== this.targetLanguage)
      ) {
        window.dispatchEvent(new Event(LANGUAGES_CHANGED_EVENT));
      }
    };
    browser.storage.onChanged.addListener(this.preferenceHandler);
  }

  private async mountUnavailable(
    preferences: Awaited<ReturnType<typeof loadSubtitlePreferences>>,
    error: SubtitleTrackUnavailableError,
  ): Promise<void> {
    const site = supportedSite(this.pageUrl);
    this.video = await waitForVideo(this.abortController.signal);
    const episodeId = new URL(this.pageUrl).searchParams.get("v") ??
      new URL(this.pageUrl).pathname.split("/").filter(Boolean).at(-1) ?? this.pageUrl;
    this.enabled = preferences.enabledBySite[site];
    this.overlay = new SubtitleOverlay(
      episodeId,
      this.pageUrl,
      this.video,
      site,
      this.sourceLanguage,
      this.targetLanguage,
      error.availableLanguages,
      (word, mode) => this.saveWord(word, mode),
      (request, signal, onProgress) => this.loadInsight(request, signal, onProgress),
      preferences,
      await this.loadSavedWords(),
      (enabled) => this.persistSiteEnabled(site, enabled),
      (sourceLanguage, targetLanguage) =>
        this.persistVideoLanguages(sourceLanguage, targetLanguage),
    );
    this.installPreferenceHandler(site);
    this.overlay.setNotice(error.message);
  }
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export default defineContentScript({
  matches: [
    "https://www.ardmediathek.de/*",
    "https://www.zdf.de/*",
    "https://www.youtube.com/*",
    "https://www.netflix.com/*",
  ],
  runAt: "document_idle",
  main() {
    let currentUrl = "";
    let runtime: PageRuntime | undefined;
    let starting = false;
    let retired = false;
    let interval: number | undefined;

    const retire = () => {
      if (retired) return;
      retired = true;
      if (interval !== undefined) window.clearInterval(interval);
      runtime?.destroy();
      runtime = undefined;
    };

    const synchronize = async () => {
      if (retired || starting || location.href === currentUrl) return;
      starting = true;
      runtime?.destroy();
      currentUrl = location.href;
      if (!isVideoPage(currentUrl)) {
        runtime = undefined;
        starting = false;
        return;
      }
      const candidate = new PageRuntime(currentUrl);
      runtime = candidate;
      try {
        await candidate.start();
      } catch (error) {
        candidate.destroy();
        if (isExtensionContextInvalidated(error)) {
          retire();
          return;
        }
        if (error instanceof SubtitleTrackUnavailableError) {
          // A video without the selected learning-language track is a normal
          // content condition. Keep the URL settled instead of logging the
          // same warning every two seconds on Chrome's Extensions page.
          console.info(
            "[Polyglot Maxxing] No selected-language subtitle track",
            error.message,
          );
          return;
        }
        if (runtime === candidate) {
          console.warn(
            "[Polyglot Maxxing] Waiting for supported video subtitles",
            error instanceof Error ? error.message : String(error),
          );
          currentUrl = "";
        }
      } finally {
        starting = false;
      }
    };

    void synchronize();
    interval = window.setInterval(() => void synchronize(), 2000);
    window.addEventListener(CONTEXT_INVALIDATED_EVENT, retire, { once: true });
    window.addEventListener(LANGUAGES_CHANGED_EVENT, () => {
      if (retired) return;
      runtime?.destroy();
      runtime = undefined;
      currentUrl = "";
      void synchronize();
    });
    window.addEventListener("pagehide", () => {
      retire();
    });
  },
});
