from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest

from polyglot_maxxing.codex import (
    CodexEnricher,
    CodexTranslationResponseError,
    parse_translation_batch,
    parse_word_insights,
    translation_batch_output_schema,
)


def test_parses_id_addressed_subtitle_translation_json() -> None:
    content = (
        '```json\n{"translations":['
        '{"id":"cue-2","translation":"Bis später."},'
        '{"id":"cue-1","translation":"Guten Morgen."}'
        ']}\n```'
    )

    assert parse_translation_batch(content, ["cue-1", "cue-2"]) == [
        "Guten Morgen.",
        "Bis später.",
    ]


def test_ignores_duplicate_translation_items_when_all_ids_are_present() -> None:
    content = (
        '{"translations":['
        '{"id":"cue-1","translation":"Guten Morgen."},'
        '{"id":"cue-1","translation":"Good morning."},'
        '{"id":"cue-2","translation":"Bis später."}'
        "]}"
    )

    assert parse_translation_batch(content, ["cue-1", "cue-2"]) == [
        "Guten Morgen.",
        "Bis später.",
    ]


def test_rejects_a_translation_batch_with_a_missing_id() -> None:
    with pytest.raises(CodexTranslationResponseError, match="requested cues"):
        parse_translation_batch(
            '{"translations":[{"id":"cue-0","translation":"Hallo"}]}',
            ["cue-0", "cue-1"],
        )


def test_translation_schema_constrains_batch_size_and_synthetic_ids() -> None:
    schema = translation_batch_output_schema(["cue-0", "cue-1"])
    translations = schema["properties"]["translations"]

    assert translations["minItems"] == 2
    assert translations["maxItems"] == 2
    assert translations["items"]["properties"]["id"]["enum"] == [
        "cue-0",
        "cue-1",
    ]


def test_parses_all_word_insights_from_one_structured_response() -> None:
    assert parse_word_insights(
        '{"explain":"Used as else.","examples":"Noch jemand? — Anyone else?",'
        '"grammar":"Adverb."}'
    ) == {
        "explain": "Used as else.",
        "examples": "Noch jemand? — Anyone else?",
        "grammar": "Adverb.",
    }


class BlockingTurn:
    id = "turn-test"

    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.interrupted = False

    async def stream(self):
        self.started.set()
        await asyncio.Event().wait()
        if False:
            yield None

    async def interrupt(self) -> None:
        self.interrupted = True


class StreamingTurn(BlockingTurn):
    def __init__(self, chunks: list[str]) -> None:
        super().__init__()
        self.chunks = chunks

    async def stream(self):
        from openai_codex.generated.v2_all import AgentMessageDeltaNotification

        self.started.set()
        for chunk in self.chunks:
            yield SimpleNamespace(
                payload=AgentMessageDeltaNotification(
                    delta=chunk,
                    itemId="item-test",
                    threadId="thread-test",
                    turnId=self.id,
                )
            )


class FakeThread:
    def __init__(self, turn: BlockingTurn) -> None:
        self.turn_handle = turn

    async def turn(self, *_args: object, **_kwargs: object) -> BlockingTurn:
        return self.turn_handle


class FakeClient:
    def __init__(self, turn: BlockingTurn) -> None:
        self.thread = FakeThread(turn)
        self.logged_out = False
        self.model_calls = 0
        self.login_handle = SimpleNamespace(
            login_id="login-test",
            verification_url="https://auth.openai.test/device",
            user_code="ABCD-EFGH",
        )

        async def wait() -> object:
            return SimpleNamespace(success=True, error=None)

        async def cancel() -> object:
            return SimpleNamespace(status="cancelled")

        self.login_handle.wait = wait
        self.login_handle.cancel = cancel

    async def account(self, *, refresh_token: bool) -> object:
        assert refresh_token is False
        root = SimpleNamespace(
            type="chatgpt",
            email="learner@example.com",
            plan_type="pro",
        )
        return SimpleNamespace(account=SimpleNamespace(root=root))

    async def login_chatgpt_device_code(self) -> object:
        return self.login_handle

    async def logout(self) -> None:
        self.logged_out = True

    async def models(self, *, include_hidden: bool = False) -> object:
        assert include_hidden is False
        self.model_calls += 1
        effort = lambda value: SimpleNamespace(  # noqa: E731
            reasoning_effort=SimpleNamespace(value=value)
        )
        return SimpleNamespace(
            data=[
                SimpleNamespace(
                    id="gpt-5.6-luna",
                    model="gpt-5.6-luna",
                    display_name="GPT-5.6-Luna",
                    description="Fast model",
                    is_default=False,
                    hidden=False,
                    default_reasoning_effort=SimpleNamespace(value="medium"),
                    supported_reasoning_efforts=[
                        effort("low"),
                        effort("medium"),
                        effort("high"),
                    ],
                )
            ]
        )

    async def thread_start(self, **_kwargs: object) -> FakeThread:
        return self.thread

    async def close(self) -> None:
        return None


def test_cancelling_a_stream_interrupts_the_active_codex_turn(tmp_path: Path) -> None:
    async def scenario() -> None:
        turn = BlockingTurn()
        enricher = CodexEnricher(
            enabled=True,
            codex_home=tmp_path / "codex",
            concurrency=2,
        )
        enricher._client = FakeClient(turn)  # type: ignore[assignment]

        async def consume() -> None:
            await enricher.enrich_bundle(
                word="werden",
                lemma="werden",
                context="Ich möchte Arzt werden.",
                context_translation="I want to become a doctor.",
                pos="VERB",
                morphology={"VerbForm": "Inf"},
                meanings=["to become"],
                model="gpt-5.6-luna",
                effort="low",
            )

        task = asyncio.create_task(consume())
        await turn.started.wait()
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

        assert turn.interrupted is True
        await enricher.close()

    asyncio.run(scenario())


def test_forwards_word_insight_deltas_before_parsing_the_final_bundle(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        chunks = [
            '{"explain":"Used as else.",',
            '"examples":"Noch jemand? — Anyone else?",',
            '"grammar":"Adverb."}',
        ]
        turn = StreamingTurn(chunks)
        enricher = CodexEnricher(enabled=True, codex_home=tmp_path / "codex")
        enricher._client = FakeClient(turn)  # type: ignore[assignment]
        received: list[str] = []

        async def capture(delta: str) -> None:
            received.append(delta)

        result = await enricher.enrich_bundle(
            word="noch",
            lemma="noch",
            context="Ist noch jemand da?",
            context_translation="Is anyone else there?",
            pos="ADV",
            morphology={},
            meanings=["else"],
            model="gpt-5.6-luna",
            effort="low",
            on_delta=capture,
        )

        assert received == chunks
        assert result["grammar"] == "Adverb."
        await enricher.close()

    asyncio.run(scenario())


def test_returns_live_model_catalog_with_reasoning_options(tmp_path: Path) -> None:
    async def scenario() -> None:
        enricher = CodexEnricher(enabled=True, codex_home=tmp_path / "codex")
        enricher._client = FakeClient(BlockingTurn())  # type: ignore[assignment]

        models = await enricher.models()

        assert models == [
            {
                "id": "gpt-5.6-luna",
                "model": "gpt-5.6-luna",
                "display_name": "GPT-5.6-Luna",
                "description": "Fast model",
                "is_default": False,
                "default_reasoning_effort": "medium",
                "supported_reasoning_efforts": ["low", "medium", "high"],
            }
        ]
        await enricher.close()

    asyncio.run(scenario())


def test_reports_account_identity_and_can_switch_accounts(tmp_path: Path) -> None:
    async def scenario() -> None:
        client = FakeClient(BlockingTurn())
        enricher = CodexEnricher(enabled=True, codex_home=tmp_path / "codex")
        enricher._client = client  # type: ignore[assignment]

        status = await enricher.status()
        await enricher.models()
        login = await enricher.switch_account()
        await enricher.models()

        assert status["email"] == "learner@example.com"
        assert status["plan_type"] == "pro"
        assert client.logged_out is True
        assert client.model_calls == 2
        assert login == {
            "login_id": "login-test",
            "verification_url": "https://auth.openai.test/device",
            "user_code": "ABCD-EFGH",
        }
        await enricher.close()

    asyncio.run(scenario())


def test_prompts_keep_common_tutor_answers_short(tmp_path: Path) -> None:
    enricher = CodexEnricher(enabled=True, codex_home=tmp_path / "codex")

    prompt = enricher._bundle_prompt(
        word="werden",
        lemma="werden",
        context="Ich möchte Arzt werden.",
        context_translation="I want to become a doctor.",
        pos="VERB",
        morphology={},
        meanings=["to become"],
    )

    assert "all three tutor sections" in prompt
    assert "at most 70 words" in prompt
    assert "up to 5 distinct German examples" in prompt
    assert "at most 90" in prompt
