from __future__ import annotations

import asyncio
from typing import Protocol

from .codex import (
    CodexAuthenticationError,
    CodexEnricher,
    CodexTranslationResponseError,
    CodexUnavailableError,
)


class TranslationError(RuntimeError):
    pass


class TranslationProvider(Protocol):
    provider_name: str
    model_name: str

    async def translate(
        self,
        text: str,
        source_language: str = "de",
        target_language: str = "en",
        *,
        context_before: str | None = None,
        context_after: str | None = None,
    ) -> str: ...

    async def translate_batch(
        self,
        cues: list[dict[str, str | None]],
        source_language: str = "de",
        target_language: str = "en",
        *,
        model: str | None = None,
        effort: str | None = None,
    ) -> list[str]: ...

    async def health(self) -> tuple[bool, bool]: ...

    async def close(self) -> None: ...


class CodexTranslationProvider:
    """Translate subtitle batches through the attached ChatGPT/Codex account."""

    provider_name = "codex-chatgpt"

    def __init__(
        self,
        *,
        codex: CodexEnricher,
        model: str = "gpt-5.6-luna",
        effort: str = "low",
        timeout_seconds: float = 90.0,
    ) -> None:
        self.codex = codex
        self.model_name = model
        self.effort = effort
        self.timeout_seconds = timeout_seconds

    async def translate(
        self,
        text: str,
        source_language: str = "de",
        target_language: str = "en",
        *,
        context_before: str | None = None,
        context_after: str | None = None,
    ) -> str:
        translations = await self.translate_batch(
            [
                {
                    "id": "cue-0",
                    "text": text,
                    "context_before": context_before,
                    "context_after": context_after,
                }
            ],
            source_language,
            target_language,
        )
        return translations[0]

    async def translate_batch(
        self,
        cues: list[dict[str, str | None]],
        source_language: str = "de",
        target_language: str = "en",
        *,
        model: str | None = None,
        effort: str | None = None,
    ) -> list[str]:
        try:
            return await self._translate_batch_resilient(
                cues,
                source_language,
                target_language,
                model=model or self.model_name,
                effort=effort or self.effort,
            )
        except CodexAuthenticationError as error:
            raise TranslationError(str(error)) from error
        except CodexUnavailableError as error:
            raise TranslationError(str(error)) from error
        except Exception as error:
            raise TranslationError(f"Codex translation failed: {error}") from error

    async def _translate_batch_once(
        self,
        cues: list[dict[str, str | None]],
        source_language: str,
        target_language: str,
        *,
        model: str,
        effort: str,
    ) -> list[str]:
        return await self.codex.translate_subtitles(
            cues=cues,
            source_language=source_language,
            target_language=target_language,
            model=model,
            effort=effort,
            timeout_seconds=self.timeout_seconds,
        )

    async def _translate_batch_resilient(
        self,
        cues: list[dict[str, str | None]],
        source_language: str,
        target_language: str,
        *,
        model: str,
        effort: str,
    ) -> list[str]:
        try:
            return await self._translate_batch_once(
                cues,
                source_language,
                target_language,
                model=model,
                effort=effort,
            )
        except CodexTranslationResponseError:
            if len(cues) <= 1:
                # A one-cue priority request is cheap; give structured output
                # one clean retry before surfacing the validation failure.
                return await self._translate_batch_once(
                    cues,
                    source_language,
                    target_language,
                    model=model,
                    effort=effort,
                )

            # Preserve the normal 24-cue request. Only a malformed response is
            # bisected, allowing valid smaller chunks to be cached immediately
            # instead of retrying the same failing batch every five seconds.
            midpoint = len(cues) // 2
            left, right = await asyncio.gather(
                self._translate_batch_resilient(
                    cues[:midpoint],
                    source_language,
                    target_language,
                    model=model,
                    effort=effort,
                ),
                self._translate_batch_resilient(
                    cues[midpoint:],
                    source_language,
                    target_language,
                    model=model,
                    effort=effort,
                ),
            )
            return [*left, *right]

    async def health(self) -> tuple[bool, bool]:
        try:
            status = await self.codex.status()
        except Exception:
            return False, False
        return bool(status.get("available")), bool(status.get("authenticated"))

    async def close(self) -> None:
        # The shared Codex client is owned and closed by the application lifespan.
        return None
