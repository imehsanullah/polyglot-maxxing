from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from platformdirs import user_data_path


def _truthy(value: str | None) -> bool:
    return (value or "").lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True, slots=True)
class Settings:
    host: str = "127.0.0.1"
    port: int = 8765
    database_path: Path = user_data_path("polyglot-maxxing") / "polyglot-maxxing.db"
    enable_stanza: bool = True
    codex_home: Path = user_data_path("polyglot-maxxing") / "codex"
    codex_timeout_seconds: float = 90.0
    codex_concurrency: int = 2
    codex_translation_model: str = "gpt-5.6-luna"
    codex_translation_effort: str = "low"
    codex_translation_timeout_seconds: float = 90.0

    @classmethod
    def from_environment(cls) -> "Settings":
        return cls(
            host=os.getenv("POLYGLOT_MAXXING_HOST", "127.0.0.1"),
            port=int(os.getenv("POLYGLOT_MAXXING_PORT", "8765")),
            database_path=Path(
                os.getenv(
                    "POLYGLOT_MAXXING_DATABASE",
                    str(user_data_path("polyglot-maxxing") / "polyglot-maxxing.db"),
                )
            ),
            enable_stanza=_truthy(os.getenv("POLYGLOT_MAXXING_ENABLE_STANZA", "1")),
            codex_home=Path(
                os.getenv(
                    "POLYGLOT_MAXXING_CODEX_HOME",
                    str(user_data_path("polyglot-maxxing") / "codex"),
                )
            ),
            codex_timeout_seconds=max(
                10.0, float(os.getenv("POLYGLOT_MAXXING_CODEX_TIMEOUT_SECONDS", "90"))
            ),
            codex_concurrency=max(
                1, int(os.getenv("POLYGLOT_MAXXING_CODEX_CONCURRENCY", "2"))
            ),
            codex_translation_model=os.getenv(
                "POLYGLOT_MAXXING_CODEX_TRANSLATION_MODEL", "gpt-5.6-luna"
            ),
            codex_translation_effort=os.getenv(
                "POLYGLOT_MAXXING_CODEX_TRANSLATION_EFFORT", "low"
            ),
            codex_translation_timeout_seconds=max(
                10.0,
                float(
                    os.getenv(
                        "POLYGLOT_MAXXING_CODEX_TRANSLATION_TIMEOUT_SECONDS", "90"
                    )
                ),
            ),
        )
