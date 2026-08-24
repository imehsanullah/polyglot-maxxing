import type {
  BackgroundResponse,
  CodexLoginStart,
  CodexLogoutResponse,
  CodexModelInfo,
  CodexModelsResponse,
  CodexStatus,
} from "../../src/domain/types";
import {
  DEFAULT_SUBTITLE_PREFERENCES,
  loadSubtitlePreferences,
  saveSubtitlePreferences,
} from "../../src/lib/preferences";
import { LANGUAGE_OPTIONS } from "../../src/lib/languages";

interface Health {
  status: string;
  translationProvider: string;
  translationServiceReachable: boolean;
  codexAuthenticated: boolean;
  model: string;
  analyzer: string;
}

const status = document.querySelector<HTMLDivElement>("#status")!;
const saved = document.querySelector<HTMLButtonElement>("#saved")!;
const subtitleSize = document.querySelector<HTMLInputElement>("#subtitle-size")!;
const pauseOnClick = document.querySelector<HTMLInputElement>("#pause-on-click")!;
const learningLanguage = document.querySelector<HTMLSelectElement>("#learning-language")!;
const translationLanguage = document.querySelector<HTMLSelectElement>("#translation-language")!;
const codexEnabled = document.querySelector<HTMLInputElement>("#codex-enabled")!;
const codexModel = document.querySelector<HTMLSelectElement>("#codex-model")!;
const codexEffort = document.querySelector<HTMLSelectElement>("#codex-effort")!;
const codexModelRefresh = document.querySelector<HTMLButtonElement>("#codex-model-refresh")!;
const codexStatus = document.querySelector<HTMLDivElement>("#codex-status")!;
const codexAccount = document.querySelector<HTMLDivElement>("#codex-account")!;
const codexAccountEmail = document.querySelector<HTMLElement>("#codex-account-email")!;
const codexAccountMeta = document.querySelector<HTMLElement>("#codex-account-meta")!;
const codexSwitch = document.querySelector<HTMLButtonElement>("#codex-switch")!;
const codexDisconnect = document.querySelector<HTMLButtonElement>("#codex-disconnect")!;
const codexConnect = document.querySelector<HTMLButtonElement>("#codex-connect")!;
const codexDevice = document.querySelector<HTMLDivElement>("#codex-device")!;
const codexCode = document.querySelector<HTMLOutputElement>("#codex-code")!;
const codexCopy = document.querySelector<HTMLButtonElement>("#codex-copy")!;
let pendingLogin: CodexLoginStart | undefined;
let availableModels: CodexModelInfo[] = [];
let codexStatusPoll: number | undefined;
let currentPreferences = DEFAULT_SUBTITLE_PREFERENCES;

async function companionRequest<T>(path: string, method: "GET" | "POST" = "GET"): Promise<T> {
  const response = (await browser.runtime.sendMessage({
    type: "COMPANION_REQUEST",
    path,
    method,
  })) as BackgroundResponse<T>;
  if (!response.ok || !response.data) {
    throw new Error(response.error || "Companion request failed.");
  }
  return response.data;
}

async function loadHealth(): Promise<void> {
  const response = (await browser.runtime.sendMessage({
    type: "COMPANION_REQUEST",
    path: "/health",
    method: "GET",
  })) as BackgroundResponse<Health>;
  if (!response.ok || !response.data) {
    status.className = "status error";
    status.textContent = "Companion server is not running on 127.0.0.1:8765.";
    return;
  }
  const health = response.data;
  status.className = `status ${health.status === "ok" ? "ok" : "error"}`;
  status.title = `${health.model} · ${health.analyzer}`;
  status.textContent = health.status === "ok"
    ? "Ready"
    : health.translationServiceReachable
      ? "Connect a ChatGPT account to enable subtitle translation."
      : "The Codex SDK is not reachable in the companion service.";
}

saved.addEventListener("click", () => {
  void browser.tabs.create({ url: browser.runtime.getURL("/saved.html") });
});

subtitleSize.addEventListener("input", () => {
  const value = Number(subtitleSize.value);
  if (subtitleSize.value && Number.isFinite(value)) void savePreferences();
});
subtitleSize.addEventListener("change", () => void savePreferences());

pauseOnClick.addEventListener("change", () => void savePreferences());
learningLanguage.addEventListener("change", () => void savePreferences());
translationLanguage.addEventListener("change", () => void savePreferences());
codexEnabled.addEventListener("change", () => void savePreferences());
codexModel.addEventListener("change", () => {
  populateEfforts(codexModel.value);
  void savePreferences();
});
codexEffort.addEventListener("change", () => void savePreferences());

async function savePreferences(): Promise<void> {
  // Keep a local snapshot so browser.storage.local.set is issued immediately.
  // Awaiting a read first allowed Chrome to destroy the popup before a typed
  // numeric value was ever persisted.
  currentPreferences = {
    ...currentPreferences,
    learningLanguage: learningLanguage.value,
    translationLanguage: translationLanguage.value,
    fontSize: Number(subtitleSize.value),
    pauseOnWordClick: pauseOnClick.checked,
    codexEnabled: codexEnabled.checked,
    codexModel: codexModel.value,
    codexEffort: codexEffort.value,
  };
  await saveSubtitlePreferences(currentPreferences);
}

function addOption(
  select: HTMLSelectElement,
  value: string,
  label = value,
): HTMLOptionElement {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  select.append(option);
  return option;
}

function populateEfforts(modelName: string, preferred?: string): void {
  const model = availableModels.find(
    (candidate) => candidate.model === modelName || candidate.id === modelName,
  );
  const efforts = model?.supportedReasoningEfforts.length
    ? model.supportedReasoningEfforts
    : [preferred || "low"];
  const selected = preferred && efforts.includes(preferred)
    ? preferred
    : model?.defaultReasoningEffort && efforts.includes(model.defaultReasoningEffort)
      ? model.defaultReasoningEffort
      : efforts[0] ?? "low";
  codexEffort.replaceChildren();
  for (const effort of efforts) addOption(codexEffort, effort);
  codexEffort.value = selected;
}

function preferredModel(models: CodexModelInfo[], savedModel: string): CodexModelInfo {
  return models.find((model) => model.model === savedModel || model.id === savedModel)
    ?? models.find((model) => model.model === "gpt-5.6-luna")
    ?? models.find((model) => model.isDefault)
    ?? models[0]!;
}

function resetModelCatalog(
  preferences: Awaited<ReturnType<typeof loadSubtitlePreferences>>,
): void {
  availableModels = [];
  codexModel.replaceChildren();
  addOption(codexModel, preferences.codexModel);
  populateEfforts(preferences.codexModel, preferences.codexEffort);
  codexModel.disabled = true;
  codexEffort.disabled = true;
  codexModelRefresh.disabled = true;
  codexModel.title = "Connect an account to load its Codex models.";
}

async function loadPreferences(): Promise<void> {
  const preferences = await loadSubtitlePreferences();
  currentPreferences = preferences;
  subtitleSize.value = String(preferences.fontSize);
  pauseOnClick.checked = preferences.pauseOnWordClick;
  learningLanguage.value = preferences.learningLanguage;
  translationLanguage.value = preferences.translationLanguage;
  codexEnabled.checked = preferences.codexEnabled;
  resetModelCatalog(preferences);
}

async function refreshModelCatalog(): Promise<void> {
  const preferences = await loadSubtitlePreferences();
  codexModelRefresh.disabled = true;
  codexModelRefresh.textContent = "…";
  try {
    const response = await companionRequest<CodexModelsResponse>("/v1/codex/models");
    if (!response.models.length) return;
    availableModels = response.models;
    const accountMeta = codexAccountMeta.dataset.baseText || codexAccountMeta.textContent || "Connected";
    codexAccountMeta.textContent = `${accountMeta} · ${availableModels.length} models`;
    const selectedModel = preferredModel(availableModels, preferences.codexModel);
    codexModel.replaceChildren();
    for (const model of availableModels) {
      addOption(codexModel, model.model, model.displayName).title = model.description;
    }
    codexModel.value = selectedModel.model;
    populateEfforts(selectedModel.model, preferences.codexEffort);
    codexModel.disabled = false;
    codexEffort.disabled = false;
    codexModel.title = `Fetched from Codex for ${codexAccountEmail.textContent || "the connected account"}.`;
    if (
      selectedModel.model !== preferences.codexModel ||
      codexEffort.value !== preferences.codexEffort
    ) {
      await savePreferences();
    }
  } catch {
    resetModelCatalog(preferences);
    codexModel.title = "Could not refresh models from Codex.";
  } finally {
    codexModelRefresh.textContent = "↻";
    codexModelRefresh.disabled = codexAccount.hidden;
  }
}

for (const select of [learningLanguage, translationLanguage]) {
  for (const language of LANGUAGE_OPTIONS) {
    const option = document.createElement("option");
    option.value = language.code;
    option.textContent = language.name;
    select.append(option);
  }
}

async function loadCodexStatus(): Promise<void> {
  if (codexStatusPoll !== undefined) {
    window.clearTimeout(codexStatusPoll);
    codexStatusPoll = undefined;
  }
  try {
    const state = await companionRequest<CodexStatus>("/v1/codex/status");
    codexAccount.hidden = !state.authenticated;
    codexStatus.hidden = state.authenticated;
    codexStatus.className = `codex-status ${state.authenticated ? "ok" : state.available ? "" : "error"}`;
    codexStatus.textContent = state.authenticated
      ? `Connected${state.planType ? ` · ${state.planType}` : ""}`
      : state.loginPending
        ? "Waiting for ChatGPT sign-in…"
        : state.error || "Not connected.";
    if (state.authenticated) {
      const accountName = state.email ||
        (state.authMode === "apiKey" ? "API key session" : "ChatGPT account");
      codexAccountEmail.textContent = accountName;
      codexAccountEmail.title = accountName;
      const accountMeta = [state.planType, state.authMode]
        .filter(Boolean)
        .join(" · ") || "Connected";
      codexAccountMeta.dataset.baseText = accountMeta;
      codexAccountMeta.textContent = accountMeta;
      pendingLogin = undefined;
      codexDevice.hidden = true;
      codexConnect.hidden = true;
      await refreshModelCatalog();
      return;
    }
    resetModelCatalog(await loadSubtitlePreferences());
    codexConnect.hidden = !state.available;
    if (state.loginPending) {
      const login = await companionRequest<CodexLoginStart>("/v1/codex/login/start", "POST");
      showPendingLogin(login);
      scheduleCodexStatusRefresh();
    }
  } catch (error) {
    codexAccount.hidden = true;
    codexStatus.hidden = false;
    codexStatus.className = "codex-status error";
    codexStatus.textContent = error instanceof Error ? error.message : "Codex SDK is unavailable.";
    codexConnect.hidden = true;
  }
}

function scheduleCodexStatusRefresh(): void {
  if (codexStatusPoll !== undefined) window.clearTimeout(codexStatusPoll);
  codexStatusPoll = window.setTimeout(() => void loadCodexStatus(), 2_000);
}

function showPendingLogin(login: CodexLoginStart): void {
  pendingLogin = login;
  codexAccount.hidden = true;
  codexStatus.hidden = false;
  codexModelRefresh.disabled = true;
  codexDevice.hidden = false;
  codexCode.value = login.userCode;
  codexStatus.className = "codex-status";
  codexStatus.textContent = "Copy this code, then enter it in the ChatGPT sign-in tab.";
  codexConnect.hidden = false;
  codexConnect.disabled = false;
  codexConnect.textContent = "Open ChatGPT sign-in";
}

codexCopy.addEventListener("click", async () => {
  if (!pendingLogin) return;
  try {
    await navigator.clipboard.writeText(pendingLogin.userCode);
    codexCopy.textContent = "Copied";
  } catch {
    codexCode.focus();
    window.getSelection()?.selectAllChildren(codexCode);
    codexCopy.textContent = "Select code";
  }
});

codexConnect.addEventListener("click", async () => {
  codexConnect.disabled = true;
  codexConnect.textContent = pendingLogin ? "Opening sign-in…" : "Starting sign-in…";
  try {
    const login = pendingLogin ??
      await companionRequest<CodexLoginStart>("/v1/codex/login/start", "POST");
    showPendingLogin(login);
    scheduleCodexStatusRefresh();
    await browser.tabs.create({ url: login.verificationUrl });
  } catch (error) {
    codexStatus.className = "codex-status error";
    codexStatus.textContent = error instanceof Error ? error.message : "Could not start sign-in.";
    codexConnect.disabled = false;
    codexConnect.textContent = "Connect ChatGPT account";
  }
});

codexModelRefresh.addEventListener("click", () => void refreshModelCatalog());

function setAccountButtonsDisabled(disabled: boolean): void {
  codexSwitch.disabled = disabled;
  codexDisconnect.disabled = disabled;
}

codexDisconnect.addEventListener("click", async () => {
  if (!window.confirm("Disconnect this ChatGPT account from Polyglot Maxxing? Uncached translations and word tutoring will stop.")) {
    return;
  }
  setAccountButtonsDisabled(true);
  codexStatus.hidden = false;
  codexStatus.className = "codex-status";
  codexStatus.textContent = "Disconnecting…";
  try {
    await companionRequest<CodexLogoutResponse>("/v1/codex/logout", "POST");
    pendingLogin = undefined;
    codexDevice.hidden = true;
    codexAccount.hidden = true;
    resetModelCatalog(await loadSubtitlePreferences());
    await Promise.all([loadCodexStatus(), loadHealth()]);
  } catch (error) {
    codexStatus.className = "codex-status error";
    codexStatus.textContent = error instanceof Error ? error.message : "Could not disconnect.";
  } finally {
    setAccountButtonsDisabled(false);
  }
});

codexSwitch.addEventListener("click", async () => {
  if (!window.confirm("Disconnect the current ChatGPT account and sign in with another one?")) {
    return;
  }
  setAccountButtonsDisabled(true);
  codexStatus.hidden = false;
  codexStatus.className = "codex-status";
  codexStatus.textContent = "Preparing account switch…";
  try {
    resetModelCatalog(await loadSubtitlePreferences());
    const login = await companionRequest<CodexLoginStart>("/v1/codex/login/switch", "POST");
    showPendingLogin(login);
    scheduleCodexStatusRefresh();
    await browser.tabs.create({ url: login.verificationUrl });
  } catch (error) {
    codexStatus.className = "codex-status error";
    codexStatus.textContent = error instanceof Error ? error.message : "Could not switch account.";
  } finally {
    setAccountButtonsDisabled(false);
  }
});

void loadHealth();
void (async () => {
  await loadPreferences();
  await loadCodexStatus();
})();
