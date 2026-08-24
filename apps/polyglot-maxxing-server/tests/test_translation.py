from __future__ import annotations

import pytest

from polyglot_maxxing.codex import (
    CodexAuthenticationError,
    CodexTranslationResponseError,
    CodexUnavailableError,
)
from polyglot_maxxing.translation import (
    CodexTranslationProvider,
    TranslationError,
)


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


class FakeCodex:
    def __init__(
        self,
        *,
        authenticated: bool = True,
        error: Exception | None = None,
    ) -> None:
        self.authenticated = authenticated
        self.error = error
        self.calls: list[dict[str, object]] = []

    async def translate_subtitles(self, **values: object) -> list[str]:
        self.calls.append(values)
        if self.error is not None:
            raise self.error
        cues = values["cues"]
        assert isinstance(cues, list)
        return [f"English: {cue['text']}" for cue in cues]

    async def status(self) -> dict[str, object]:
        return {
            "available": True,
            "authenticated": self.authenticated,
        }


@pytest.mark.anyio
async def test_codex_provider_translates_a_batch_without_a_fallback() -> None:
    codex = FakeCodex()
    provider = CodexTranslationProvider(
        codex=codex,  # type: ignore[arg-type]
        model="gpt-5.6-luna",
        effort="low",
        timeout_seconds=45,
    )
    cues = [
        {
            "id": "cue-1",
            "text": "Guten Morgen!",
            "context_before": None,
            "context_after": "Wie geht es dir?",
        },
        {
            "id": "cue-2",
            "text": "Bis später.",
            "context_before": "Guten Morgen!",
            "context_after": None,
        },
    ]

    assert await provider.translate_batch(cues) == [
        "English: Guten Morgen!",
        "English: Bis später.",
    ]
    assert codex.calls == [
        {
            "cues": cues,
            "source_language": "de",
            "target_language": "en",
            "model": "gpt-5.6-luna",
            "effort": "low",
            "timeout_seconds": 45,
        }
    ]


@pytest.mark.anyio
async def test_codex_provider_accepts_a_catalog_selected_model() -> None:
    codex = FakeCodex()
    provider = CodexTranslationProvider(codex=codex)  # type: ignore[arg-type]
    cues = [{"id": "cue-1", "text": "Hallo", "context_before": None, "context_after": None}]

    await provider.translate_batch(
        cues,
        model="gpt-5.6-sol",
        effort="max",
    )

    assert codex.calls[0]["model"] == "gpt-5.6-sol"
    assert codex.calls[0]["effort"] == "max"


@pytest.mark.anyio
async def test_codex_provider_bisects_only_a_malformed_large_batch() -> None:
    class SizeSensitiveCodex(FakeCodex):
        async def translate_subtitles(self, **values: object) -> list[str]:
            self.calls.append(values)
            cues = values["cues"]
            assert isinstance(cues, list)
            if len(cues) > 2:
                raise CodexTranslationResponseError("Malformed structured output.")
            return [f"English: {cue['text']}" for cue in cues]

    codex = SizeSensitiveCodex()
    provider = CodexTranslationProvider(codex=codex)  # type: ignore[arg-type]
    cues = [
        {
            "id": f"site-cue-{index}",
            "text": f"Zeile {index}",
            "context_before": None,
            "context_after": None,
        }
        for index in range(5)
    ]

    assert await provider.translate_batch(cues) == [
        f"English: Zeile {index}" for index in range(5)
    ]
    assert len(codex.calls[0]["cues"]) == 5
    assert all(len(call["cues"]) <= 3 for call in codex.calls[1:])


@pytest.mark.anyio
async def test_codex_provider_retries_a_single_malformed_priority_cue_once() -> None:
    class RetryOnceCodex(FakeCodex):
        async def translate_subtitles(self, **values: object) -> list[str]:
            self.calls.append(values)
            if len(self.calls) == 1:
                raise CodexTranslationResponseError("Malformed structured output.")
            cues = values["cues"]
            assert isinstance(cues, list)
            return [f"English: {cue['text']}" for cue in cues]

    codex = RetryOnceCodex()
    provider = CodexTranslationProvider(codex=codex)  # type: ignore[arg-type]

    assert await provider.translate("Hallo") == "English: Hallo"
    assert len(codex.calls) == 2


@pytest.mark.anyio
@pytest.mark.parametrize(
    "error",
    [
        CodexAuthenticationError("Connect ChatGPT first."),
        CodexUnavailableError("Codex timed out."),
    ],
)
async def test_codex_provider_reports_errors_instead_of_falling_back(
    error: Exception,
) -> None:
    provider = CodexTranslationProvider(
        codex=FakeCodex(error=error),  # type: ignore[arg-type]
    )

    with pytest.raises(TranslationError, match=str(error)):
        await provider.translate("Guten Morgen!")


@pytest.mark.anyio
async def test_codex_provider_health_requires_an_authenticated_account() -> None:
    connected = CodexTranslationProvider(
        codex=FakeCodex(authenticated=True),  # type: ignore[arg-type]
    )
    disconnected = CodexTranslationProvider(
        codex=FakeCodex(authenticated=False),  # type: ignore[arg-type]
    )

    assert await connected.health() == (True, True)
    assert await disconnected.health() == (True, False)
