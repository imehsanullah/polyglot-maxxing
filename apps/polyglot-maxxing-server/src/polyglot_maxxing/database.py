from __future__ import annotations

import json
import sqlite3
import threading
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from .models import LearningStage, SavedWordInput


SCHEMA = """
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS translation_cache (
    cache_key TEXT PRIMARY KEY,
    model TEXT NOT NULL,
    source_language TEXT NOT NULL,
    target_language TEXT NOT NULL,
    source_text TEXT NOT NULL,
    translation TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS word_insight_cache (
    cache_key TEXT PRIMARY KEY,
    model TEXT NOT NULL,
    effort TEXT NOT NULL,
    kind TEXT NOT NULL,
    word TEXT NOT NULL,
    context TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS dictionary_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lemma TEXT NOT NULL COLLATE NOCASE,
    pos TEXT NOT NULL DEFAULT '',
    meanings_json TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    UNIQUE(lemma, pos, meanings_json)
);

CREATE INDEX IF NOT EXISTS dictionary_entries_lemma_idx
    ON dictionary_entries(lemma COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS dictionary_sources (
    name TEXT PRIMARY KEY,
    version TEXT NOT NULL,
    source_url TEXT NOT NULL,
    license TEXT NOT NULL,
    installed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS saved_words (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    surface TEXT NOT NULL,
    lemma TEXT NOT NULL COLLATE NOCASE,
    pos TEXT NOT NULL DEFAULT '',
    meaning TEXT,
    meanings_json TEXT NOT NULL DEFAULT '[]',
    morphology_json TEXT NOT NULL DEFAULT '{}',
    source_language TEXT NOT NULL DEFAULT 'de',
    target_language TEXT NOT NULL DEFAULT 'en',
    learning_stage TEXT NOT NULL DEFAULT 'learning'
        CHECK(learning_stage IN ('learning', 'known', 'ignored')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(lemma, pos, source_language)
);

CREATE TABLE IF NOT EXISTS saved_word_occurrences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    saved_word_id INTEGER NOT NULL REFERENCES saved_words(id) ON DELETE CASCADE,
    german_sentence TEXT NOT NULL,
    english_sentence TEXT NOT NULL DEFAULT '',
    source_language TEXT NOT NULL DEFAULT 'de',
    target_language TEXT NOT NULL DEFAULT 'en',
    video_url TEXT NOT NULL,
    episode_id TEXT NOT NULL,
    cue_id TEXT NOT NULL,
    cue_start REAL NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(saved_word_id, episode_id, cue_id)
);
"""


class Database:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self._lock = threading.RLock()
        self._connection = sqlite3.connect(path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        with self._lock:
            self._connection.executescript(SCHEMA)
            dictionary_columns = {
                row["name"]
                for row in self._connection.execute(
                    "PRAGMA table_info(dictionary_entries)"
                ).fetchall()
            }
            if "source" not in dictionary_columns:
                self._connection.execute(
                    "ALTER TABLE dictionary_entries ADD COLUMN source TEXT NOT NULL DEFAULT ''"
                )
            saved_word_columns = {
                row["name"]
                for row in self._connection.execute(
                    "PRAGMA table_info(saved_words)"
                ).fetchall()
            }
            if "learning_stage" not in saved_word_columns:
                self._connection.execute(
                    "ALTER TABLE saved_words ADD COLUMN learning_stage TEXT NOT NULL DEFAULT 'learning'"
                )
            if "meanings_json" not in saved_word_columns:
                self._connection.execute(
                    "ALTER TABLE saved_words ADD COLUMN meanings_json TEXT NOT NULL DEFAULT '[]'"
                )
            if "morphology_json" not in saved_word_columns:
                self._connection.execute(
                    "ALTER TABLE saved_words ADD COLUMN morphology_json TEXT NOT NULL DEFAULT '{}'"
                )
            if "source_language" not in saved_word_columns:
                self._connection.commit()
                self._migrate_saved_word_language_schema()
            occurrence_columns = {
                row["name"]
                for row in self._connection.execute(
                    "PRAGMA table_info(saved_word_occurrences)"
                ).fetchall()
            }
            if "source_language" not in occurrence_columns:
                self._connection.execute(
                    "ALTER TABLE saved_word_occurrences ADD COLUMN source_language TEXT NOT NULL DEFAULT 'de'"
                )
            if "target_language" not in occurrence_columns:
                self._connection.execute(
                    "ALTER TABLE saved_word_occurrences ADD COLUMN target_language TEXT NOT NULL DEFAULT 'en'"
                )
            self._connection.commit()

    def _migrate_saved_word_language_schema(self) -> None:
        """Add language identity while preserving legacy word IDs and occurrences."""
        occurrence_columns = {
            row["name"]
            for row in self._connection.execute(
                "PRAGMA table_info(saved_word_occurrences)"
            ).fetchall()
        }
        source_expression = (
            "source_language" if "source_language" in occurrence_columns else "'de'"
        )
        target_expression = (
            "target_language" if "target_language" in occurrence_columns else "'en'"
        )
        self._connection.execute("PRAGMA foreign_keys = OFF")
        try:
            self._connection.executescript(
                f"""
                BEGIN;
                ALTER TABLE saved_word_occurrences
                    RENAME TO saved_word_occurrences_legacy;
                ALTER TABLE saved_words RENAME TO saved_words_legacy;

                CREATE TABLE saved_words (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    surface TEXT NOT NULL,
                    lemma TEXT NOT NULL COLLATE NOCASE,
                    pos TEXT NOT NULL DEFAULT '',
                    meaning TEXT,
                    meanings_json TEXT NOT NULL DEFAULT '[]',
                    morphology_json TEXT NOT NULL DEFAULT '{{}}',
                    source_language TEXT NOT NULL DEFAULT 'de',
                    target_language TEXT NOT NULL DEFAULT 'en',
                    learning_stage TEXT NOT NULL DEFAULT 'learning'
                        CHECK(learning_stage IN ('learning', 'known', 'ignored')),
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(lemma, pos, source_language)
                );
                INSERT INTO saved_words(
                    id, surface, lemma, pos, meaning, meanings_json,
                    morphology_json, source_language, target_language,
                    learning_stage, created_at, updated_at
                )
                SELECT
                    id, surface, lemma, pos, meaning, meanings_json,
                    morphology_json, 'de', 'en', learning_stage,
                    created_at, updated_at
                FROM saved_words_legacy;

                CREATE TABLE saved_word_occurrences (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    saved_word_id INTEGER NOT NULL
                        REFERENCES saved_words(id) ON DELETE CASCADE,
                    german_sentence TEXT NOT NULL,
                    english_sentence TEXT NOT NULL DEFAULT '',
                    video_url TEXT NOT NULL,
                    episode_id TEXT NOT NULL,
                    cue_id TEXT NOT NULL,
                    cue_start REAL NOT NULL,
                    source_language TEXT NOT NULL DEFAULT 'de',
                    target_language TEXT NOT NULL DEFAULT 'en',
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(saved_word_id, episode_id, cue_id)
                );
                INSERT INTO saved_word_occurrences(
                    id, saved_word_id, german_sentence, english_sentence,
                    video_url, episode_id, cue_id, cue_start,
                    source_language, target_language, created_at
                )
                SELECT
                    id, saved_word_id, german_sentence, english_sentence,
                    video_url, episode_id, cue_id, cue_start,
                    {source_expression}, {target_expression}, created_at
                FROM saved_word_occurrences_legacy;

                DROP TABLE saved_word_occurrences_legacy;
                DROP TABLE saved_words_legacy;
                COMMIT;
                """
            )
        except Exception:
            self._connection.execute("ROLLBACK")
            raise
        finally:
            self._connection.execute("PRAGMA foreign_keys = ON")

    def close(self) -> None:
        with self._lock:
            self._connection.close()

    def get_cached_translation(self, cache_key: str) -> str | None:
        with self._lock:
            row = self._connection.execute(
                "SELECT translation FROM translation_cache WHERE cache_key = ?",
                (cache_key,),
            ).fetchone()
        return str(row["translation"]) if row else None

    def put_cached_translation(
        self,
        *,
        cache_key: str,
        model: str,
        source_language: str,
        target_language: str,
        source_text: str,
        translation: str,
    ) -> None:
        with self._lock:
            self._connection.execute(
                """
                INSERT INTO translation_cache(
                    cache_key, model, source_language, target_language,
                    source_text, translation
                ) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(cache_key) DO UPDATE SET
                    translation = excluded.translation,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (
                    cache_key,
                    model,
                    source_language,
                    target_language,
                    source_text,
                    translation,
                ),
            )
            self._connection.commit()

    def get_cached_word_insight(self, cache_key: str) -> str | None:
        with self._lock:
            row = self._connection.execute(
                "SELECT content FROM word_insight_cache WHERE cache_key = ?",
                (cache_key,),
            ).fetchone()
        return str(row["content"]) if row else None

    def put_cached_word_insight(
        self,
        *,
        cache_key: str,
        model: str,
        effort: str,
        kind: str,
        word: str,
        context: str,
        content: str,
    ) -> None:
        with self._lock:
            self._connection.execute(
                """
                INSERT INTO word_insight_cache(
                    cache_key, model, effort, kind, word, context, content
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(cache_key) DO UPDATE SET
                    content = excluded.content,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (cache_key, model, effort, kind, word, context, content),
            )
            self._connection.commit()

    def dictionary_meanings(self, lemma: str, pos: str = "") -> list[str]:
        with self._lock:
            rows = self._connection.execute(
                """
                SELECT meanings_json
                FROM dictionary_entries
                WHERE lemma = ? COLLATE NOCASE
                ORDER BY CASE WHEN lower(pos) = lower(?) THEN 0 ELSE 1 END, id
                LIMIT 3
                """,
                (lemma, pos),
            ).fetchall()
            if not rows:
                rows = self._connection.execute(
                    """
                    SELECT meanings_json
                    FROM dictionary_entries
                    WHERE lemma LIKE ? COLLATE NOCASE
                    ORDER BY CASE WHEN lower(pos) = lower(?) THEN 0 ELSE 1 END, id
                    LIMIT 3
                    """,
                    (f"{lemma} %", pos),
                ).fetchall()
        meanings: list[str] = []
        for row in rows:
            for meaning in json.loads(row["meanings_json"]):
                if meaning not in meanings:
                    meanings.append(meaning)
                if len(meanings) >= 5:
                    return meanings
        return meanings

    def insert_dictionary_entries(
        self,
        entries: Iterable[tuple[str, str, list[str]]],
        *,
        source: str = "",
    ) -> int:
        rows = [
            (lemma, pos, json.dumps(meanings, ensure_ascii=False), source)
            for lemma, pos, meanings in entries
            if lemma and meanings
        ]
        if not rows:
            return 0
        with self._lock:
            before = self._connection.total_changes
            self._connection.executemany(
                """
                INSERT OR IGNORE INTO dictionary_entries(lemma, pos, meanings_json, source)
                VALUES (?, ?, ?, ?)
                """,
                rows,
            )
            self._connection.commit()
            return self._connection.total_changes - before

    def delete_dictionary_source(self, source: str) -> int:
        with self._lock:
            before = self._connection.total_changes
            self._connection.execute(
                "DELETE FROM dictionary_entries WHERE source = ?", (source,)
            )
            self._connection.commit()
            return self._connection.total_changes - before

    def record_dictionary_source(
        self, *, name: str, version: str, source_url: str, license_name: str
    ) -> None:
        with self._lock:
            self._connection.execute(
                """
                INSERT INTO dictionary_sources(name, version, source_url, license)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET
                    version = excluded.version,
                    source_url = excluded.source_url,
                    license = excluded.license,
                    installed_at = CURRENT_TIMESTAMP
                """,
                (name, version, source_url, license_name),
            )
            self._connection.commit()

    def save_word(self, word: SavedWordInput) -> dict[str, Any]:
        with self._lock:
            self._connection.execute(
                """
                INSERT INTO saved_words(
                    surface, lemma, pos, meaning, meanings_json, morphology_json,
                    source_language, target_language
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT DO UPDATE SET
                    surface = excluded.surface,
                    meaning = COALESCE(excluded.meaning, saved_words.meaning),
                    meanings_json = CASE
                        WHEN excluded.meanings_json != '[]' THEN excluded.meanings_json
                        ELSE saved_words.meanings_json
                    END,
                    morphology_json = CASE
                        WHEN excluded.morphology_json != '{}' THEN excluded.morphology_json
                        ELSE saved_words.morphology_json
                    END,
                    target_language = excluded.target_language,
                    updated_at = CURRENT_TIMESTAMP
                """,
                (
                    word.surface,
                    word.lemma,
                    word.pos,
                    word.meaning,
                    json.dumps(word.meanings, ensure_ascii=False),
                    json.dumps(word.morphology, ensure_ascii=False, sort_keys=True),
                    word.source_language,
                    word.target_language,
                ),
            )
            saved_word_id = self._connection.execute(
                """SELECT id FROM saved_words
                WHERE lemma = ? COLLATE NOCASE AND pos = ? AND source_language = ?""",
                (word.lemma, word.pos, word.source_language),
            ).fetchone()["id"]
            self._connection.execute(
                """
                INSERT OR IGNORE INTO saved_word_occurrences(
                    saved_word_id, german_sentence, english_sentence, video_url,
                    episode_id, cue_id, cue_start, source_language, target_language
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    saved_word_id,
                    word.german_sentence,
                    word.english_sentence,
                    word.video_url,
                    word.episode_id,
                    word.cue_id,
                    word.cue_start,
                    word.source_language,
                    word.target_language,
                ),
            )
            self._connection.commit()
        return self.get_saved_word(saved_word_id)

    def toggle_word_stage(self, word: SavedWordInput) -> dict[str, Any]:
        """Save an unseen word, otherwise toggle it between learning and known."""
        with self._lock:
            existing = self._connection.execute(
                """SELECT id, learning_stage FROM saved_words
                WHERE lemma = ? COLLATE NOCASE AND pos = ? AND source_language = ?""",
                (word.lemma, word.pos, word.source_language),
            ).fetchone()
            saved = self.save_word(word)
            if existing:
                next_stage = "known" if existing["learning_stage"] != "known" else "learning"
                self._connection.execute(
                    "UPDATE saved_words SET learning_stage = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                    (next_stage, existing["id"]),
                )
                self._connection.commit()
                return self.get_saved_word(existing["id"])
            return saved

    def update_saved_word_stage(
        self, saved_word_id: int, learning_stage: LearningStage
    ) -> dict[str, Any]:
        with self._lock:
            cursor = self._connection.execute(
                "UPDATE saved_words SET learning_stage = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                (learning_stage, saved_word_id),
            )
            self._connection.commit()
        if cursor.rowcount == 0:
            raise KeyError(saved_word_id)
        return self.get_saved_word(saved_word_id)

    def delete_saved_word(self, saved_word_id: int) -> bool:
        with self._lock:
            cursor = self._connection.execute(
                "DELETE FROM saved_words WHERE id = ?", (saved_word_id,)
            )
            self._connection.commit()
        return cursor.rowcount > 0

    def get_saved_word(self, saved_word_id: int) -> dict[str, Any]:
        with self._lock:
            row = self._connection.execute(
                """
                SELECT
                    sw.id, sw.surface, sw.lemma, sw.pos, sw.meaning,
                    sw.meanings_json, sw.morphology_json,
                    sw.source_language, sw.target_language,
                    sw.learning_stage,
                    sw.created_at, sw.updated_at,
                    COUNT(swo.id) AS occurrence_count,
                    latest.german_sentence, latest.english_sentence,
                    latest.video_url, latest.episode_id, latest.cue_id,
                    latest.cue_start
                FROM saved_words sw
                JOIN saved_word_occurrences latest ON latest.id = (
                    SELECT id FROM saved_word_occurrences
                    WHERE saved_word_id = sw.id
                    ORDER BY created_at DESC, id DESC LIMIT 1
                )
                LEFT JOIN saved_word_occurrences swo ON swo.saved_word_id = sw.id
                WHERE sw.id = ?
                GROUP BY sw.id
                """,
                (saved_word_id,),
            ).fetchone()
        if not row:
            raise KeyError(saved_word_id)
        result = dict(row)
        result["meanings"] = json.loads(result.pop("meanings_json"))
        result["morphology"] = json.loads(result.pop("morphology_json"))
        return result

    def list_saved_words(self) -> list[dict[str, Any]]:
        with self._lock:
            ids = [
                row["id"]
                for row in self._connection.execute(
                    "SELECT id FROM saved_words ORDER BY updated_at DESC, id DESC"
                ).fetchall()
            ]
        return [self.get_saved_word(saved_word_id) for saved_word_id in ids]
