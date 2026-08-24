from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


def to_camel(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(part.capitalize() for part in tail)


class ApiModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class CueInput(ApiModel):
    id: str = Field(min_length=1, max_length=200)
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    text: str = Field(min_length=1, max_length=2_000)
    context_before: str | None = Field(default=None, max_length=2_000, exclude=True)
    context_after: str | None = Field(default=None, max_length=2_000, exclude=True)


class ProcessCuesRequest(ApiModel):
    source_language: str = "de"
    target_language: str = "en"
    model: str = Field(default="gpt-5.6-luna", min_length=1, max_length=200)
    effort: str = Field(default="low", min_length=1, max_length=50)
    cues: list[CueInput] = Field(min_length=1, max_length=32)


class TokenAnalysis(ApiModel):
    surface: str
    lemma: str
    pos: str
    morphology: dict[str, str] = Field(default_factory=dict)
    start: int
    end: int
    meanings: list[str] = Field(default_factory=list)


class ProcessedCue(CueInput):
    translation: str
    tokens: list[TokenAnalysis]


class ProcessCuesResponse(ApiModel):
    cues: list[ProcessedCue]
    model: str


LearningStage = Literal["learning", "known", "ignored"]


class SavedWordInput(ApiModel):
    surface: str = Field(min_length=1, max_length=300)
    lemma: str = Field(min_length=1, max_length=300)
    pos: str = Field(default="", max_length=100)
    meaning: str | None = Field(default=None, max_length=2_000)
    meanings: list[str] = Field(default_factory=list, max_length=10)
    morphology: dict[str, str] = Field(default_factory=dict)
    german_sentence: str = Field(min_length=1, max_length=4_000)
    english_sentence: str = Field(default="", max_length=4_000)
    source_language: str = Field(default="de", min_length=2, max_length=35)
    target_language: str = Field(default="en", min_length=2, max_length=35)
    video_url: str = Field(min_length=1, max_length=4_000)
    episode_id: str = Field(min_length=1, max_length=2_000)
    cue_id: str = Field(min_length=1, max_length=200)
    cue_start: float = Field(ge=0)


class SavedWord(ApiModel):
    id: int
    surface: str
    lemma: str
    pos: str
    meaning: str | None
    meanings: list[str]
    morphology: dict[str, str]
    learning_stage: LearningStage
    occurrence_count: int
    german_sentence: str
    english_sentence: str
    source_language: str
    target_language: str
    video_url: str
    episode_id: str
    cue_id: str
    cue_start: float
    created_at: datetime
    updated_at: datetime


class SavedWordUpdate(ApiModel):
    learning_stage: LearningStage


class HealthResponse(ApiModel):
    status: str
    translation_provider: str
    translation_service_reachable: bool
    codex_authenticated: bool
    model: str
    analyzer: str


CodexModel = str
CodexEffort = str


class WordInsightRequest(ApiModel):
    word: str = Field(min_length=1, max_length=300)
    lemma: str = Field(min_length=1, max_length=300)
    context: str = Field(min_length=1, max_length=4_000)
    context_translation: str = Field(default="", max_length=4_000)
    pos: str = Field(default="", max_length=100)
    morphology: dict[str, str] = Field(default_factory=dict)
    meanings: list[str] = Field(default_factory=list, max_length=10)
    source_language: str = Field(default="de", min_length=2, max_length=35)
    target_language: str = Field(default="en", min_length=2, max_length=35)
    model: CodexModel
    effort: CodexEffort


class WordInsights(ApiModel):
    explain: str
    examples: str
    grammar: str


class WordInsightResponse(ApiModel):
    insights: WordInsights
    model: str
    cached: bool


class CodexStatusResponse(ApiModel):
    available: bool
    authenticated: bool
    auth_mode: str | None = None
    email: str | None = None
    plan_type: str | None = None
    login_pending: bool = False
    error: str | None = None


class CodexModelInfo(ApiModel):
    id: str
    model: str
    display_name: str
    description: str = ""
    is_default: bool = False
    default_reasoning_effort: str
    supported_reasoning_efforts: list[str]


class CodexModelsResponse(ApiModel):
    models: list[CodexModelInfo]


class CodexLoginStartResponse(ApiModel):
    login_id: str
    verification_url: str
    user_code: str


class CodexLogoutResponse(ApiModel):
    disconnected: bool = True
