import type {
  ProcessedCue,
  LearningStage,
  PartialWordInsights,
  SavedWord,
  SavedWordInput,
  SubtitleCue,
  SupportedSite,
  TokenAnalysis,
  WordInsightRequest,
  WordInsightResponse,
  WordInsightKind,
  WordInsights,
} from "../domain/types";
import type { SubtitlePreferences } from "../lib/preferences";
import {
  LANGUAGE_OPTIONS,
  languageLabel,
  languageName,
  normalizeLanguageCode,
} from "../lib/languages";

type SaveHandler = (
  word: SavedWordInput,
  mode?: "save" | "toggle",
) => Promise<SavedWord | void>;
type InsightHandler = (
  request: WordInsightRequest,
  signal: AbortSignal,
  onProgress?: (insights: PartialWordInsights) => void,
) => Promise<WordInsightResponse>;
type ToggleHandler = (enabled: boolean) => Promise<void> | void;
type LanguageHandler = (sourceLanguage: string, targetLanguage: string) => Promise<void> | void;

const STYLE = `
  :host {
    all: initial;
    position: absolute;
    inset: 0;
    z-index: 2147483647;
    display: block;
    overflow: hidden;
    pointer-events: none;
    container-type: size;
  }
  *, *::before, *::after { box-sizing: border-box; }
  .root {
    position: absolute;
    left: 50%;
    bottom: clamp(50px, 11%, 104px);
    transform: translateX(-50%);
    width: min(920px, calc(100% - 32px));
    color: #fff;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 16px;
    text-align: center;
    pointer-events: none;
  }
  .site-toggle {
    appearance: none;
    position: absolute;
    top: 10px;
    left: 10px;
    z-index: 5;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-height: 28px;
    padding: 4px 9px 4px 6px;
    border: 1px solid rgba(255,255,255,.35);
    border-radius: 999px;
    background: rgba(22,24,27,.82);
    box-shadow: 0 2px 9px rgba(0,0,0,.38);
    color: #baf6db;
    font: 750 11px/1 system-ui, sans-serif;
    letter-spacing: .02em;
    cursor: pointer;
    pointer-events: auto;
    backdrop-filter: blur(5px);
  }
  .site-toggle:hover, .site-toggle:focus-visible {
    border-color: rgba(156,251,209,.9);
    background: rgba(22,24,27,.96);
    outline: none;
  }
  .site-toggle.off { color: #d0d0d0; background: rgba(45,45,45,.72); }
  .site-toggle-mark {
    display: grid;
    width: 18px;
    height: 18px;
    place-items: center;
    border-radius: 50%;
    background: #27a875;
    color: #07170f;
    font: 900 8px/1 system-ui, sans-serif;
  }
  .site-toggle.off .site-toggle-mark { background: #8a8a8a; color: #202020; }
  .language-toggle {
    appearance: none;
    position: absolute;
    top: 10px;
    left: 82px;
    z-index: 5;
    min-height: 28px;
    padding: 5px 9px;
    border: 1px solid rgba(255,255,255,.35);
    border-radius: 999px;
    background: rgba(22,24,27,.82);
    box-shadow: 0 2px 9px rgba(0,0,0,.38);
    color: #fff;
    font: 750 11px/1 system-ui, sans-serif;
    cursor: pointer;
    pointer-events: auto;
    backdrop-filter: blur(5px);
  }
  .language-toggle:hover, .language-toggle:focus-visible {
    border-color: rgba(156,251,209,.9);
    outline: none;
  }
  .language-panel {
    position: absolute;
    top: 44px;
    left: 10px;
    z-index: 6;
    display: grid;
    width: 250px;
    gap: 8px;
    padding: 11px;
    border: 1px solid rgba(255,255,255,.22);
    border-radius: 9px;
    background: rgba(18,20,23,.97);
    box-shadow: 0 12px 30px rgba(0,0,0,.55);
    color: #fff;
    font: 12px/1.25 system-ui, sans-serif;
    pointer-events: auto;
  }
  .language-panel[hidden] { display: none; }
  .language-panel label { display: grid; grid-template-columns: 82px 1fr; gap: 8px; align-items: center; }
  .language-panel select {
    min-width: 0;
    padding: 6px;
    border: 1px solid #56606a;
    border-radius: 5px;
    background: #11161b;
    color: #fff;
    font: 12px system-ui, sans-serif;
  }
  .language-apply {
    padding: 7px;
    border: 0;
    border-radius: 5px;
    background: #9cfbd1;
    color: #092217;
    font: 750 12px system-ui, sans-serif;
    cursor: pointer;
  }
  .language-hint { color: #aab3ba; font-size: 10px; line-height: 1.35; }
  .caption-panel {
    display: inline-flex;
    max-width: 100%;
    flex-direction: column;
    align-items: center;
    gap: .5em;
    pointer-events: none;
  }
  .caption-line {
    width: fit-content;
    max-width: 100%;
    padding: .18em .5em .24em;
    border-radius: .28em;
    background: rgba(15, 15, 15, .92);
    box-shadow: 0 2px 10px rgba(0,0,0,.48);
    text-shadow: 0 1px 2px rgba(0,0,0,.72);
  }
  .caption-line:empty { display: none; }
  .german {
    color: #9cfbd1;
    font-size: var(--polyglot-maxxing-source-font-size, 28px);
    font-weight: 700;
    line-height: 1.25;
    pointer-events: auto;
  }
  .english { color: #fff; font-size: calc(var(--polyglot-maxxing-source-font-size, 28px) * .8); font-weight: 450; line-height: 1.25; }
  .word {
    appearance: none;
    margin: 0;
    padding: 0 .04em;
    border: 1px solid transparent;
    border-radius: .08em;
    color: #b894c5;
    background: transparent;
    font: inherit;
    line-height: inherit;
    cursor: pointer;
    transition: color .12s ease, background-color .12s ease, border-color .12s ease;
  }
  .word:hover, .word:focus-visible {
    border-color: rgba(255,255,255,.38);
    background: rgba(255,255,255,.16);
    outline: none;
  }
  .word.selected { border-color: #71e8bd; background: rgba(113,232,189,.14); }
  .word.stage-learning { color: #ffbd80; }
  .word.stage-known { color: #9cffcd; }
  .word.stage-ignored { color: #999; opacity: .72; }
  .hover-card {
    position: absolute;
    bottom: calc(100% + 9px);
    z-index: 2;
    min-width: 150px;
    max-width: 260px;
    transform: translateX(-50%);
    padding: 8px 10px;
    border: 1px solid rgba(255,255,255,.16);
    border-radius: 7px;
    background: rgba(13,17,19,.97);
    box-shadow: 0 8px 24px rgba(0,0,0,.48);
    color: #f4f7f5;
    text-align: left;
    pointer-events: none;
  }
  .hover-card[hidden], .word-card[hidden] { display: none; }
  .hover-word { color: #b9f9d9; font-size: 13px; font-weight: 750; }
  .hover-meaning { margin-top: 2px; color: #d7ddd9; font-size: 12px; line-height: 1.3; }
  .hover-stage { margin-top: 5px; color: #aeb8b3; font-size: 10px; line-height: 1.25; }
  .hover-stage.learning { color: #ffbd80; }
  .hover-stage.known { color: #9cffcd; }
  .word-card {
    position: absolute;
    bottom: calc(100% + 12px);
    z-index: 3;
    width: min(410px, calc(100vw - 32px));
    max-height: min(540px, calc(100vh - 190px));
    transform: translateX(-50%);
    overflow: hidden;
    border: 1px solid rgba(255,255,255,.18);
    border-radius: 9px;
    background: #242424;
    box-shadow: 0 18px 52px rgba(0,0,0,.66);
    color: #e9e9e9;
    text-align: left;
    pointer-events: auto;
  }
  .card-header {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 10px;
    align-items: center;
    padding: 10px 12px;
    background: #086b9c;
  }
  .card-word { color: #d1e967; font-size: 15px; font-weight: 800; }
  .card-primary-meaning { margin-top: 2px; color: #fff; font-size: 13px; }
  .close {
    appearance: none;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: #eaf7ff;
    font: 700 20px/1 system-ui, sans-serif;
    cursor: pointer;
  }
  .close:hover, .close:focus-visible { background: rgba(255,255,255,.16); outline: none; }
  .tabs {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    border-bottom: 1px solid #484848;
    background: #292929;
  }
  .tab {
    appearance: none;
    padding: 9px 5px 8px;
    border: 0;
    border-bottom: 2px solid transparent;
    background: transparent;
    color: #aaa;
    font: 600 12px/1 system-ui, sans-serif;
    cursor: pointer;
  }
  .tab:hover, .tab:focus-visible { color: #fff; outline: none; }
  .tab.active { border-bottom-color: #b9d95c; color: #fff; }
  .card-scroll { max-height: min(430px, calc(100vh - 285px)); overflow-y: auto; }
  .insight {
    min-height: 76px;
    padding: 12px 14px;
    color: #eee;
    font-size: 13px;
    line-height: 1.48;
    white-space: pre-wrap;
  }
  .insight.loading { color: #b8c6d4; }
  .insight.error { color: #ffc1c1; }
  .dictionary { padding: 10px 14px 12px; border-top: 1px solid #444; background: #383838; }
  .dictionary-lemma { color: #cadd45; font-size: 13px; font-weight: 700; }
  .dictionary-meta { margin-top: 3px; color: #a8a8a8; font-size: 11px; }
  .dictionary-meanings { margin-top: 6px; color: #d5d5d5; font-size: 12px; line-height: 1.45; }
  .card-actions { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid #444; }
  .save {
    flex: 1;
    padding: 8px 11px;
    border: 1px solid #c8e75a;
    border-radius: 6px;
    background: #afcb48;
    color: #171b08;
    font: 750 12px/1 system-ui, sans-serif;
    cursor: pointer;
  }
  .save:disabled { cursor: default; opacity: .72; }
`;

const PLAYER_SELECTORS: Record<SupportedSite, string> = {
  ard: ".ardplayer",
  zdf: ".zdfplayer-app",
  youtube: ".html5-video-player",
  netflix: ".watch-video--player-view",
};

const NATIVE_CAPTION_CSS: Partial<Record<SupportedSite, string>> = {
  youtube: ".ytp-caption-window-container { opacity: 0 !important; }",
  netflix: ".player-timedtext { opacity: 0 !important; }",
};

export function findPlayerContainer(
  video: HTMLVideoElement,
  site: SupportedSite,
): HTMLElement {
  const sitePlayer = video.closest(PLAYER_SELECTORS[site]);
  if (sitePlayer instanceof HTMLElement) return sitePlayer;
  return video.parentElement ?? document.documentElement;
}

export function findFullscreenContainer(
  fullscreenElement: HTMLElement | null,
  video: HTMLVideoElement,
): HTMLElement | undefined {
  return fullscreenElement &&
    fullscreenElement !== video &&
    fullscreenElement.contains(video)
    ? fullscreenElement
    : undefined;
}

function fallbackTokens(text: string, language: string): TokenAnalysis[] {
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

function localInsight(kind: WordInsightKind, token: TokenAnalysis, language: string): string {
  const word = token.surface;
  const meaning = token.meanings[0];
  if (kind === "examples") {
    return "Connect ChatGPT in Polyglot Maxxing settings to generate contextual examples and translations.";
  }
  if (kind === "grammar") {
    const features = Object.entries(token.morphology)
      .map(([key, value]) => `${key}: ${value}`)
      .join(" · ");
    return [
      `“${word}” is tagged as ${token.pos || `a ${languageName(language)} word`}.`,
      features || "No additional morphology was identified for this form.",
    ].join("\n");
  }
  return meaning
    ? `“${word}” means “${meaning}” here. It is used as ${token.pos || `a ${languageName(language)} word`} in this sentence.`
    : `“${word}” is used as ${token.pos || `a ${languageName(language)} word`} in this sentence. Connect ChatGPT for a contextual explanation.`;
}

function appendInlineTutorMarkdown(parent: HTMLElement, text: string): void {
  const pattern = /(\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_)/g;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index;
    if (index > offset) parent.append(document.createTextNode(text.slice(offset, index)));
    const source = match[0];
    const strong = source.startsWith("**") || source.startsWith("__");
    const element = document.createElement(strong ? "strong" : "em");
    const markerLength = strong ? 2 : 1;
    element.textContent = source.slice(markerLength, -markerLength);
    parent.append(element);
    offset = index + source.length;
  }
  if (offset < text.length) parent.append(document.createTextNode(text.slice(offset)));
}

export function renderTutorMarkdown(target: HTMLElement, markdown: string): void {
  target.replaceChildren();
  const lines = markdown.split("\n");
  lines.forEach((line, index) => {
    appendInlineTutorMarkdown(target, line);
    if (index < lines.length - 1) target.append(document.createElement("br"));
  });
}

export class SubtitleOverlay {
  readonly host: HTMLDivElement;
  private readonly root: HTMLDivElement;
  private readonly german: HTMLDivElement;
  private readonly english: HTMLDivElement;
  private readonly hoverCard: HTMLDivElement;
  private readonly wordCard: HTMLDivElement;
  private readonly insight: HTMLDivElement;
  private readonly tabs = new Map<WordInsightKind, HTMLButtonElement>();
  private readonly dictionary: HTMLDivElement;
  private readonly dictionaryLemma: HTMLDivElement;
  private readonly dictionaryMeta: HTMLDivElement;
  private readonly dictionaryMeanings: HTMLDivElement;
  private readonly saveButton: HTMLButtonElement;
  private readonly toggleButton: HTMLButtonElement;
  private readonly languageButton: HTMLButtonElement;
  private readonly languagePanel: HTMLDivElement;
  private readonly nativeCaptionStyle?: HTMLStyleElement;
  private currentCue?: ProcessedCue | SubtitleCue;
  private selectedToken?: TokenAnalysis;
  private selectedButton?: HTMLButtonElement;
  private activeInsight: WordInsightKind = "explain";
  private preferences: SubtitlePreferences;
  private enabled = true;
  private insightSequence = 0;
  private insightAbortController?: AbortController;
  private insightRequestKey?: string;
  private partialInsightKey?: string;
  private partialInsights: PartialWordInsights = {};
  private readonly insightCache = new Map<string, WordInsights>();
  private readonly wordStages = new Map<string, LearningStage>();
  private readonly positionedContainers = new Map<HTMLElement, string>();
  private readonly fullscreenHandler = () => this.ensureMounted();
  private readonly documentPointerHandler = (event: PointerEvent) => {
    if (!event.composedPath().includes(this.host)) this.closeWord();
  };
  private readonly keyHandler = (event: KeyboardEvent) => {
    if (event.key === "Escape") this.closeWord();
  };

  constructor(
    private readonly episodeId: string,
    private readonly pageUrl: string,
    private readonly video: HTMLVideoElement,
    private readonly site: SupportedSite,
    private readonly sourceLanguage: string,
    private readonly targetLanguage: string,
    availableLanguages: string[],
    private readonly onSave: SaveHandler,
    private readonly onInsight: InsightHandler,
    preferences: SubtitlePreferences,
    savedWords: SavedWord[] = [],
    private readonly onToggle: ToggleHandler = () => undefined,
    private readonly onLanguages: LanguageHandler = () => undefined,
  ) {
    this.preferences = preferences;
    for (const word of savedWords.filter((word) =>
      normalizeLanguageCode(word.sourceLanguage, "de") === normalizeLanguageCode(sourceLanguage))) {
      this.wordStages.set(this.wordKey(word.lemma, word.pos), word.learningStage);
    }
    this.host = document.createElement("div");
    this.host.dataset.polyglotMaxxing = "overlay";
    const shadow = this.host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STYLE;
    shadow.append(style);

    this.root = document.createElement("div");
    this.root.className = "root";
    const captionPanel = document.createElement("div");
    captionPanel.className = "caption-panel";
    this.german = document.createElement("div");
    this.german.className = "caption-line german";
    this.english = document.createElement("div");
    this.english.className = "caption-line english";
    captionPanel.append(this.german, this.english);

    this.hoverCard = document.createElement("div");
    this.hoverCard.className = "hover-card";
    this.hoverCard.hidden = true;

    this.wordCard = document.createElement("div");
    this.wordCard.className = "word-card";
    this.wordCard.hidden = true;
    const header = document.createElement("div");
    header.className = "card-header";
    const heading = document.createElement("div");
    const cardWord = document.createElement("div");
    cardWord.className = "card-word";
    cardWord.dataset.role = "word";
    const primaryMeaning = document.createElement("div");
    primaryMeaning.className = "card-primary-meaning";
    primaryMeaning.dataset.role = "primary-meaning";
    heading.append(cardWord, primaryMeaning);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "close";
    close.ariaLabel = "Close word details";
    close.textContent = "×";
    close.addEventListener("click", () => this.closeWord());
    header.append(heading, close);

    const tabBar = document.createElement("div");
    tabBar.className = "tabs";
    for (const kind of ["explain", "examples", "grammar"] as const) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "tab";
      tab.textContent = kind[0]!.toUpperCase() + kind.slice(1);
      tab.addEventListener("click", () => void this.selectInsight(kind));
      this.tabs.set(kind, tab);
      tabBar.append(tab);
    }

    const scroll = document.createElement("div");
    scroll.className = "card-scroll";
    this.insight = document.createElement("div");
    this.insight.className = "insight";
    this.dictionary = document.createElement("div");
    this.dictionary.className = "dictionary";
    this.dictionaryLemma = document.createElement("div");
    this.dictionaryLemma.className = "dictionary-lemma";
    this.dictionaryMeta = document.createElement("div");
    this.dictionaryMeta.className = "dictionary-meta";
    this.dictionaryMeanings = document.createElement("div");
    this.dictionaryMeanings.className = "dictionary-meanings";
    this.dictionary.append(this.dictionaryLemma, this.dictionaryMeta, this.dictionaryMeanings);
    scroll.append(this.insight, this.dictionary);

    const actions = document.createElement("div");
    actions.className = "card-actions";
    this.saveButton = document.createElement("button");
    this.saveButton.type = "button";
    this.saveButton.className = "save";
    this.saveButton.textContent = "Save word";
    this.saveButton.addEventListener("click", () => void this.saveSelectedWord());
    actions.append(this.saveButton);
    this.wordCard.append(header, tabBar, scroll, actions);

    this.root.append(this.hoverCard, this.wordCard, captionPanel);
    this.toggleButton = document.createElement("button");
    this.toggleButton.type = "button";
    this.toggleButton.className = "site-toggle";
    const toggleMark = document.createElement("span");
    toggleMark.className = "site-toggle-mark";
    toggleMark.textContent = "PM";
    const toggleLabel = document.createElement("span");
    toggleLabel.dataset.role = "toggle-label";
    this.toggleButton.append(toggleMark, toggleLabel);
    this.toggleButton.addEventListener("click", () => {
      const previous = this.enabled;
      const next = !previous;
      this.setEnabled(next);
      void Promise.resolve(this.onToggle(next)).catch(() => this.setEnabled(previous));
    });

    this.languageButton = document.createElement("button");
    this.languageButton.type = "button";
    this.languageButton.className = "language-toggle";
    this.languageButton.textContent = `${languageLabel(sourceLanguage)} → ${languageLabel(targetLanguage)}`;
    this.languageButton.title = "Change this video's languages";
    this.languageButton.addEventListener("click", () => {
      this.languagePanel.hidden = !this.languagePanel.hidden;
    });
    this.languagePanel = document.createElement("div");
    this.languagePanel.className = "language-panel";
    this.languagePanel.hidden = true;
    const sourceSelect = this.languageSelect(
      sourceLanguage,
      Array.from(new Set([sourceLanguage, ...availableLanguages, ...LANGUAGE_OPTIONS.map((item) => item.code)])),
    );
    const targetSelect = this.languageSelect(
      targetLanguage,
      LANGUAGE_OPTIONS.map((item) => item.code),
    );
    const sourceLabel = document.createElement("label");
    sourceLabel.append(document.createTextNode("Learning"), sourceSelect);
    const targetLabel = document.createElement("label");
    targetLabel.append(document.createTextNode("Translate to"), targetSelect);
    const hint = document.createElement("div");
    hint.className = "language-hint";
    hint.textContent = availableLanguages.length
      ? `Available here: ${availableLanguages.map(languageName).join(", ")}`
      : "The available tracks will appear after the player exposes them.";
    const apply = document.createElement("button");
    apply.type = "button";
    apply.className = "language-apply";
    apply.textContent = "Use for this video";
    apply.addEventListener("click", () => {
      this.languagePanel.hidden = true;
      if (sourceSelect.value === sourceLanguage && targetSelect.value === targetLanguage) return;
      apply.disabled = true;
      apply.textContent = "Switching…";
      void Promise.resolve(this.onLanguages(sourceSelect.value, targetSelect.value)).catch(() => {
        apply.disabled = false;
        apply.textContent = "Try again";
      });
    });
    this.languagePanel.append(sourceLabel, targetLabel, hint, apply);
    shadow.append(this.root, this.toggleButton, this.languageButton, this.languagePanel);

    const nativeCss = NATIVE_CAPTION_CSS[site];
    if (nativeCss) {
      this.nativeCaptionStyle = document.createElement("style");
      this.nativeCaptionStyle.dataset.polyglotMaxxingNativeCaptions = site;
      this.nativeCaptionStyle.textContent = nativeCss;
      document.documentElement.append(this.nativeCaptionStyle);
    }

    document.addEventListener("fullscreenchange", this.fullscreenHandler);
    document.addEventListener("webkitfullscreenchange", this.fullscreenHandler);
    document.addEventListener("pointerdown", this.documentPointerHandler, true);
    document.addEventListener("keydown", this.keyHandler, true);
    this.setPreferences(preferences);
    this.ensureMounted();
  }

  setPreferences(preferences: SubtitlePreferences): void {
    this.preferences = preferences;
    if (!preferences.codexEnabled) {
      this.insightAbortController?.abort();
      this.insightAbortController = undefined;
      this.insightRequestKey = undefined;
    }
    const normalized = Math.min(52, Math.max(18, preferences.fontSize));
    this.host.style.setProperty("--polyglot-maxxing-source-font-size", `${normalized}px`);
    this.setEnabled(preferences.enabledBySite[this.site]);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.host.dataset.enabled = String(enabled);
    this.root.hidden = !enabled;
    this.nativeCaptionStyle && (this.nativeCaptionStyle.disabled = !enabled);
    this.toggleButton.classList.toggle("off", !enabled);
    this.toggleButton.ariaPressed = String(enabled);
    this.toggleButton.ariaLabel = enabled
      ? `Turn Polyglot Maxxing off on ${this.site}`
      : `Turn Polyglot Maxxing on for ${this.site}`;
    this.toggleButton.title = this.toggleButton.ariaLabel;
    this.toggleButton.querySelector<HTMLElement>("[data-role='toggle-label']")!.textContent = enabled
      ? "ON"
      : "OFF";
    if (!enabled) this.closeWord();
  }

  setCue(cue?: SubtitleCue | ProcessedCue): void {
    this.ensureMounted();
    if (!cue) {
      this.currentCue = undefined;
      this.german.replaceChildren();
      this.english.textContent = "";
      this.closeWord();
      return;
    }
    if (this.currentCue === cue) return;
    const cueChanged = this.currentCue?.id !== cue.id;
    this.currentCue = cue;
    this.renderGerman(
      cue.text,
      this.isProcessed(cue) ? cue.tokens : fallbackTokens(cue.text, this.sourceLanguage),
    );
    this.english.textContent = this.isProcessed(cue) ? cue.translation : "Translating…";
    if (cueChanged) this.closeWord();
  }

  setNotice(message: string): void {
    this.ensureMounted();
    this.currentCue = undefined;
    this.german.textContent = message;
    this.english.textContent = "Use the language control above to choose an available caption track.";
    this.closeWord();
  }

  destroy(): void {
    this.insightAbortController?.abort();
    document.removeEventListener("fullscreenchange", this.fullscreenHandler);
    document.removeEventListener("webkitfullscreenchange", this.fullscreenHandler);
    document.removeEventListener("pointerdown", this.documentPointerHandler, true);
    document.removeEventListener("keydown", this.keyHandler, true);
    this.nativeCaptionStyle?.remove();
    this.host.remove();
    for (const [container, inlinePosition] of this.positionedContainers) {
      if (container.style.position === "relative") container.style.position = inlinePosition;
    }
    this.positionedContainers.clear();
  }

  ensureMounted(): void {
    const fullscreenElement = document.fullscreenElement;
    const fullscreenContainer = fullscreenElement instanceof HTMLElement
      ? findFullscreenContainer(fullscreenElement, this.video)
      : undefined;
    const container = fullscreenContainer ?? findPlayerContainer(this.video, this.site);

    for (const [positionedContainer, inlinePosition] of this.positionedContainers) {
      if (positionedContainer === container) continue;
      if (positionedContainer.style.position === "relative") {
        positionedContainer.style.position = inlinePosition;
      }
      this.positionedContainers.delete(positionedContainer);
    }
    if (getComputedStyle(container).position === "static") {
      if (!this.positionedContainers.has(container)) {
        this.positionedContainers.set(container, container.style.position);
      }
      container.style.position = "relative";
    }
    if (this.host.parentElement !== container) container.append(this.host);
  }

  private isProcessed(cue: SubtitleCue | ProcessedCue): cue is ProcessedCue {
    return "translation" in cue;
  }

  private renderGerman(text: string, tokens: TokenAnalysis[]): void {
    const fragment = document.createDocumentFragment();
    let offset = 0;
    for (const token of tokens) {
      if (token.start > offset) fragment.append(document.createTextNode(text.slice(offset, token.start)));
      const button = document.createElement("button");
      button.className = "word";
      button.type = "button";
      button.textContent = text.slice(token.start, token.end) || token.surface;
      button.addEventListener("mouseenter", () => this.showHover(token, button));
      button.addEventListener("mouseleave", () => { this.hoverCard.hidden = true; });
      button.addEventListener("focus", () => this.showHover(token, button));
      button.addEventListener("blur", () => { this.hoverCard.hidden = true; });
      button.addEventListener("click", () => this.openWord(token, button));
      button.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        void this.toggleWordStage(token, button);
      });
      this.applyWordStage(button, token);
      fragment.append(button);
      offset = token.end;
    }
    if (offset < text.length) fragment.append(document.createTextNode(text.slice(offset)));
    this.german.replaceChildren(fragment);
  }

  private showHover(token: TokenAnalysis, button: HTMLButtonElement): void {
    if (button === this.selectedButton) return;
    const word = document.createElement("div");
    word.className = "hover-word";
    word.textContent = token.lemma || token.surface;
    const meaning = document.createElement("div");
    meaning.className = "hover-meaning";
    meaning.textContent = token.meanings.slice(0, 3).join(", ") || token.pos ||
      `${languageName(this.sourceLanguage)} word`;
    const stage = document.createElement("div");
    const currentStage = this.wordStages.get(this.wordKey(token.lemma, token.pos));
    stage.className = `hover-stage${currentStage ? ` ${currentStage}` : ""}`;
    stage.textContent = currentStage
      ? `${this.stageLabel(currentStage)} · Right-click to toggle`
      : "Right-click to mark for learning";
    this.hoverCard.replaceChildren(word, meaning, stage);
    this.hoverCard.hidden = false;
    this.positionFloating(this.hoverCard, button);
  }

  private openWord(token: TokenAnalysis, button: HTMLButtonElement): void {
    this.selectedButton?.classList.remove("selected");
    this.selectedButton = button;
    button.classList.add("selected");
    this.selectedToken = token;
    this.hoverCard.hidden = true;
    if (this.preferences.pauseOnWordClick && !this.video.paused) this.video.pause();

    const cardWord = this.wordCard.querySelector<HTMLElement>("[data-role='word']")!;
    const primaryMeaning = this.wordCard.querySelector<HTMLElement>("[data-role='primary-meaning']")!;
    const localToken = this.localAnalysisToken(token);
    cardWord.textContent = localToken.lemma || localToken.surface;
    primaryMeaning.textContent = localToken.meanings.slice(0, 3).join(", ") || localToken.pos ||
      `${languageName(this.sourceLanguage)} word`;
    this.dictionary.hidden = !this.usesGermanLocalAnalysis();
    this.dictionaryLemma.textContent = localToken.lemma || localToken.surface;
    const morphology = Object.entries(localToken.morphology)
      .map(([key, value]) => `${key}: ${value}`)
      .join(" · ");
    this.dictionaryMeta.textContent = [localToken.pos, morphology].filter(Boolean).join(" · ") ||
      `${languageName(this.sourceLanguage)} word`;
    this.dictionaryMeanings.textContent = localToken.meanings.length
      ? localToken.meanings.join(" · ")
      : "No local dictionary meaning is installed for this lemma yet.";
    this.updateSaveButton(token);
    this.wordCard.hidden = false;
    this.positionFloating(this.wordCard, button);
    void this.selectInsight("explain");
  }

  private closeWord(): void {
    this.insightAbortController?.abort();
    this.insightAbortController = undefined;
    this.insightRequestKey = undefined;
    this.partialInsightKey = undefined;
    this.partialInsights = {};
    this.insightSequence += 1;
    this.selectedButton?.classList.remove("selected");
    this.selectedButton = undefined;
    this.selectedToken = undefined;
    this.hoverCard.hidden = true;
    this.wordCard.hidden = true;
  }

  private positionFloating(element: HTMLElement, button: HTMLElement): void {
    const rootRect = this.root.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    const width = element.getBoundingClientRect().width || 220;
    const desired = buttonRect.left + buttonRect.width / 2 - rootRect.left;
    const half = width / 2;
    const clamped = Math.max(half + 8, Math.min(rootRect.width - half - 8, desired));
    element.style.left = `${clamped}px`;
  }

  private async selectInsight(kind: WordInsightKind): Promise<void> {
    const token = this.selectedToken;
    const cue = this.currentCue;
    if (!token || !cue) return;
    const localToken = this.localAnalysisToken(token);
    this.activeInsight = kind;
    for (const [candidate, tab] of this.tabs) tab.classList.toggle("active", candidate === kind);
    this.insight.className = "insight";
    renderTutorMarkdown(this.insight, localInsight(kind, token, this.sourceLanguage));
    if (!this.preferences.codexEnabled) return;

    const cacheKey = [
      token.surface,
      localToken.lemma,
      cue.text,
      this.sourceLanguage,
      this.targetLanguage,
      this.preferences.codexModel,
      this.preferences.codexEffort,
    ].join("\0");
    const cached = this.insightCache.get(cacheKey);
    if (cached) {
      renderTutorMarkdown(this.insight, cached[kind]);
      return;
    }
    if (this.insightRequestKey === cacheKey && this.insightAbortController) {
      const partial = this.partialInsightKey === cacheKey
        ? this.partialInsights[kind]
        : undefined;
      if (partial) {
        this.insight.className = "insight";
        renderTutorMarkdown(this.insight, partial);
      } else {
        this.insight.className = "insight loading";
        this.insight.textContent = "Asking ChatGPT…";
      }
      return;
    }

    this.insightAbortController?.abort();
    const sequence = ++this.insightSequence;
    const controller = new AbortController();
    this.insightAbortController = controller;
    this.insightRequestKey = cacheKey;
    this.partialInsightKey = cacheKey;
    this.partialInsights = {};
    this.insight.className = "insight loading";
    this.insight.textContent = "Asking ChatGPT…";
    try {
      const response = await this.onInsight(
        {
          word: token.surface,
          lemma: localToken.lemma,
          context: cue.text,
          contextTranslation: this.isProcessed(cue) ? cue.translation : "",
          pos: localToken.pos,
          morphology: localToken.morphology,
          meanings: localToken.meanings,
          sourceLanguage: this.sourceLanguage,
          targetLanguage: this.targetLanguage,
          model: this.preferences.codexModel,
          effort: this.preferences.codexEffort,
        },
        controller.signal,
        (partial) => {
          if (sequence !== this.insightSequence || controller.signal.aborted) return;
          this.partialInsightKey = cacheKey;
          this.partialInsights = partial;
          const visible = partial[this.activeInsight];
          if (!visible) return;
          this.insight.className = "insight";
          renderTutorMarkdown(this.insight, visible);
        },
      );
      this.insightCache.set(cacheKey, response.insights);
      if (sequence !== this.insightSequence) return;
      this.insight.className = "insight";
      renderTutorMarkdown(this.insight, response.insights[this.activeInsight]);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (sequence !== this.insightSequence) return;
      this.insight.className = "insight error";
      this.insight.textContent = error instanceof Error
        ? error.message
        : "ChatGPT enrichment is unavailable.";
    } finally {
      if (this.insightAbortController === controller) {
        this.insightAbortController = undefined;
        this.insightRequestKey = undefined;
        this.partialInsightKey = undefined;
        this.partialInsights = {};
      }
    }
  }

  private async saveSelectedWord(): Promise<void> {
    if (!this.currentCue || !this.selectedToken) return;
    this.saveButton.disabled = true;
    this.saveButton.textContent = "Saving…";
    try {
      const saved = await this.onSave(this.wordPayload(this.selectedToken));
      const stage = saved?.learningStage ?? "learning";
      this.setWordStage(this.selectedToken, stage);
      this.updateSaveButton(this.selectedToken);
    } catch {
      this.saveButton.disabled = false;
      this.saveButton.textContent = "Try again";
    }
  }

  private async toggleWordStage(
    token: TokenAnalysis,
    button: HTMLButtonElement,
  ): Promise<void> {
    if (!this.currentCue || button.disabled) return;
    button.disabled = true;
    const previous = this.wordStages.get(this.wordKey(token.lemma, token.pos));
    const optimistic: LearningStage = previous === "learning" ? "known" : "learning";
    this.setWordStage(token, optimistic);
    this.showHover(token, button);
    try {
      const saved = await this.onSave(this.wordPayload(token), "toggle");
      this.setWordStage(token, saved?.learningStage ?? optimistic);
      if (this.selectedToken && this.wordKey(this.selectedToken.lemma, this.selectedToken.pos) === this.wordKey(token.lemma, token.pos)) {
        this.updateSaveButton(this.selectedToken);
      }
      this.showHover(token, button);
    } catch {
      if (previous) this.setWordStage(token, previous);
      else this.clearWordStage(token);
      const word = document.createElement("div");
      word.className = "hover-word";
      word.textContent = token.lemma || token.surface;
      const error = document.createElement("div");
      error.className = "hover-meaning";
      error.textContent = "Could not update. Is the companion server running?";
      this.hoverCard.replaceChildren(word, error);
      this.hoverCard.hidden = false;
      this.positionFloating(this.hoverCard, button);
    } finally {
      button.disabled = false;
    }
  }

  private wordPayload(token: TokenAnalysis): SavedWordInput {
    const cue = this.currentCue!;
    const localToken = this.localAnalysisToken(token);
    return {
      surface: token.surface,
      lemma: localToken.lemma,
      pos: localToken.pos,
      meaning: localToken.meanings[0],
      meanings: localToken.meanings,
      morphology: localToken.morphology,
      germanSentence: cue.text,
      englishSentence: this.isProcessed(cue) ? cue.translation : "",
      sourceLanguage: this.sourceLanguage,
      targetLanguage: this.targetLanguage,
      videoUrl: this.pageUrl,
      episodeId: this.episodeId,
      cueId: cue.id,
      cueStart: cue.start,
    };
  }

  private usesGermanLocalAnalysis(): boolean {
    return normalizeLanguageCode(this.sourceLanguage) === "de";
  }

  private localAnalysisToken(token: TokenAnalysis): TokenAnalysis {
    if (this.usesGermanLocalAnalysis()) return token;
    return {
      ...token,
      lemma: token.surface,
      pos: "",
      morphology: {},
      meanings: [],
    };
  }

  private wordKey(lemma: string, pos: string): string {
    return `${this.sourceLanguage}\u0000${lemma.trim().toLocaleLowerCase(this.sourceLanguage)}\u0000${pos.trim().toLocaleLowerCase(this.sourceLanguage)}`;
  }

  private languageSelect(value: string, codes: string[]): HTMLSelectElement {
    const select = document.createElement("select");
    for (const code of Array.from(new Set(codes.map((item) => normalizeLanguageCode(item)).filter(Boolean)))) {
      const option = document.createElement("option");
      option.value = code;
      option.textContent = languageName(code);
      select.append(option);
    }
    select.value = normalizeLanguageCode(value);
    return select;
  }

  private setWordStage(token: Pick<TokenAnalysis, "lemma" | "pos">, stage: LearningStage): void {
    const key = this.wordKey(token.lemma, token.pos);
    this.wordStages.set(key, stage);
    this.updateRenderedWordStages(key, stage);
  }

  private clearWordStage(token: Pick<TokenAnalysis, "lemma" | "pos">): void {
    const key = this.wordKey(token.lemma, token.pos);
    this.wordStages.delete(key);
    this.updateRenderedWordStages(key);
  }

  private updateRenderedWordStages(key: string, stage?: LearningStage): void {
    for (const button of this.german.querySelectorAll<HTMLButtonElement>(".word")) {
      if (button.dataset.wordKey !== key) continue;
      button.classList.remove("stage-learning", "stage-known", "stage-ignored");
      if (stage) button.classList.add(`stage-${stage}`);
      button.title = stage
        ? `${this.stageLabel(stage)}. Right-click to toggle known / learning.`
        : "Right-click to mark for learning.";
    }
  }

  private applyWordStage(button: HTMLButtonElement, token: TokenAnalysis): void {
    const key = this.wordKey(token.lemma, token.pos);
    const stage = this.wordStages.get(key);
    button.dataset.wordKey = key;
    button.classList.remove("stage-learning", "stage-known", "stage-ignored");
    if (stage) button.classList.add(`stage-${stage}`);
    button.title = stage
      ? `${this.stageLabel(stage)}. Right-click to toggle known / learning.`
      : "Right-click to mark for learning.";
  }

  private updateSaveButton(token: Pick<TokenAnalysis, "lemma" | "pos">): void {
    const stage = this.wordStages.get(this.wordKey(token.lemma, token.pos));
    this.saveButton.disabled = Boolean(stage);
    this.saveButton.textContent = stage ? this.stageLabel(stage) : "Save word";
  }

  private stageLabel(stage: LearningStage): string {
    if (stage === "known") return "Marked as known";
    if (stage === "ignored") return "Don't learn";
    return "Marked to learn";
  }
}
