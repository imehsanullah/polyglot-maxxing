export interface LanguageOption {
  code: string;
  name: string;
}

export const LANGUAGE_OPTIONS: readonly LanguageOption[] = [
  { code: "de", name: "German" },
  { code: "en", name: "English" },
  { code: "es", name: "Spanish" },
  { code: "fr", name: "French" },
  { code: "it", name: "Italian" },
  { code: "pt", name: "Portuguese" },
  { code: "nl", name: "Dutch" },
  { code: "pl", name: "Polish" },
  { code: "sv", name: "Swedish" },
  { code: "da", name: "Danish" },
  { code: "no", name: "Norwegian" },
  { code: "fi", name: "Finnish" },
  { code: "tr", name: "Turkish" },
  { code: "ru", name: "Russian" },
  { code: "uk", name: "Ukrainian" },
  { code: "ja", name: "Japanese" },
  { code: "ko", name: "Korean" },
  { code: "zh", name: "Chinese" },
  { code: "ar", name: "Arabic" },
  { code: "hi", name: "Hindi" },
] as const;

const LANGUAGE_ALIASES: Record<string, string> = {
  deu: "de",
  ger: "de",
  eng: "en",
  spa: "es",
  fre: "fr",
  fra: "fr",
  ita: "it",
  por: "pt",
  dut: "nl",
  nld: "nl",
  pol: "pl",
  swe: "sv",
  dan: "da",
  nor: "no",
  fin: "fi",
  tur: "tr",
  rus: "ru",
  ukr: "uk",
  jpn: "ja",
  kor: "ko",
  zho: "zh",
  chi: "zh",
  ara: "ar",
  hin: "hi",
};

export function normalizeLanguageCode(value: string | undefined, fallback = ""): string {
  const cleaned = (value ?? "")
    .trim()
    .replace(/_/g, "-")
    .toLocaleLowerCase("en")
    .split("-")[0] ?? "";
  if (!cleaned) return fallback;
  return LANGUAGE_ALIASES[cleaned] ?? cleaned;
}

export function languageMatches(candidate: string | undefined, desired: string): boolean {
  return normalizeLanguageCode(candidate) === normalizeLanguageCode(desired);
}

export function languageName(code: string): string {
  const normalized = normalizeLanguageCode(code, code);
  return LANGUAGE_OPTIONS.find((option) => option.code === normalized)?.name ??
    normalized.toLocaleUpperCase("en");
}

export function languageLabel(code: string): string {
  return normalizeLanguageCode(code, code).toLocaleUpperCase("en");
}

export function uniqueLanguageCodes(codes: Array<string | undefined>): string[] {
  return Array.from(new Set(codes
    .map((code) => normalizeLanguageCode(code))
    .filter(Boolean)));
}

export class SubtitleTrackUnavailableError extends Error {
  constructor(
    public readonly requestedLanguage: string,
    public readonly availableLanguages: string[] = [],
    message?: string,
  ) {
    const requested = languageName(requestedLanguage);
    const available = availableLanguages.length
      ? ` Available caption languages: ${availableLanguages.map(languageName).join(", ")}.`
      : " This video has no usable caption tracks.";
    super(message ?? `No ${requested} captions were found.${available}`);
    this.name = "SubtitleTrackUnavailableError";
  }
}
