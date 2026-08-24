from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from polyglot_maxxing.app import create_app
from polyglot_maxxing.config import Settings
from polyglot_maxxing.database import Database


class FakeTranslator:
    provider_name = "fake"
    model_name = "codex-test"

    def __init__(self) -> None:
        self.calls: list[str] = []

    async def translate(
        self,
        text: str,
        source_language: str = "de",
        target_language: str = "en",
        *,
        context_before: str | None = None,
        context_after: str | None = None,
    ) -> str:
        self.calls.append(text)
        return f"English: {text}"

    async def health(self) -> tuple[bool, bool]:
        return True, True

    async def close(self) -> None:
        return None


class BatchFakeTranslator(FakeTranslator):
    def __init__(self) -> None:
        super().__init__()
        self.batch_calls: list[list[dict[str, str | None]]] = []
        self.batch_models: list[tuple[str | None, str | None]] = []

    async def translate_batch(
        self,
        cues: list[dict[str, str | None]],
        source_language: str = "de",
        target_language: str = "en",
        *,
        model: str | None = None,
        effort: str | None = None,
    ) -> list[str]:
        self.batch_calls.append(cues)
        self.batch_models.append((model, effort))
        return [f"English: {cue['text']}" for cue in cues]


class FakeCodex:
    def __init__(self) -> None:
        self.calls: list[dict[str, object]] = []
        self.logged_out = False

    async def status(self) -> dict[str, object]:
        return {
            "available": True,
            "authenticated": True,
            "auth_mode": "chatgpt",
            "email": "learner@example.com",
            "plan_type": "plus",
            "login_pending": False,
        }

    async def models(self) -> list[dict[str, object]]:
        return [
            {
                "id": "gpt-5.6-luna",
                "model": "gpt-5.6-luna",
                "display_name": "GPT-5.6-Luna",
                "description": "Fast model",
                "is_default": True,
                "default_reasoning_effort": "medium",
                "supported_reasoning_efforts": ["low", "medium", "high"],
            }
        ]

    async def logout(self) -> None:
        self.logged_out = True

    async def switch_account(self) -> dict[str, str]:
        self.logged_out = True
        return {
            "login_id": "login-test",
            "verification_url": "https://auth.openai.test/device",
            "user_code": "ABCD-EFGH",
        }

    async def enrich_bundle(self, **values: object) -> dict[str, str]:
        on_delta = values.pop("on_delta", None)
        self.calls.append(values)
        insights = {
            "explain": '“noch” means “else” in this question.',
            "examples": "Ist noch jemand da? — Is anyone else there?",
            "grammar": '“noch” is an adverb here.',
        }
        if callable(on_delta):
            content = json.dumps(insights, ensure_ascii=False)
            for offset in range(0, len(content), 23):
                await on_delta(content[offset : offset + 23])
        return insights

    async def close(self) -> None:
        return None


def settings(path: Path) -> Settings:
    return Settings(database_path=path, enable_stanza=False)


def test_shows_disconnects_and_switches_codex_account(tmp_path: Path) -> None:
    translator = FakeTranslator()
    codex = FakeCodex()
    database = Database(tmp_path / "test.db")
    app = create_app(
        settings(tmp_path / "test.db"),
        translator=translator,
        database=database,
        codex=codex,  # type: ignore[arg-type]
    )

    with TestClient(app) as client:
        account = client.get("/v1/codex/status")
        disconnected = client.post("/v1/codex/logout")
        switched = client.post("/v1/codex/login/switch")

    assert account.json()["email"] == "learner@example.com"
    assert account.json()["planType"] == "plus"
    assert disconnected.json() == {"disconnected": True}
    assert switched.json()["userCode"] == "ABCD-EFGH"
    assert codex.logged_out is True


def test_processes_and_caches_subtitle_cues(tmp_path: Path) -> None:
    translator = FakeTranslator()
    database = Database(tmp_path / "test.db")
    app = create_app(settings(tmp_path / "test.db"), translator=translator, database=database)
    payload = {
        "sourceLanguage": "de",
        "targetLanguage": "en",
        "cues": [
            {"id": "cue-1", "start": 1.2, "end": 3.4, "text": "Guten Morgen!"}
        ],
    }

    with TestClient(app) as client:
        first = client.post("/v1/cues/process", json=payload)
        second = client.post("/v1/cues/process", json=payload)

    assert first.status_code == 200
    assert first.json()["cues"][0]["translation"] == "English: Guten Morgen!"
    assert first.json()["cues"][0]["tokens"][0]["lemma"] == "guten"
    assert second.status_code == 200
    assert translator.calls == ["Guten Morgen!"]


def test_sends_twenty_four_cues_as_one_provider_batch(tmp_path: Path) -> None:
    translator = BatchFakeTranslator()
    database = Database(tmp_path / "test.db")
    app = create_app(settings(tmp_path / "test.db"), translator=translator, database=database)
    cues = [
        {
            "id": f"cue-{index}",
            "start": float(index),
            "end": float(index + 1),
            "text": f"Deutsche Zeile {index}",
        }
        for index in range(24)
    ]

    with TestClient(app) as client:
        response = client.post(
            "/v1/cues/process",
            json={
                "sourceLanguage": "de",
                "targetLanguage": "en",
                "model": "gpt-5.6-sol",
                "effort": "max",
                "cues": cues,
            },
        )

    assert response.status_code == 200
    assert len(response.json()["cues"]) == 24
    assert len(translator.batch_calls) == 1
    assert len(translator.batch_calls[0]) == 24
    assert translator.batch_models == [("gpt-5.6-sol", "max")]
    assert response.json()["model"] == "gpt-5.6-sol"
    assert translator.calls == []


def test_saves_a_lemma_and_deduplicates_occurrences(tmp_path: Path) -> None:
    translator = FakeTranslator()
    database = Database(tmp_path / "test.db")
    app = create_app(settings(tmp_path / "test.db"), translator=translator, database=database)
    payload = {
        "surface": "gesagt",
        "lemma": "sagen",
        "pos": "VERB",
        "meaning": "to say",
        "germanSentence": "Ich habe es gesagt.",
        "englishSentence": "I said it.",
        "videoUrl": "https://example.test/video",
        "episodeId": "episode-1",
        "cueId": "cue-10",
        "cueStart": 42.5,
    }

    with TestClient(app) as client:
        first = client.post("/v1/saved-words", json=payload)
        duplicate = client.post("/v1/saved-words", json=payload)
        words = client.get("/v1/saved-words")

    assert first.status_code == 200
    assert duplicate.status_code == 200
    assert words.status_code == 200
    assert words.json()[0]["lemma"] == "sagen"
    assert words.json()[0]["occurrenceCount"] == 1
    assert words.json()[0]["learningStage"] == "learning"


def test_toggles_updates_and_deletes_a_saved_word(tmp_path: Path) -> None:
    translator = FakeTranslator()
    database = Database(tmp_path / "test.db")
    app = create_app(settings(tmp_path / "test.db"), translator=translator, database=database)
    payload = {
        "surface": "Wörter",
        "lemma": "Wort",
        "pos": "NOUN",
        "meaning": "word",
        "meanings": ["word", "term"],
        "morphology": {"Number": "Plur"},
        "germanSentence": "Das sind wichtige Wörter.",
        "englishSentence": "Those are important words.",
        "videoUrl": "https://www.zdf.de/play/example",
        "episodeId": "episode-2",
        "cueId": "cue-20",
        "cueStart": 12.0,
    }

    with TestClient(app) as client:
        first = client.post("/v1/saved-words/toggle-stage", json=payload)
        second = client.post("/v1/saved-words/toggle-stage", json=payload)
        third = client.post("/v1/saved-words/toggle-stage", json=payload)
        ignored = client.patch(
            f"/v1/saved-words/{first.json()['id']}",
            json={"learningStage": "ignored"},
        )
        invalid = client.patch(
            f"/v1/saved-words/{first.json()['id']}",
            json={"learningStage": "invalid"},
        )
        deleted = client.delete(f"/v1/saved-words/{first.json()['id']}")
        missing = client.get("/v1/saved-words")

    assert first.json()["learningStage"] == "learning"
    assert second.json()["learningStage"] == "known"
    assert third.json()["learningStage"] == "learning"
    assert ignored.json()["learningStage"] == "ignored"
    assert ignored.json()["meanings"] == ["word", "term"]
    assert ignored.json()["morphology"] == {"Number": "Plur"}
    assert invalid.status_code == 422
    assert deleted.status_code == 204
    assert missing.json() == []


def test_migrates_existing_saved_word_database(tmp_path: Path) -> None:
    database_path = tmp_path / "legacy.db"
    import sqlite3

    connection = sqlite3.connect(database_path)
    connection.execute(
        """
        CREATE TABLE saved_words (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            surface TEXT NOT NULL,
            lemma TEXT NOT NULL COLLATE NOCASE,
            pos TEXT NOT NULL DEFAULT '',
            meaning TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(lemma, pos)
        )
        """
    )
    connection.commit()
    connection.close()

    database = Database(database_path)
    columns = {
        row["name"]
        for row in database._connection.execute("PRAGMA table_info(saved_words)").fetchall()
    }
    database.close()

    assert {
        "learning_stage",
        "meanings_json",
        "morphology_json",
        "source_language",
        "target_language",
    } <= columns


def test_keeps_same_lemma_separate_across_learning_languages(tmp_path: Path) -> None:
    database = Database(tmp_path / "languages.db")
    common = {
        "surface": "Gift",
        "lemma": "Gift",
        "pos": "NOUN",
        "meaning": "meaning",
        "meanings": [],
        "morphology": {},
        "germanSentence": "Gift",
        "englishSentence": "meaning",
        "videoUrl": "https://example.test/video",
        "episodeId": "episode",
        "cueStart": 1.0,
    }
    app = create_app(
        settings(tmp_path / "languages.db"),
        translator=FakeTranslator(),
        database=database,
    )
    with TestClient(app) as client:
        german = client.post(
            "/v1/saved-words",
            json={
                **common,
                "cueId": "de-cue",
                "sourceLanguage": "de",
                "targetLanguage": "en",
            },
        )
        english = client.post(
            "/v1/saved-words",
            json={
                **common,
                "cueId": "en-cue",
                "sourceLanguage": "en",
                "targetLanguage": "de",
            },
        )
        words = client.get("/v1/saved-words")

    assert german.status_code == 200
    assert english.status_code == 200
    assert german.json()["id"] != english.json()["id"]
    assert {word["sourceLanguage"] for word in words.json()} == {"de", "en"}


def test_generates_and_caches_contextual_word_insight(tmp_path: Path) -> None:
    translator = FakeTranslator()
    codex = FakeCodex()
    database = Database(tmp_path / "test.db")
    app = create_app(
        settings(tmp_path / "test.db"),
        translator=translator,
        database=database,
        codex=codex,  # type: ignore[arg-type]
    )
    payload = {
        "word": "noch",
        "lemma": "noch",
        "context": "Ist noch jemand da?",
        "contextTranslation": "Is anyone else there?",
        "pos": "ADV",
        "morphology": {},
        "meanings": ["still", "else"],
        "model": "gpt-5.6-luna",
        "effort": "low",
    }

    with TestClient(app) as client:
        status = client.get("/v1/codex/status")
        models = client.get("/v1/codex/models")
        first = client.post("/v1/words/insight", json=payload)
        second = client.post("/v1/words/insight", json=payload)

    assert status.status_code == 200
    assert status.json()["authenticated"] is True
    assert models.status_code == 200
    assert models.json()["models"][0] == {
        "id": "gpt-5.6-luna",
        "model": "gpt-5.6-luna",
        "displayName": "GPT-5.6-Luna",
        "description": "Fast model",
        "isDefault": True,
        "defaultReasoningEffort": "medium",
        "supportedReasoningEfforts": ["low", "medium", "high"],
    }
    assert first.status_code == 200
    assert first.json()["cached"] is False
    assert first.json()["insights"] == {
        "explain": '“noch” means “else” in this question.',
        "examples": "Ist noch jemand da? — Is anyone else there?",
        "grammar": '“noch” is an adverb here.',
    }
    assert second.json()["cached"] is True
    assert len(codex.calls) == 1


def test_streams_and_caches_contextual_word_insight(tmp_path: Path) -> None:
    translator = FakeTranslator()
    codex = FakeCodex()
    database = Database(tmp_path / "test.db")
    app = create_app(
        settings(tmp_path / "test.db"),
        translator=translator,
        database=database,
        codex=codex,  # type: ignore[arg-type]
    )
    payload = {
        "word": "noch",
        "lemma": "noch",
        "context": "Ist noch jemand da?",
        "contextTranslation": "Is anyone else there?",
        "pos": "ADV",
        "morphology": {},
        "meanings": ["still", "else"],
        "model": "gpt-5.6-luna",
        "effort": "low",
    }

    with TestClient(app) as client:
        first = client.post("/v1/words/insight/stream", json=payload)
        second = client.post("/v1/words/insight/stream", json=payload)

    first_events = [json.loads(line) for line in first.text.splitlines()]
    second_events = [json.loads(line) for line in second.text.splitlines()]
    assert first_events[0]["type"] == "delta"
    assert first_events[-1]["type"] == "done"
    assert "".join(event["delta"] for event in first_events[:-1]).startswith('{"explain"')
    assert first_events[-1]["cached"] is False
    assert first_events[-1]["insights"]["examples"].startswith("Ist noch")
    assert [event["type"] for event in second_events] == ["done"]
    assert second_events[0]["cached"] is True
    assert second_events[0]["insights"] == first_events[-1]["insights"]
    assert len(codex.calls) == 1
