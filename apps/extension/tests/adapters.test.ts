import { describe, expect, it, vi } from "vitest";
import { extractArdWebVttUrl, resolveArdSource } from "../src/adapters/ard";
import {
  extractNetflixTimedTextTrack,
  isNetflixTimedTextMessage,
  isNetflixTimedTextUrl,
  NETFLIX_TRACKS_CHANNEL,
  resolveNetflixSource,
  selectNetflixTrack,
} from "../src/adapters/netflix";
import {
  extractYouTubeCaptionUrl,
  isYouTubeTimedTextMessage,
  resolveYouTubeSource,
  YOUTUBE_TRACKS_CHANNEL,
} from "../src/adapters/youtube";
import { extractZdfPlayerMetadata, resolveZdfSource } from "../src/adapters/zdf";

describe("ARD adapter", () => {
  it("extracts the German WebVTT URL from embedded page data", () => {
    const source = String.raw`"subtitles":[{"kind":"normal","languageCode":"deu","sources":[{"kind":"webvtt","url":"https://api.ardmediathek.de/player-service/subtitle/webvtt/urn:ard:subtitle:5701ab63d8242673.vtt"}]}]`;
    expect(extractArdWebVttUrl(source)).toBe(
      "https://api.ardmediathek.de/player-service/subtitle/webvtt/urn:ard:subtitle:5701ab63d8242673.vtt",
    );
  });

  it("falls back to the media collection endpoint", async () => {
    const fetchJson = vi.fn().mockResolvedValue({
      subtitles: [
        {
          languageCode: "deu",
          sources: [
            {
              kind: "webvtt",
              url: "https://api.ardmediathek.de/player-service/subtitle/webvtt/urn:ard:subtitle:test.vtt",
            },
          ],
        },
      ],
    });
    const source = await resolveArdSource(
      "https://www.ardmediathek.de/video/show/title/ard/episode-id",
      "",
      fetchJson,
    );
    expect(source.delivery.kind).toBe("webvtt");
    expect(source.delivery.kind === "webvtt" && source.delivery.subtitleUrl.endsWith("urn:ard:subtitle:test.vtt")).toBe(true);
    expect(fetchJson).toHaveBeenCalledOnce();
  });
});

describe("ZDF adapter", () => {
  const embedded = String.raw`"tokens":{"videoToken":{"apiToken":"temporary-token","expiresAt":"soon"}},"currentMedia":{"nodes":[{"ptmdTemplate":"/tmd/2/{playerId}/vod/ptmd/mediathek/260715_2145_sendung_tfo/5"}]}`;

  it("extracts the rotating video token and PTMD template", () => {
    expect(extractZdfPlayerMetadata(embedded)).toEqual({
      apiToken: "temporary-token",
      ptmdTemplate: "/tmd/2/{playerId}/vod/ptmd/mediathek/260715_2145_sendung_tfo/5",
      playerId: "ngplayer_2_5",
    });
  });

  it("selects the German WebVTT caption from PTMD", async () => {
    const fetchJson = vi.fn().mockResolvedValue({
      captions: [
        { format: "ebu-tt-d-basic-de", language: "deu", uri: "https://example.test/de.xml" },
        { format: "webvtt", language: "deu", uri: "https://example.test/de.vtt" },
      ],
    });
    const source = await resolveZdfSource(
      "https://www.zdf.de/play/serien/show/episode-100",
      embedded,
      fetchJson,
    );
    expect(source.delivery).toEqual({
      kind: "webvtt",
      subtitleUrl: "https://example.test/de.vtt",
    });
    expect(fetchJson).toHaveBeenCalledWith(
      "https://api.zdf.de/tmd/2/ngplayer_2_5/vod/ptmd/mediathek/260715_2145_sendung_tfo/5",
      expect.objectContaining({ "Api-Auth": "Bearer temporary-token" }),
    );
  });
});

describe("YouTube adapter", () => {
  const pageData = JSON.stringify({
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          {
            baseUrl: "https://www.youtube.com/api/timedtext?v=test&lang=en",
            languageCode: "en",
            name: { simpleText: "English" },
          },
          {
            baseUrl: "https://www.youtube.com/api/timedtext?v=test&lang=de",
            languageCode: "de",
            name: { simpleText: "Deutsch" },
          },
        ],
      },
    },
  });

  it("selects the German caption track and requests WebVTT", () => {
    const url = extractYouTubeCaptionUrl(pageData);
    expect(url).toContain("lang=de");
    expect(url).toContain("fmt=vtt");
  });

  it("uses the YouTube video id as the episode id", () => {
    const source = resolveYouTubeSource(
      "https://www.youtube.com/watch?v=gw_BUDk610w",
      pageData,
    );
    expect(source.site).toBe("youtube");
    expect(source.episodeId).toBe("gw_BUDk610w");
  });

  it("selects an arbitrary requested caption language", () => {
    expect(extractYouTubeCaptionUrl(pageData, "en")).toContain("lang=en");
    expect(resolveYouTubeSource(
      "https://www.youtube.com/watch?v=gw_BUDk610w",
      pageData,
      "es",
    )).toMatchObject({
      language: "es",
      availableLanguages: ["en", "de"],
      delivery: { kind: "webvtt", subtitleUrl: "" },
    });
  });

  it("accepts a missing-caption response as a typed page result", () => {
    expect(isYouTubeTimedTextMessage({
      channel: YOUTUBE_TRACKS_CHANNEL,
      episodeId: "test",
      format: "json3",
      sourceLanguage: "de",
      availableLanguages: ["en"],
      error: "No de YouTube caption track was found.",
    })).toBe(true);
  });
});

describe("Netflix adapter", () => {
  it("uses Netflix timed text with rendered captions as its fallback", () => {
    const source = resolveNetflixSource("https://www.netflix.com/watch/81913705");
    expect(source.site).toBe("netflix");
    expect(source.episodeId).toBe("81913705");
    expect(source.delivery).toEqual({
      kind: "netflix",
      captionSelector:
        "html[data-polyglot-maxxing-netflix-language='de'] .player-timedtext-text-container",
    });
  });

  it("selects a non-SDH German signed timed-text track", () => {
    const signedUrl = "https://ipv4-c001-ams001.oca.nflxvideo.net/range/1-2?token=test";
    const track = selectNetflixTrack([
      { language: "en", urls: [signedUrl], isSdh: false },
      { language: "de-DE", urls: [signedUrl], isSdh: true },
      { language: "de", urls: [signedUrl], isSdh: false },
    ]);
    expect(track?.language).toBe("de");
    expect(isNetflixTimedTextUrl(signedUrl)).toBe(true);
    expect(isNetflixTimedTextUrl("https://example.com/subtitles.xml")).toBe(false);
    expect(isNetflixTimedTextMessage({
      channel: NETFLIX_TRACKS_CHANNEL,
      episodeId: "81913705",
      tracks: [track],
    })).toBe(true);
  });

  it("extracts signed URLs from Netflix's nested player track objects", () => {
    const track = extractNetflixTimedTextTrack({
      bcp47: "de-DE",
      isForcedNarrative: false,
      downloadables: {
        imsc1: {
          downloadUrls: {
            first: "https://ipv4-c001-ams001.oca.nflxvideo.net/range/1-2?token=a&b=c",
          },
        },
      },
    });
    expect(track).toEqual({
      language: "de-DE",
      urls: ["https://ipv4-c001-ams001.oca.nflxvideo.net/range/1-2?token=a&b=c"],
      isSdh: false,
    });
  });

  it("selects Netflix tracks using normalized BCP-47 language tags", () => {
    const signedUrl = "https://ipv4-c001-ams001.oca.nflxvideo.net/range/1-2?token=test";
    expect(selectNetflixTrack([
      { language: "de-DE", urls: [signedUrl], isSdh: false },
      { language: "es-MX", urls: [signedUrl], isSdh: false },
    ], "es")?.language).toBe("es-MX");
  });

  it("rejects actual forced-narrative tracks without rejecting the field name", () => {
    const signedUrl = "https://ipv4-c001-ams001.oca.nflxvideo.net/range/1-2?token=a";
    expect(extractNetflixTimedTextTrack({
      bcp47: "de",
      isForcedNarrative: true,
      downloadables: { webvtt: { downloadUrls: { first: signedUrl } } },
    })).toBeUndefined();
  });
});
