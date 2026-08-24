const TIMESTAMP_KEY = "polyglot-maxxing-t";

export function savedTimestampUrl(videoUrl: string, cueStart: number): string {
  try {
    const url = new URL(videoUrl);
    const seconds = Math.max(0, Number.isFinite(cueStart) ? cueStart : 0);
    if (url.hostname.includes("youtube.com") || url.hostname.includes("youtu.be")) {
      url.searchParams.set("t", `${Math.floor(seconds)}s`);
    }
    url.hash = `${TIMESTAMP_KEY}=${seconds}`;
    return url.toString();
  } catch {
    return videoUrl;
  }
}

export function savedTimestampFromUrl(pageUrl: string): number | undefined {
  try {
    const value = new URLSearchParams(new URL(pageUrl).hash.slice(1)).get(TIMESTAMP_KEY);
    if (value === null || value.trim() === "") return undefined;
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
  } catch {
    return undefined;
  }
}

export function seekToSavedTimestamp(
  video: HTMLVideoElement,
  pageUrl: string,
  signal: AbortSignal,
): void {
  const seconds = savedTimestampFromUrl(pageUrl);
  if (seconds === undefined) return;
  const seek = () => {
    if (signal.aborted || video.readyState === 0) return;
    const upperBound = Number.isFinite(video.duration) && video.duration > 0
      ? Math.max(0, video.duration - 0.05)
      : seconds;
    video.currentTime = Math.min(seconds, upperBound);
  };
  seek();
  if (video.readyState === 0) {
    video.addEventListener("loadedmetadata", seek, { once: true, signal });
  }
}
