from __future__ import annotations

from pathlib import Path

from polyglot_maxxing.analysis import MultilingualAnalyzer
from polyglot_maxxing.database import Database


def test_non_german_uses_surface_words_without_local_analysis(tmp_path: Path) -> None:
    analyzer = MultilingualAnalyzer(Database(tmp_path / "test.db"), enable_stanza=True)

    def fail_if_stanza_is_requested(_language: str) -> None:
        raise AssertionError("Non-German text must not initialize Stanza")

    analyzer._get_stanza_pipeline = fail_if_stanza_is_requested  # type: ignore[method-assign]

    tokens = analyzer.analyze("Bonjour les amis !", "fr", "en")

    assert [token.surface for token in tokens] == ["Bonjour", "les", "amis"]
    assert [token.lemma for token in tokens] == ["Bonjour", "les", "amis"]
    assert all(token.pos == "" for token in tokens)
    assert all(token.morphology == {} for token in tokens)
    assert all(token.meanings == [] for token in tokens)
