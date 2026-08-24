from __future__ import annotations

import logging
import re
from typing import Any

from .database import Database
from .models import TokenAnalysis


LOGGER = logging.getLogger(__name__)
WORD_PATTERN = re.compile(r"[^\W\d_]+(?:[’'-][^\W\d_]+)*", re.UNICODE)


def _features(value: str | None) -> dict[str, str]:
    if not value:
        return {}
    result: dict[str, str] = {}
    for feature in value.split("|"):
        key, separator, item = feature.partition("=")
        if separator:
            result[key] = item
    return result


class MultilingualAnalyzer:
    def __init__(self, database: Database, *, enable_stanza: bool = False):
        self.database = database
        self.enable_stanza = enable_stanza
        self._pipelines: dict[str, Any] = {}
        self._stanza_failed: set[str] = set()

    @property
    def name(self) -> str:
        if self._pipelines:
            return "stanza-german"
        return "unicode-fallback" if not self.enable_stanza else "stanza-german (lazy)"

    def analyze(
        self,
        text: str,
        source_language: str = "de",
        target_language: str = "en",
    ) -> list[TokenAnalysis]:
        language = source_language.lower().replace("_", "-").split("-", 1)[0]
        # German keeps the local lemma/POS/morphology and FreeDict experience.
        # Every other language is deliberately Codex-first: the server only
        # supplies clickable surface-word boundaries and does not initialize a
        # Stanza pipeline or manufacture linguistic metadata for that language.
        if language != "de":
            return self._analyze_surface_words(text)
        pipeline = self._get_stanza_pipeline(language)
        if pipeline is not None:
            return self._analyze_with_stanza(text, pipeline, language, target_language)
        return self._analyze_fallback(text, language, target_language)

    def _analyze_surface_words(self, text: str) -> list[TokenAnalysis]:
        return [
            TokenAnalysis(
                surface=match.group(0),
                # The API and saved-word schema require a stable lookup key.
                # This is the surface form, not a claimed linguistic lemma.
                lemma=match.group(0),
                pos="",
                morphology={},
                start=match.start(),
                end=match.end(),
                meanings=[],
            )
            for match in WORD_PATTERN.finditer(text)
        ]

    def _get_stanza_pipeline(self, language: str) -> Any | None:
        if not self.enable_stanza or language in self._stanza_failed:
            return self._pipelines.get(language)
        if language in self._pipelines:
            return self._pipelines[language]
        try:
            import stanza

            self._pipelines[language] = stanza.Pipeline(
                lang=language,
                processors="tokenize,pos,lemma",
                download_method=None,
                verbose=False,
            )
        except Exception as error:  # optional dependency/model may be absent
            LOGGER.warning(
                "Stanza model %s is unavailable; using tokenizer fallback: %s",
                language,
                error,
            )
            self._stanza_failed.add(language)
        return self._pipelines.get(language)

    def _analyze_with_stanza(
        self,
        text: str,
        pipeline: Any,
        language: str,
        target_language: str,
    ) -> list[TokenAnalysis]:
        document = pipeline(text)
        tokens: list[TokenAnalysis] = []
        search_offset = 0
        for sentence in document.sentences:
            for word in sentence.words:
                surface = word.text
                start = getattr(word, "start_char", None)
                end = getattr(word, "end_char", None)
                if start is None or end is None:
                    start = text.find(surface, search_offset)
                    if start < 0:
                        continue
                    end = start + len(surface)
                search_offset = end
                lemma = word.lemma or surface.casefold()
                pos = word.upos or ""
                if pos in {"PUNCT", "SYM", "SPACE"}:
                    continue
                tokens.append(
                    TokenAnalysis(
                        surface=surface,
                        lemma=lemma,
                        pos=pos,
                        morphology=_features(word.feats),
                        start=start,
                        end=end,
                        meanings=self._dictionary_meanings(
                            lemma, pos, language, target_language
                        ),
                    )
                )
        return tokens

    def _analyze_fallback(
        self,
        text: str,
        language: str,
        target_language: str,
    ) -> list[TokenAnalysis]:
        tokens: list[TokenAnalysis] = []
        for match in WORD_PATTERN.finditer(text):
            surface = match.group(0)
            lemma = surface.casefold()
            tokens.append(
                TokenAnalysis(
                    surface=surface,
                    lemma=lemma,
                    pos="",
                    morphology={},
                    start=match.start(),
                    end=match.end(),
                    meanings=self._dictionary_meanings(
                        lemma, "", language, target_language
                    ),
                )
            )
        return tokens

    def _dictionary_meanings(
        self,
        lemma: str,
        pos: str,
        language: str,
        target_language: str,
    ) -> list[str]:
        # The bundled FreeDict database is currently German → English.
        # Other language pairs intentionally rely on contextual meanings from
        # ChatGPT and never query the local dictionary.
        if language == "de" and target_language.lower().startswith("en"):
            return self.database.dictionary_meanings(lemma, pos)
        return []


# Backwards-compatible import for third-party code using the original name.
GermanAnalyzer = MultilingualAnalyzer
