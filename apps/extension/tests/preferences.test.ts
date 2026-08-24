import { describe, expect, it } from "vitest";
import {
  DEFAULT_SUBTITLE_PREFERENCES,
  normalizeSubtitlePreferences,
} from "../src/lib/preferences";

describe("subtitle preferences", () => {
  it("uses the default for missing or invalid values", () => {
    expect(normalizeSubtitlePreferences(undefined)).toEqual(DEFAULT_SUBTITLE_PREFERENCES);
    expect(normalizeSubtitlePreferences({ fontScale: "large" })).toEqual(
      DEFAULT_SUBTITLE_PREFERENCES,
    );
  });

  it("rounds and clamps the numeric font size", () => {
    expect(normalizeSubtitlePreferences({ fontSize: 31.6 }).fontSize).toBe(32);
    expect(normalizeSubtitlePreferences({ fontSize: 10 }).fontSize).toBe(18);
    expect(normalizeSubtitlePreferences({ fontSize: 500 }).fontSize).toBe(52);
  });

  it("migrates the old percentage setting to pixels", () => {
    expect(normalizeSubtitlePreferences({ fontScale: 100 }).fontSize).toBe(28);
    expect(normalizeSubtitlePreferences({ fontScale: 115 }).fontSize).toBe(32);
    expect(normalizeSubtitlePreferences({ fontScale: 160 }).fontSize).toBe(45);
  });

  it("preserves catalog-driven model and effort values", () => {
    expect(normalizeSubtitlePreferences({
      fontSize: 28,
      codexModel: "gpt-5.6-sol",
      codexEffort: "max",
    })).toMatchObject({
      codexModel: "gpt-5.6-sol",
      codexEffort: "max",
    });
  });

  it("keeps a separate enabled state for every supported site", () => {
    const preferences = normalizeSubtitlePreferences({
      fontSize: 28,
      enabledBySite: { youtube: false, netflix: true },
    });

    expect(preferences.enabledBySite).toEqual({
      ard: true,
      zdf: true,
      youtube: false,
      netflix: true,
    });
  });

  it("migrates legacy German-to-English preferences and normalizes language tags", () => {
    expect(normalizeSubtitlePreferences({ fontSize: 28 })).toMatchObject({
      learningLanguage: "de",
      translationLanguage: "en",
    });
    expect(normalizeSubtitlePreferences({
      fontSize: 28,
      learningLanguage: "ES-MX",
      translationLanguage: "FRA",
    })).toMatchObject({
      learningLanguage: "es",
      translationLanguage: "fr",
    });
  });
});
