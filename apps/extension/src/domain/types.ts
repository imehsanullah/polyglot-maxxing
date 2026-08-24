export type SupportedSite = "ard" | "zdf" | "youtube" | "netflix";

export type SubtitleDelivery =
  | { kind: "webvtt"; subtitleUrl: string; requestHeaders?: Record<string, string> }
  | { kind: "netflix"; captionSelector: string };

export interface SubtitleSource {
  site: SupportedSite;
  episodeId: string;
  pageUrl: string;
  language: string;
  availableLanguages?: string[];
  delivery: SubtitleDelivery;
}

export interface SubtitleCue {
  id: string;
  start: number;
  end: number;
  text: string;
}

export interface TokenAnalysis {
  surface: string;
  lemma: string;
  pos: string;
  morphology: Record<string, string>;
  start: number;
  end: number;
  meanings: string[];
}

export interface ProcessedCue extends SubtitleCue {
  translation: string;
  tokens: TokenAnalysis[];
}

export interface ProcessCuesResponse {
  cues: ProcessedCue[];
  model: string;
}

export interface SavedWordInput {
  surface: string;
  lemma: string;
  pos: string;
  meaning?: string;
  meanings?: string[];
  morphology?: Record<string, string>;
  germanSentence: string;
  englishSentence: string;
  sourceLanguage: string;
  targetLanguage: string;
  videoUrl: string;
  episodeId: string;
  cueId: string;
  cueStart: number;
}

export type LearningStage = "learning" | "known" | "ignored";

export interface SavedWord extends SavedWordInput {
  id: number;
  learningStage: LearningStage;
  occurrenceCount: number;
  createdAt: string;
  updatedAt: string;
  meanings: string[];
  morphology: Record<string, string>;
}

export type WordInsightKind = "explain" | "examples" | "grammar";
export type CodexModel = string;
export type CodexEffort = string;

export interface CodexModelInfo {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: string[];
}

export interface CodexModelsResponse {
  models: CodexModelInfo[];
}

export interface WordInsightRequest {
  word: string;
  lemma: string;
  context: string;
  contextTranslation: string;
  pos: string;
  morphology: Record<string, string>;
  meanings: string[];
  sourceLanguage: string;
  targetLanguage: string;
  model: CodexModel;
  effort: CodexEffort;
}

export type WordInsights = Record<WordInsightKind, string>;
export type PartialWordInsights = Partial<WordInsights>;

export interface WordInsightResponse {
  insights: WordInsights;
  model: string;
  cached: boolean;
}

export const WORD_INSIGHT_STREAM_PORT = "polyglot-maxxing-word-insight";

export interface WordInsightStreamStart {
  type: "start";
  request: WordInsightRequest;
}

export type WordInsightStreamEvent =
  | { type: "delta"; delta: string }
  | ({ type: "done" } & WordInsightResponse)
  | { type: "error"; error: string; status?: number };

export interface CodexStatus {
  available: boolean;
  authenticated: boolean;
  authMode?: string;
  email?: string;
  planType?: string;
  loginPending: boolean;
  error?: string;
}

export interface CodexLogoutResponse {
  disconnected: boolean;
}

export interface CodexLoginStart {
  loginId: string;
  verificationUrl: string;
  userCode: string;
}

export type BackgroundRequest =
  | {
      type: "FETCH_TEXT";
      url: string;
      headers?: Record<string, string>;
    }
  | {
      type: "FETCH_JSON";
      url: string;
      headers?: Record<string, string>;
    }
  | {
      type: "COMPANION_REQUEST";
      path: string;
      method?: "GET" | "POST" | "PATCH" | "DELETE";
      body?: unknown;
    };

export interface BackgroundResponse<T = unknown> {
  ok: boolean;
  status: number;
  data?: T;
  error?: string;
}
