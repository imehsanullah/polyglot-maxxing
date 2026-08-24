// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SUBTITLE_PREFERENCES } from "../src/lib/preferences";
import {
  findFullscreenContainer,
  renderTutorMarkdown,
  SubtitleOverlay,
} from "../src/ui/overlay";

describe("tutor response formatting", () => {
  it("renders bold and italic Markdown without interpreting arbitrary HTML", () => {
    const target = document.createElement("div");
    renderTutorMarkdown(
      target,
      '“Werden” means **to become** here. It is *not* future tense.\n<script>alert(1)</script>',
    );

    expect(target.querySelector("strong")?.textContent).toBe("to become");
    expect(target.querySelector("em")?.textContent).toBe("not");
    expect(target.querySelector("script")).toBeNull();
    expect(target.textContent).not.toContain("**");
    expect(target.textContent).toContain("<script>alert(1)</script>");
  });
});

describe("fullscreen overlay mounting", () => {
  it("uses a fullscreen player that contains the video", () => {
    const video = {} as HTMLVideoElement;
    const player = {
      contains: (candidate: unknown) => candidate === video,
    } as HTMLElement;

    expect(findFullscreenContainer(player, video)).toBe(player);
  });

  it("does not mount inside a fullscreen video or unrelated element", () => {
    const video = { contains: () => false } as unknown as HTMLVideoElement;
    const unrelated = { contains: () => false } as unknown as HTMLElement;

    expect(findFullscreenContainer(video as unknown as HTMLElement, video)).toBeUndefined();
    expect(findFullscreenContainer(unrelated, video)).toBeUndefined();
    expect(findFullscreenContainer(null, video)).toBeUndefined();
  });
});

describe("word interactions", () => {
  it("applies numeric subtitle-size changes to the live overlay", () => {
    const player = document.createElement("div");
    player.className = "html5-video-player";
    const video = document.createElement("video");
    player.append(video);
    document.body.append(player);
    const overlay = new SubtitleOverlay(
      "episode",
      "https://www.youtube.com/watch?v=test",
      video,
      "youtube",
      "de",
      "en",
      ["de"],
      vi.fn().mockResolvedValue(undefined),
      vi.fn().mockResolvedValue({
        insights: { explain: "", examples: "", grammar: "" },
        model: "test",
        cached: false,
      }),
      DEFAULT_SUBTITLE_PREFERENCES,
    );

    expect(overlay.host.style.getPropertyValue("--polyglot-maxxing-source-font-size"))
      .toBe("28px");
    overlay.setPreferences({ ...DEFAULT_SUBTITLE_PREFERENCES, fontSize: 39 });
    expect(overlay.host.style.getPropertyValue("--polyglot-maxxing-source-font-size"))
      .toBe("39px");

    overlay.destroy();
    player.remove();
  });

  it("keeps an embedded per-site switch available while subtitles are off", async () => {
    const player = document.createElement("div");
    player.className = "html5-video-player";
    const video = document.createElement("video");
    player.append(video);
    document.body.append(player);
    const toggle = vi.fn().mockResolvedValue(undefined);
    const overlay = new SubtitleOverlay(
      "episode",
      "https://www.youtube.com/watch?v=test",
      video,
      "youtube",
      "de",
      "en",
      ["de"],
      vi.fn().mockResolvedValue(undefined),
      vi.fn().mockResolvedValue({
        insights: { explain: "", examples: "", grammar: "" },
        model: "test",
        cached: false,
      }),
      DEFAULT_SUBTITLE_PREFERENCES,
      [],
      toggle,
    );

    const shadow = overlay.host.shadowRoot!;
    const button = shadow.querySelector<HTMLButtonElement>(".site-toggle")!;
    expect(button.textContent).toBe("PMON");
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(toggle).toHaveBeenCalledWith(false);
    expect(button.textContent).toBe("PMOFF");
    expect(shadow.querySelector<HTMLElement>(".root")!.hidden).toBe(true);
    expect(document.querySelector<HTMLStyleElement>("[data-polyglot-maxxing-native-captions]")!.disabled).toBe(true);
    overlay.destroy();
    player.remove();
  });

  it("shows a hover summary and pins the full word card on click", async () => {
    const player = document.createElement("div");
    player.className = "html5-video-player";
    const video = document.createElement("video");
    player.append(video);
    document.body.append(player);
    const save = vi.fn().mockResolvedValue(undefined);
    const insight = vi.fn().mockResolvedValue({
      insights: {
        explain: "Contextual explanation",
        examples: "Jedes Wort zählt. — Every word counts.",
        grammar: "Neuter nominative noun.",
      },
      model: "test",
      cached: false,
    });
    const overlay = new SubtitleOverlay(
      "episode",
      "https://www.youtube.com/watch?v=test",
      video,
      "youtube",
      "de",
      "en",
      ["de"],
      save,
      insight,
      DEFAULT_SUBTITLE_PREFERENCES,
    );
    overlay.setCue({
      id: "cue-1",
      start: 1,
      end: 3,
      text: "Jedes Wort",
      translation: "Every word",
      tokens: [
        { surface: "Jedes", lemma: "jeder", pos: "DET", morphology: {}, start: 0, end: 5, meanings: ["each"] },
        { surface: "Wort", lemma: "Wort", pos: "NOUN", morphology: { Case: "Nom" }, start: 6, end: 10, meanings: ["word"] },
      ],
    });

    const shadow = overlay.host.shadowRoot!;
    const words = shadow.querySelectorAll<HTMLButtonElement>(".word");
    words[1]!.dispatchEvent(new MouseEvent("mouseenter"));
    expect(shadow.querySelector<HTMLElement>(".hover-card")!.hidden).toBe(false);
    expect(shadow.querySelector(".hover-meaning")!.textContent).toContain("word");

    words[1]!.click();
    expect(shadow.querySelector<HTMLElement>(".word-card")!.hidden).toBe(false);
    expect(shadow.querySelector("[data-role='word']")!.textContent).toBe("Wort");
    expect(shadow.querySelector(".dictionary-meta")!.textContent).toContain("NOUN");

    const examples = Array.from(shadow.querySelectorAll<HTMLButtonElement>(".tab"))
      .find((tab) => tab.textContent === "Examples")!;
    examples.click();
    expect(shadow.querySelector(".insight")!.textContent).toContain("Connect ChatGPT");

    shadow.querySelector<HTMLButtonElement>(".save")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      lemma: "Wort",
      sourceLanguage: "de",
      targetLanguage: "en",
    }));
    overlay.destroy();
  });

  it("uses one tutor request for every insight tab", async () => {
    const player = document.createElement("div");
    player.className = "html5-video-player";
    const video = document.createElement("video");
    player.append(video);
    document.body.append(player);
    const signals: AbortSignal[] = [];
    let reportProgress: ((insights: Partial<{
      explain: string;
      examples: string;
      grammar: string;
    }>) => void) | undefined;
    let resolveInsight: ((value: {
      insights: { explain: string; examples: string; grammar: string };
      model: string;
      cached: boolean;
    }) => void) | undefined;
    const insight = vi.fn((
      _request: unknown,
      signal: AbortSignal,
      onProgress?: typeof reportProgress,
    ) => {
      signals.push(signal);
      reportProgress = onProgress;
      return new Promise<{
        insights: { explain: string; examples: string; grammar: string };
        model: string;
        cached: boolean;
      }>((resolve, reject) => {
        resolveInsight = resolve;
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      });
    });
    const overlay = new SubtitleOverlay(
      "episode",
      "https://www.youtube.com/watch?v=test",
      video,
      "youtube",
      "de",
      "en",
      ["de"],
      vi.fn().mockResolvedValue(undefined),
      insight,
      { ...DEFAULT_SUBTITLE_PREFERENCES, codexEnabled: true },
    );
    overlay.setCue({
      id: "cue-stream",
      start: 1,
      end: 3,
      text: "Noch jemand?",
      translation: "Anyone else?",
      tokens: [
        { surface: "Noch", lemma: "noch", pos: "ADV", morphology: {}, start: 0, end: 4, meanings: ["else"] },
        { surface: "jemand", lemma: "jemand", pos: "PRON", morphology: {}, start: 5, end: 11, meanings: ["someone"] },
      ],
    });

    const shadow = overlay.host.shadowRoot!;
    shadow.querySelector<HTMLButtonElement>(".word")!.click();
    expect(shadow.querySelector(".insight")?.textContent).toBe("Asking ChatGPT…");
    reportProgress?.({ explain: "A streaming contextual answer" });
    expect(shadow.querySelector(".insight")?.textContent).toContain("streaming contextual");
    const examples = Array.from(shadow.querySelectorAll<HTMLButtonElement>(".tab"))
      .find((tab) => tab.textContent === "Examples")!;
    examples.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shadow.querySelector(".insight")?.textContent).toBe("Asking ChatGPT…");
    reportProgress?.({
      explain: "A streaming contextual answer",
      examples: "Noch jemand? — Anyone else",
    });
    expect(shadow.querySelector(".insight")?.textContent).toContain("Noch jemand?");

    expect(insight).toHaveBeenCalledTimes(1);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);
    resolveInsight?.({
      insights: {
        explain: "A contextual **answer**.",
        examples: "Noch jemand? — Anyone else?",
        grammar: "An adverb in this sentence.",
      },
      model: "test",
      cached: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shadow.querySelector(".insight")?.textContent).toContain("Noch jemand?");

    const grammar = Array.from(shadow.querySelectorAll<HTMLButtonElement>(".tab"))
      .find((tab) => tab.textContent === "Grammar")!;
    grammar.click();
    expect(shadow.querySelector(".insight")?.textContent).toContain("adverb");
    expect(insight).toHaveBeenCalledTimes(1);
    overlay.destroy();
    player.remove();
  });

  it("uses only surface words and Codex tutoring for non-German subtitles", async () => {
    const player = document.createElement("div");
    player.className = "html5-video-player";
    const video = document.createElement("video");
    player.append(video);
    document.body.append(player);
    const save = vi.fn().mockResolvedValue(undefined);
    const insight = vi.fn().mockResolvedValue({
      insights: {
        explain: "A contextual explanation.",
        examples: "Bonjour ! — Hello!",
        grammar: "A greeting in this sentence.",
      },
      model: "test",
      cached: false,
    });
    const overlay = new SubtitleOverlay(
      "episode",
      "https://www.youtube.com/watch?v=test",
      video,
      "youtube",
      "fr",
      "en",
      ["fr"],
      save,
      insight,
      { ...DEFAULT_SUBTITLE_PREFERENCES, codexEnabled: true },
    );
    overlay.setCue({
      id: "cue-fr",
      start: 1,
      end: 3,
      text: "Bonjour !",
      translation: "Hello!",
      tokens: [
        {
          surface: "Bonjour",
          lemma: "manufactured-lemma",
          pos: "FAKE_POS",
          morphology: { Fake: "Feature" },
          start: 0,
          end: 7,
          meanings: ["local meaning"],
        },
      ],
    });

    const shadow = overlay.host.shadowRoot!;
    shadow.querySelector<HTMLButtonElement>(".word")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(shadow.querySelector("[data-role='word']")!.textContent).toBe("Bonjour");
    expect(shadow.querySelector<HTMLElement>(".dictionary")!.hidden).toBe(true);
    expect(insight).toHaveBeenCalledWith(expect.objectContaining({
      word: "Bonjour",
      lemma: "Bonjour",
      pos: "",
      morphology: {},
      meanings: [],
      sourceLanguage: "fr",
      targetLanguage: "en",
    }), expect.any(AbortSignal), expect.any(Function));

    shadow.querySelector<HTMLButtonElement>(".save")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      surface: "Bonjour",
      lemma: "Bonjour",
      pos: "",
      morphology: {},
      meanings: [],
    }));
    overlay.destroy();
    player.remove();
  });

  it("marks an unseen word for learning and toggles it to known on right-click", async () => {
    const player = document.createElement("div");
    player.className = "html5-video-player";
    const video = document.createElement("video");
    player.append(video);
    document.body.append(player);
    const save = vi.fn()
      .mockResolvedValueOnce({ learningStage: "learning" })
      .mockResolvedValueOnce({ learningStage: "known" });
    const overlay = new SubtitleOverlay(
      "episode",
      "https://www.youtube.com/watch?v=test",
      video,
      "youtube",
      "de",
      "en",
      ["de"],
      save,
      vi.fn().mockResolvedValue({
        insights: {
          explain: "Explanation",
          examples: "Ein Wort. — One word.",
          grammar: "A noun.",
        },
        model: "test",
        cached: false,
      }),
      DEFAULT_SUBTITLE_PREFERENCES,
    );
    overlay.setCue({
      id: "cue-1",
      start: 1,
      end: 3,
      text: "Ein Wort",
      translation: "A word",
      tokens: [
        { surface: "Ein", lemma: "ein", pos: "DET", morphology: {}, start: 0, end: 3, meanings: ["a"] },
        { surface: "Wort", lemma: "Wort", pos: "NOUN", morphology: {}, start: 4, end: 8, meanings: ["word"] },
      ],
    });

    const word = overlay.host.shadowRoot!.querySelectorAll<HTMLButtonElement>(".word")[1]!;
    expect(getComputedStyle(word).color).toBe("#b894c5");
    word.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ lemma: "Wort" }), "toggle");
    expect(word.classList.contains("stage-learning")).toBe(true);
    expect(getComputedStyle(word).color).toBe("#ffbd80");

    word.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(word.classList.contains("stage-known")).toBe(true);
    expect(getComputedStyle(word).color).toBe("#9cffcd");
    expect(overlay.host.shadowRoot!.querySelector(".hover-stage")!.textContent).toContain("known");
    overlay.destroy();
    player.remove();
  });

  it("offers a per-video learning and translation language override", async () => {
    const player = document.createElement("div");
    player.className = "html5-video-player";
    const video = document.createElement("video");
    player.append(video);
    document.body.append(player);
    const changeLanguages = vi.fn().mockResolvedValue(undefined);
    const overlay = new SubtitleOverlay(
      "episode",
      "https://www.youtube.com/watch?v=test",
      video,
      "youtube",
      "de",
      "en",
      ["de", "es"],
      vi.fn().mockResolvedValue(undefined),
      vi.fn().mockResolvedValue({
        insights: { explain: "", examples: "", grammar: "" },
        model: "test",
        cached: false,
      }),
      DEFAULT_SUBTITLE_PREFERENCES,
      [],
      vi.fn(),
      changeLanguages,
    );

    const shadow = overlay.host.shadowRoot!;
    expect(shadow.querySelector<HTMLButtonElement>(".language-toggle")!.textContent)
      .toBe("DE → EN");
    shadow.querySelector<HTMLButtonElement>(".language-toggle")!.click();
    const selects = shadow.querySelectorAll<HTMLSelectElement>(".language-panel select");
    selects[0]!.value = "es";
    selects[1]!.value = "fr";
    shadow.querySelector<HTMLButtonElement>(".language-apply")!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(changeLanguages).toHaveBeenCalledWith("es", "fr");
    overlay.destroy();
    player.remove();
  });
});
