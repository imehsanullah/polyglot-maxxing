import {
  extractNetflixTimedTextTrack,
  NETFLIX_TRACKS_CHANNEL,
  NETFLIX_TRACKS_REQUEST_EVENT,
  type NetflixTimedTextMessage,
  type NetflixTimedTextTrack,
} from "../src/adapters/netflix";
import { languageMatches, normalizeLanguageCode } from "../src/lib/languages";

interface NetflixPlayer {
  getTextTrackList?: () => unknown[];
  getTextTrack?: () => unknown;
  getTimedTextTrackList?: () => unknown[];
  getTimedTextTrack?: () => unknown;
  setTimedTextTrack?: (track: unknown) => void;
  setTextTrack?: (track: unknown) => void;
  setTimedTextVisibility?: (visible: boolean) => void;
  setTimedTextVisible?: (visible: boolean) => void;
}

interface NetflixManifestContainer {
  result?: NetflixManifest;
}

interface NetflixManifest {
  timedtexttracks?: unknown[];
  textTracks?: unknown[];
}

const manifestTracks = new Map<string, NetflixTimedTextTrack>();

function rememberTrack(value: unknown): void {
  const track = extractNetflixTimedTextTrack(value);
  if (!track) return;
  const key = `${track.language}|${track.isSdh}|${track.urls.join("|")}`;
  manifestTracks.set(key, track);
}

function captureManifest(value: unknown): void {
  if (!value || typeof value !== "object") return;
  const container = value as NetflixManifestContainer;
  const manifest = container.result ?? value as NetflixManifest;
  const tracks = manifest.timedtexttracks ?? manifest.textTracks;
  if (!Array.isArray(tracks)) return;
  tracks.forEach(rememberTrack);
}

function installManifestCapture(): void {
  const nativeParse = JSON.parse;
  JSON.parse = function parseWithNetflixManifestCapture(
    text: string,
    reviver?: (this: unknown, key: string, value: unknown) => unknown,
  ): unknown {
    const value = nativeParse.call(JSON, text, reviver);
    try {
      captureManifest(value);
    } catch {
      // A Netflix response must never fail because subtitle discovery did.
    }
    return value;
  } as typeof JSON.parse;
}

function currentEpisodeId(): string | undefined {
  return location.pathname.match(/\/watch\/(\d+)/)?.[1];
}

function netflixPlayer(): NetflixPlayer | undefined {
  try {
    const netflix = (window as typeof window & {
      netflix?: {
        appContext?: {
          state?: {
            playerApp?: {
              getAPI?: () => {
                videoPlayer?: {
                  getAllPlayerSessionIds?: () => unknown[];
                  getVideoPlayerBySessionId?: (id: unknown) => NetflixPlayer;
                };
              };
            };
          };
        };
      };
    }).netflix;
    const videoPlayer = netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer;
    const sessionIds = videoPlayer?.getAllPlayerSessionIds?.() ?? [];
    for (const sessionId of sessionIds) {
      if (!/watch/i.test(String(sessionId))) continue;
      const player = videoPlayer?.getVideoPlayerBySessionId?.(sessionId);
      if (player?.getTextTrackList) return player;
    }
  } catch {
    // Netflix's private player API can be unavailable while the SPA changes route.
  }
  return undefined;
}

function readTracks(): NetflixTimedTextTrack[] {
  let tracks: unknown[];
  try {
    tracks = netflixPlayer()?.getTextTrackList?.() ?? [];
  } catch {
    return [];
  }
  const discovered = new Map(manifestTracks);
  for (const track of tracks) {
    const discoveredTrack = extractNetflixTimedTextTrack(track);
    if (!discoveredTrack) continue;
    const key = `${discoveredTrack.language}|${discoveredTrack.isSdh}|${
      discoveredTrack.urls.join("|")}`;
    discovered.set(key, discoveredTrack);
  }
  return Array.from(discovered.values());
}

function trackRecord(track: unknown): Record<string, unknown> | undefined {
  return track && typeof track === "object"
    ? track as Record<string, unknown>
    : undefined;
}

function trackLanguage(track: unknown): string {
  const value = trackRecord(track)?.bcp47;
  return typeof value === "string" ? value : "";
}

function isUsableTrack(track: unknown, language: string): boolean {
  const record = trackRecord(track);
  return Boolean(
    record &&
    languageMatches(trackLanguage(record), language) &&
    record.isNoneTrack !== true &&
    record.isForcedNarrative !== true,
  );
}

function preferPrimaryTrack(left: unknown, right: unknown): number {
  const leftType = String(trackRecord(left)?.trackType ?? "");
  const rightType = String(trackRecord(right)?.trackType ?? "");
  return Number(leftType !== "PRIMARY") - Number(rightType !== "PRIMARY");
}

function desiredLanguage(): string {
  return normalizeLanguageCode(
    document.documentElement.dataset.polyglotMaxxingSourceLanguage,
    "de",
  );
}

function ensureTrack(player: NetflixPlayer | undefined, language: string): void {
  if (!player) return;
  const currentText = player.getTextTrack?.();
  const currentTimedText = player.getTimedTextTrack?.();
  if (isUsableTrack(currentText, language) || isUsableTrack(currentTimedText, language)) {
    document.documentElement.dataset.polyglotMaxxingNetflixLanguage = language;
    player.setTimedTextVisibility?.(true);
    player.setTimedTextVisible?.(true);
    return;
  }

  delete document.documentElement.dataset.polyglotMaxxingNetflixLanguage;
  const textTrack = (player.getTextTrackList?.() ?? [])
    .filter((track) => isUsableTrack(track, language))
    .sort(preferPrimaryTrack)[0];
  const timedTextTrack = (player.getTimedTextTrackList?.() ?? [])
    .filter((track) => isUsableTrack(track, language))
    .sort(preferPrimaryTrack)[0];
  try {
    if (textTrack && player.setTextTrack) player.setTextTrack(textTrack);
    else if (timedTextTrack && player.setTimedTextTrack) {
      player.setTimedTextTrack(timedTextTrack);
    }
  } catch {
    // Netflix can replace the player session while changing episodes.
  }
}

let lastSignature = "";

function publish(force = false): void {
  ensureTrack(netflixPlayer(), desiredLanguage());
  const episodeId = currentEpisodeId();
  const tracks = readTracks();
  if (!episodeId) return;
  const signature = `${episodeId}|${tracks.map((track) =>
    `${track.language}:${track.urls.join(",")}`).join("|")}`;
  if (!force && signature === lastSignature) return;
  lastSignature = signature;
  const message: NetflixTimedTextMessage = {
    channel: NETFLIX_TRACKS_CHANNEL,
    episodeId,
    tracks,
  };
  window.postMessage(message, location.origin);
}

export default defineContentScript({
  matches: ["https://www.netflix.com/*"],
  runAt: "document_start",
  world: "MAIN",
  main() {
    installManifestCapture();
    window.addEventListener(NETFLIX_TRACKS_REQUEST_EVENT, () => publish(true));
    window.setInterval(() => publish(), 3_000);
    publish();
  },
});
