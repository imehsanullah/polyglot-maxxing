import type { CodexEffort, CodexModel, SupportedSite } from "../domain/types";
import { normalizeLanguageCode } from "./languages";

export const PREFERENCES_STORAGE_KEY = "polyglotMaxxingPreferences";

export interface SubtitlePreferences {
  learningLanguage: string;
  translationLanguage: string;
  fontSize: number;
  pauseOnWordClick: boolean;
  enabledBySite: Record<SupportedSite, boolean>;
  codexEnabled: boolean;
  codexModel: CodexModel;
  codexEffort: CodexEffort;
}

export const DEFAULT_SUBTITLE_PREFERENCES: SubtitlePreferences = {
  learningLanguage: "de",
  translationLanguage: "en",
  fontSize: 28,
  pauseOnWordClick: true,
  enabledBySite: {
    ard: true,
    zdf: true,
    youtube: true,
    netflix: true,
  },
  codexEnabled: false,
  codexModel: "gpt-5.6-luna",
  codexEffort: "low",
};

export function normalizeSubtitlePreferences(value: unknown): SubtitlePreferences {
  if (!value || typeof value !== "object") return DEFAULT_SUBTITLE_PREFERENCES;
  const raw = value as { fontSize?: unknown; fontScale?: unknown };
  const directFontSize = Number(raw.fontSize);
  const legacyFontScale = Number(raw.fontScale);
  const fontSize = Number.isFinite(directFontSize)
    ? directFontSize
    : Number.isFinite(legacyFontScale)
      ? legacyFontScale * 0.28
      : Number.NaN;
  const preferences = value as Partial<SubtitlePreferences>;
  const enabledBySite: Partial<Record<SupportedSite, boolean>> =
    preferences.enabledBySite && typeof preferences.enabledBySite === "object"
      ? preferences.enabledBySite
      : {};
  const codexModel: CodexModel = typeof preferences.codexModel === "string" &&
      preferences.codexModel.trim()
    ? preferences.codexModel.trim()
    : DEFAULT_SUBTITLE_PREFERENCES.codexModel;
  const codexEffort: CodexEffort = typeof preferences.codexEffort === "string" &&
      preferences.codexEffort.trim()
    ? preferences.codexEffort.trim()
    : DEFAULT_SUBTITLE_PREFERENCES.codexEffort;
  return {
    learningLanguage: normalizeLanguageCode(
      preferences.learningLanguage,
      DEFAULT_SUBTITLE_PREFERENCES.learningLanguage,
    ),
    translationLanguage: normalizeLanguageCode(
      preferences.translationLanguage,
      DEFAULT_SUBTITLE_PREFERENCES.translationLanguage,
    ),
    fontSize: Number.isFinite(fontSize)
      ? Math.min(52, Math.max(18, Math.round(fontSize)))
      : DEFAULT_SUBTITLE_PREFERENCES.fontSize,
    pauseOnWordClick: preferences.pauseOnWordClick !== false,
    enabledBySite: {
      ard: enabledBySite.ard !== false,
      zdf: enabledBySite.zdf !== false,
      youtube: enabledBySite.youtube !== false,
      netflix: enabledBySite.netflix !== false,
    },
    codexEnabled: preferences.codexEnabled === true,
    codexModel,
    codexEffort,
  };
}

export async function loadSubtitlePreferences(): Promise<SubtitlePreferences> {
  const stored = await browser.storage.local.get(PREFERENCES_STORAGE_KEY);
  return normalizeSubtitlePreferences(stored[PREFERENCES_STORAGE_KEY]);
}

export async function saveSubtitlePreferences(
  preferences: SubtitlePreferences,
): Promise<void> {
  await browser.storage.local.set({
    [PREFERENCES_STORAGE_KEY]: normalizeSubtitlePreferences(preferences),
  });
}
