import type {
  BackgroundResponse,
  LearningStage,
  PartialWordInsights,
  SavedWord,
  WordInsights,
} from "../../src/domain/types";
import {
  DEFAULT_SUBTITLE_PREFERENCES,
  loadSubtitlePreferences,
  type SubtitlePreferences,
} from "../../src/lib/preferences";
import { savedTimestampUrl } from "../../src/lib/saved-timestamp";
import { streamWordInsight } from "../../src/lib/word-insight-stream";
import { renderTutorMarkdown } from "../../src/ui/overlay";
import { languageLabel, languageName, normalizeLanguageCode } from "../../src/lib/languages";

type SourceName = "ARD" | "ZDF" | "YouTube" | "Netflix" | "Other";
type SortMode = "newest" | "frequency" | "alphabetical";

const PAGE_SIZE = 50;
const message = document.querySelector<HTMLDivElement>("#message")!;
const container = document.querySelector<HTMLElement>("#words")!;
const search = document.querySelector<HTMLInputElement>("#search")!;
const source = document.querySelector<HTMLSelectElement>("#source")!;
const sort = document.querySelector<HTMLSelectElement>("#sort")!;
const total = document.querySelector<HTMLElement>("#total")!;
const bulk = document.querySelector<HTMLElement>("#bulk")!;
const selectedCount = document.querySelector<HTMLElement>("#selected-count")!;
const selectAll = document.querySelector<HTMLInputElement>("#select-all")!;
const previous = document.querySelector<HTMLButtonElement>("#previous")!;
const next = document.querySelector<HTMLButtonElement>("#next")!;
const pageLabel = document.querySelector<HTMLElement>("#page")!;
const tutor = document.querySelector<HTMLElement>("#tutor")!;
const tutorBackdrop = document.querySelector<HTMLButtonElement>("#tutor-backdrop")!;
const tutorWord = document.querySelector<HTMLElement>("#tutor-word")!;
const tutorMeaning = document.querySelector<HTMLElement>("#tutor-meaning")!;
const tutorGerman = document.querySelector<HTMLElement>("#tutor-german")!;
const tutorEnglish = document.querySelector<HTMLElement>("#tutor-english")!;
const tutorAnswers = document.querySelector<HTMLElement>("#tutor-answers")!;
const tutorExplain = document.querySelector<HTMLElement>("#tutor-explain")!;
const tutorExamples = document.querySelector<HTMLElement>("#tutor-examples")!;
const tutorGrammar = document.querySelector<HTMLElement>("#tutor-grammar")!;
const tutorModel = document.querySelector<HTMLElement>("#tutor-model")!;
const tutorSource = document.querySelector<HTMLAnchorElement>("#tutor-source")!;

let words: SavedWord[] = [];
let activeStage: LearningStage | "all" = "all";
let currentPage = 1;
let busy = false;
let preferences: SubtitlePreferences = DEFAULT_SUBTITLE_PREFERENCES;
let activeTutorWord: SavedWord | undefined;
let insightSequence = 0;
let insightController: AbortController | undefined;
let insightRequestKey: string | undefined;
const selected = new Set<number>();
const pendingStageUpdates = new Set<number>();
const insightCache = new Map<string, WordInsights>();

async function companionRequest<T>(
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE" = "GET",
  body?: unknown,
): Promise<T> {
  const response = (await browser.runtime.sendMessage({
    type: "COMPANION_REQUEST",
    path,
    method,
    body,
  })) as BackgroundResponse<T>;
  if (!response.ok) throw new Error(response.error || `Request failed (${response.status})`);
  return response.data as T;
}

function sourceName(url: string): SourceName {
  try {
    const hostname = new URL(url).hostname.toLocaleLowerCase("en");
    if (hostname.includes("ardmediathek.de")) return "ARD";
    if (hostname.includes("zdf.de")) return "ZDF";
    if (hostname.includes("youtube.com") || hostname.includes("youtu.be")) return "YouTube";
    if (hostname.includes("netflix.com")) return "Netflix";
  } catch {
    // A malformed legacy URL remains accessible under Other.
  }
  return "Other";
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Saved words";
  return new Intl.DateTimeFormat("en", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function dateKey(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString().slice(0, 10);
}

function appendHighlightedText(
  target: HTMLElement,
  sentence: string,
  surface: string,
  lemma: string,
  language = "de",
  stage: LearningStage = "learning",
): void {
  const locale = normalizeLanguageCode(language, "de");
  const lowerSentence = sentence.toLocaleLowerCase(locale);
  const candidates = [surface, lemma]
    .map((value) => value.trim())
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  const candidate = candidates.find((value) => lowerSentence.includes(value.toLocaleLowerCase(locale)));
  if (!candidate) {
    target.textContent = sentence;
    return;
  }
  const index = lowerSentence.indexOf(candidate.toLocaleLowerCase(locale));
  target.append(document.createTextNode(sentence.slice(0, index)));
  const mark = document.createElement("mark");
  mark.className = `saved-word-highlight ${stage}`;
  mark.textContent = sentence.slice(index, index + candidate.length);
  target.append(mark, document.createTextNode(sentence.slice(index + candidate.length)));
}

function filteredWords(): SavedWord[] {
  const query = search.value.trim().toLocaleLowerCase();
  const sourceFilter = source.value;
  const visible = words.filter((word) => {
    const textMatches = !query || [
      word.lemma,
      word.surface,
      word.meaning,
      word.germanSentence,
      word.englishSentence,
    ].filter(Boolean).some((value) => value!.toLocaleLowerCase().includes(query));
    const stageMatches = activeStage === "all" || word.learningStage === activeStage;
    const sourceMatches = sourceFilter === "all" || sourceName(word.videoUrl) === sourceFilter;
    return textMatches && stageMatches && sourceMatches;
  });
  const mode = sort.value as SortMode;
  return visible.sort((left, right) => {
    if (mode === "frequency") {
      return right.occurrenceCount - left.occurrenceCount ||
        left.lemma.localeCompare(right.lemma, normalizeLanguageCode(left.sourceLanguage, "de"));
    }
    if (mode === "alphabetical") {
      return left.lemma.localeCompare(right.lemma, normalizeLanguageCode(left.sourceLanguage, "de"));
    }
    return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime() || right.id - left.id;
  });
}

function stageLabel(stage: LearningStage): string {
  if (stage === "known") return "Marked as known";
  if (stage === "ignored") return "Don't learn";
  return "Marked to learn";
}

function nextStageAfterRightClick(stage: LearningStage): LearningStage {
  return stage === "learning" ? "known" : "learning";
}

async function toggleWordStage(word: SavedWord): Promise<void> {
  if (pendingStageUpdates.has(word.id)) return;
  pendingStageUpdates.add(word.id);
  const previous = word;
  const optimistic: SavedWord = {
    ...word,
    learningStage: nextStageAfterRightClick(word.learningStage),
  };
  words = words.map((candidate) => candidate.id === word.id ? optimistic : candidate);
  render();
  try {
    const updated = await companionRequest<SavedWord>(
      `/v1/saved-words/${word.id}`,
      "PATCH",
      { learningStage: optimistic.learningStage },
    );
    words = words.map((candidate) => candidate.id === word.id ? updated : candidate);
    render();
  } catch (error) {
    words = words.map((candidate) => candidate.id === word.id ? previous : candidate);
    render();
    message.hidden = false;
    message.textContent = error instanceof Error
      ? error.message
      : "Could not update the saved word.";
  } finally {
    pendingStageUpdates.delete(word.id);
  }
}

function makeWordRow(word: SavedWord): HTMLElement {
  const row = document.createElement("article");
  row.className = "word-row row-grid";

  const checkLabel = document.createElement("label");
  checkLabel.className = "check";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.dataset.wordId = String(word.id);
  checkbox.checked = selected.has(word.id);
  checkbox.ariaLabel = `Select ${word.lemma}`;
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) selected.add(word.id);
    else selected.delete(word.id);
    updateSelection();
  });
  checkLabel.append(checkbox);

  const wordCell = document.createElement("button");
  wordCell.type = "button";
  wordCell.className = "word-cell";
  wordCell.ariaLabel = `Open contextual tutor for ${word.lemma}`;
  wordCell.title = `${stageLabel(word.learningStage)}. Right-click to toggle known / learning.`;
  wordCell.addEventListener("click", () => openTutor(word));
  wordCell.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void toggleWordStage(word);
  });
  const term = document.createElement("div");
  term.className = "term";
  const lemma = document.createElement("div");
  lemma.className = `lemma saved-word-highlight ${word.learningStage}`;
  lemma.textContent = word.lemma;
  const surface = document.createElement("div");
  surface.className = "surface";
  surface.textContent = [
    word.surface !== word.lemma ? `seen as ${word.surface}` : "",
    word.pos,
    word.occurrenceCount > 1 ? `${word.occurrenceCount} contexts` : "",
    `${languageLabel(word.sourceLanguage)} → ${languageLabel(word.targetLanguage)}`,
  ].filter(Boolean).join(" · ");
  term.append(lemma, surface);
  wordCell.append(term);

  const translation = document.createElement("div");
  translation.className = "translation-cell";
  translation.textContent = word.meaning || "No dictionary meaning installed yet";

  const context = document.createElement("div");
  context.className = "context-cell";
  const german = document.createElement("div");
  appendHighlightedText(
    german,
    word.germanSentence,
    word.surface,
    word.lemma,
    word.sourceLanguage,
    word.learningStage,
  );
  const english = document.createElement("div");
  english.className = "context-translation";
  english.textContent = word.englishSentence;
  context.append(german);
  if (word.englishSentence) context.append(english);

  const sourceCell = document.createElement("div");
  sourceCell.className = "source-cell";
  const sourceLink = document.createElement("a");
  sourceLink.className = "source-link";
  sourceLink.href = savedTimestampUrl(word.videoUrl, word.cueStart);
  sourceLink.target = "_blank";
  sourceLink.rel = "noreferrer";
  sourceLink.title = `Open ${sourceName(word.videoUrl)} at ${Math.floor(word.cueStart)} seconds`;
  sourceLink.textContent = `▶ ${sourceName(word.videoUrl)}`;
  sourceCell.append(sourceLink);

  row.append(checkLabel, wordCell, translation, context, sourceCell);
  return row;
}

function openTutor(word: SavedWord): void {
  insightController?.abort();
  insightController = undefined;
  insightRequestKey = undefined;
  activeTutorWord = word;
  tutorWord.textContent = word.lemma || word.surface;
  tutorMeaning.textContent = word.meaning || word.pos ||
    `${languageName(word.sourceLanguage)} word`;
  tutorGerman.replaceChildren();
  appendHighlightedText(
    tutorGerman,
    word.germanSentence,
    word.surface,
    word.lemma,
    word.sourceLanguage,
    word.learningStage,
  );
  tutorEnglish.textContent = word.englishSentence;
  tutorSource.href = savedTimestampUrl(word.videoUrl, word.cueStart);
  tutorSource.textContent = `▶ Resume ${sourceName(word.videoUrl)} at ${formatTime(word.cueStart)}`;
  tutorModel.textContent = preferences.codexEnabled
    ? `${preferences.codexModel} · ${preferences.codexEffort}`
    : "ChatGPT tutor disabled";
  for (const row of container.querySelectorAll<HTMLElement>(".word-row")) {
    const checkbox = row.querySelector<HTMLInputElement>("[data-word-id]");
    row.classList.toggle("tutor-selected", Number(checkbox?.dataset.wordId) === word.id);
  }
  tutor.hidden = false;
  tutorBackdrop.hidden = false;
  void loadInsights();
}

function closeTutor(): void {
  insightController?.abort();
  insightController = undefined;
  insightRequestKey = undefined;
  insightSequence += 1;
  activeTutorWord = undefined;
  tutor.hidden = true;
  tutorBackdrop.hidden = true;
  for (const row of container.querySelectorAll(".tutor-selected")) row.classList.remove("tutor-selected");
}

function formatTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, "0")}`;
}

function renderInsights(insights: WordInsights): void {
  tutorAnswers.className = "tutor-answers";
  renderTutorMarkdown(tutorExplain, insights.explain);
  renderTutorMarkdown(tutorExamples, insights.examples);
  renderTutorMarkdown(tutorGrammar, insights.grammar);
}

function renderPartialInsights(insights: PartialWordInsights): void {
  tutorAnswers.className = "tutor-answers";
  if (insights.explain) renderTutorMarkdown(tutorExplain, insights.explain);
  if (insights.examples) renderTutorMarkdown(tutorExamples, insights.examples);
  if (insights.grammar) renderTutorMarkdown(tutorGrammar, insights.grammar);
}

function setInsightStatus(
  message: string,
  state: "loading" | "error" | "" = "",
): void {
  tutorAnswers.className = `tutor-answers${state ? ` ${state}` : ""}`;
  tutorExplain.textContent = message;
  tutorExamples.textContent = state === "loading" ? "Waiting for the same response…" : "";
  tutorGrammar.textContent = state === "loading" ? "Waiting for the same response…" : "";
}

async function loadInsights(): Promise<void> {
  const word = activeTutorWord;
  if (!word) return;
  if (!preferences.codexEnabled) {
    setInsightStatus("Enable the ChatGPT word tutor in the Polyglot Maxxing popup to generate all three sections.");
    return;
  }

  const cacheKey = [
    word.surface,
    word.lemma,
    word.germanSentence,
    word.sourceLanguage,
    word.targetLanguage,
    preferences.codexModel,
    preferences.codexEffort,
  ].join("\0");
  const cached = insightCache.get(cacheKey);
  if (cached) {
    renderInsights(cached);
    return;
  }
  if (insightRequestKey === cacheKey && insightController) {
    setInsightStatus("Asking ChatGPT…", "loading");
    return;
  }

  insightController?.abort();
  const sequence = ++insightSequence;
  const controller = new AbortController();
  insightController = controller;
  insightRequestKey = cacheKey;
  setInsightStatus("Asking ChatGPT…", "loading");
  try {
    const response = await streamWordInsight(
      {
        word: word.surface,
        lemma: word.lemma,
        context: word.germanSentence,
        contextTranslation: word.englishSentence,
        pos: word.pos,
        morphology: word.morphology,
        meanings: word.meanings.length ? word.meanings : word.meaning ? [word.meaning] : [],
        sourceLanguage: word.sourceLanguage,
        targetLanguage: word.targetLanguage,
        model: preferences.codexModel,
        effort: preferences.codexEffort,
      },
      controller.signal,
      (partial) => {
        if (sequence !== insightSequence || controller.signal.aborted) return;
        renderPartialInsights(partial);
      },
    );
    insightCache.set(cacheKey, response.insights);
    if (sequence !== insightSequence) return;
    renderInsights(response.insights);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    if (sequence !== insightSequence) return;
    setInsightStatus(
      error instanceof Error ? error.message : "The ChatGPT tutor is unavailable.",
      "error",
    );
  } finally {
    if (insightController === controller) {
      insightController = undefined;
      insightRequestKey = undefined;
    }
  }
}

function updateCounts(): void {
  const stages: Array<LearningStage | "all"> = ["all", "known", "learning"];
  for (const stage of stages) {
    const count = stage === "all" ? words.length : words.filter((word) => word.learningStage === stage).length;
    document.querySelector<HTMLElement>(`#count-${stage}`)!.textContent = String(count);
  }
  total.textContent = `${words.length.toLocaleString()} saved word${words.length === 1 ? "" : "s"}`;
}

function updateSelection(): void {
  const validIds = new Set(words.map((word) => word.id));
  for (const id of selected) if (!validIds.has(id)) selected.delete(id);
  bulk.hidden = selected.size === 0;
  selectedCount.textContent = `${selected.size} selected`;
  const visibleCheckboxes = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
  selectAll.checked = visibleCheckboxes.length > 0 && visibleCheckboxes.every((checkbox) => checkbox.checked);
  selectAll.indeterminate = !selectAll.checked && visibleCheckboxes.some((checkbox) => checkbox.checked);
}

function render(): void {
  updateCounts();
  const visible = filteredWords();
  const pageCount = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  currentPage = Math.min(currentPage, pageCount);
  const pageWords = visible.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const fragment = document.createDocumentFragment();
  let previousDate = "";
  for (const word of pageWords) {
    if (sort.value === "newest" && dateKey(word.createdAt) !== previousDate) {
      previousDate = dateKey(word.createdAt);
      const group = document.createElement("div");
      group.className = "date-group";
      const label = document.createElement("span");
      label.textContent = formatDate(word.createdAt);
      group.append(label);
      fragment.append(group);
    }
    fragment.append(makeWordRow(word));
  }
  container.replaceChildren(fragment);
  message.hidden = pageWords.length > 0;
  message.textContent = words.length ? "No saved words match these filters." : "No saved words yet. Right-click a subtitle word to start your list.";
  pageLabel.textContent = `${currentPage} / ${pageCount}`;
  previous.disabled = currentPage <= 1;
  next.disabled = currentPage >= pageCount;
  updateSelection();
}

async function setSelectedStage(stage: LearningStage): Promise<void> {
  if (busy || selected.size === 0) return;
  busy = true;
  try {
    const ids = [...selected];
    const updated = await Promise.all(ids.map((id) =>
      companionRequest<SavedWord>(`/v1/saved-words/${id}`, "PATCH", { learningStage: stage }),
    ));
    const byId = new Map(updated.map((word) => [word.id, word]));
    words = words.map((word) => byId.get(word.id) ?? word);
    selected.clear();
    render();
  } catch (error) {
    message.hidden = false;
    message.textContent = error instanceof Error ? error.message : "Could not update saved words.";
  } finally {
    busy = false;
  }
}

async function deleteSelected(): Promise<void> {
  if (busy || selected.size === 0) return;
  if (!confirm(`Delete ${selected.size} saved word${selected.size === 1 ? "" : "s"}?`)) return;
  busy = true;
  try {
    const ids = [...selected];
    await Promise.all(ids.map((id) => companionRequest<void>(`/v1/saved-words/${id}`, "DELETE")));
    const deleted = new Set(ids);
    words = words.filter((word) => !deleted.has(word.id));
    selected.clear();
    render();
  } catch (error) {
    message.hidden = false;
    message.textContent = error instanceof Error ? error.message : "Could not delete saved words.";
  } finally {
    busy = false;
  }
}

async function load(): Promise<void> {
  try {
    [words, preferences] = await Promise.all([
      companionRequest<SavedWord[]>("/v1/saved-words"),
      loadSubtitlePreferences(),
    ]);
    render();
  } catch {
    message.hidden = false;
    message.textContent = "Start the Polyglot Maxxing companion server to view saved words.";
  }
}

for (const input of [search, source, sort]) {
  input.addEventListener(input === search ? "input" : "change", () => {
    currentPage = 1;
    render();
  });
}
for (const chip of document.querySelectorAll<HTMLButtonElement>("[data-stage]")) {
  chip.addEventListener("click", () => {
    activeStage = chip.dataset.stage as LearningStage | "all";
    for (const candidate of document.querySelectorAll("[data-stage]")) candidate.classList.toggle("selected", candidate === chip);
    currentPage = 1;
    render();
  });
}
for (const button of document.querySelectorAll<HTMLButtonElement>("[data-bulk-stage]")) {
  button.addEventListener("click", () => void setSelectedStage(button.dataset.bulkStage as LearningStage));
}
selectAll.addEventListener("change", () => {
  for (const checkbox of container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
    checkbox.checked = selectAll.checked;
    const id = Number(checkbox.dataset.wordId);
    if (selectAll.checked) selected.add(id);
    else selected.delete(id);
  }
  updateSelection();
});
document.querySelector<HTMLButtonElement>("#delete")!.addEventListener("click", () => void deleteSelected());
document.querySelector<HTMLButtonElement>("#tutor-close")!.addEventListener("click", closeTutor);
tutorBackdrop.addEventListener("click", closeTutor);
document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeTutor(); });
previous.addEventListener("click", () => { currentPage -= 1; render(); });
next.addEventListener("click", () => { currentPage += 1; render(); });

void load();
