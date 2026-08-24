from __future__ import annotations

import argparse
import gzip
import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any, TextIO

from polyglot_maxxing.config import Settings
from polyglot_maxxing.database import Database


def open_text(path: Path) -> TextIO:
    if path.suffix == ".gz":
        return gzip.open(path, "rt", encoding="utf-8")
    return path.open("r", encoding="utf-8")


def entries(path: Path) -> Iterator[tuple[str, str, list[str]]]:
    with open_text(path) as stream:
        for line in stream:
            try:
                record: dict[str, Any] = json.loads(line)
            except json.JSONDecodeError:
                continue
            if record.get("lang_code") != "de":
                continue
            lemma = str(record.get("word") or "").strip()
            pos = str(record.get("pos") or "").strip()
            meanings: list[str] = []
            for sense in record.get("senses") or []:
                if not isinstance(sense, dict):
                    continue
                for gloss in sense.get("glosses") or []:
                    if isinstance(gloss, str) and gloss not in meanings:
                        meanings.append(gloss)
                    if len(meanings) >= 5:
                        break
                if len(meanings) >= 5:
                    break
            if lemma and meanings:
                yield lemma, pos, meanings


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            "Build the local German-English dictionary from an English "
            "Wiktionary Wiktextract/Kaikki JSONL file."
        )
    )
    parser.add_argument("jsonl", type=Path)
    parser.add_argument(
        "--database",
        type=Path,
        default=Settings.from_environment().database_path,
    )
    args = parser.parse_args()

    database = Database(args.database)
    inserted = 0
    batch: list[tuple[str, str, list[str]]] = []
    try:
        for entry in entries(args.jsonl):
            batch.append(entry)
            if len(batch) >= 1_000:
                inserted += database.insert_dictionary_entries(
                    batch, source="kaikki-enwiktionary"
                )
                batch.clear()
        inserted += database.insert_dictionary_entries(
            batch, source="kaikki-enwiktionary"
        )
    finally:
        database.close()
    print(f"Inserted {inserted:,} German dictionary entries into {args.database}")


if __name__ == "__main__":
    main()
