from __future__ import annotations

import argparse
import hashlib
import tarfile
import tempfile
import urllib.request
import xml.etree.ElementTree as ET
from collections.abc import Iterator
from pathlib import Path

from polyglot_maxxing.config import Settings
from polyglot_maxxing.database import Database


VERSION = "1.9-fd1"
SOURCE_URL = (
    "https://download.freedict.org/dictionaries/deu-eng/1.9-fd1/"
    "freedict-deu-eng-1.9-fd1.src.tar.xz"
)
SOURCE_SHA512 = (
    "31c7143ae53074a5f357b80f4a6ccce8fa26f77a237476edca1353d5783293a0"
    "a8aef3a47f087de3e0c38f5aa7064196b7347886e1049116dc2964c6532397bc"
)
TEI = "{http://www.tei-c.org/ns/1.0}"
XML_LANG = "{http://www.w3.org/XML/1998/namespace}lang"
POS_MAP = {
    "n": "NOUN",
    "v": "VERB",
    "adj": "ADJ",
    "adv": "ADV",
    "pron": "PRON",
    "prep": "ADP",
    "conj": "CCONJ",
    "interj": "INTJ",
    "num": "NUM",
}


def download(destination: Path) -> None:
    request = urllib.request.Request(
        SOURCE_URL, headers={"User-Agent": "Polyglot-Maxxing/0.1 (+local dictionary install)"}
    )
    digest = hashlib.sha512()
    with urllib.request.urlopen(request) as response, destination.open("wb") as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
            digest.update(chunk)
    if digest.hexdigest() != SOURCE_SHA512:
        raise RuntimeError("FreeDict archive checksum did not match the published SHA-512")


def text(element: ET.Element | None) -> str:
    return " ".join("".join(element.itertext()).split()) if element is not None else ""


def entries(tei_stream: object) -> Iterator[tuple[str, str, list[str]]]:
    for _, element in ET.iterparse(tei_stream, events=("end",)):
        if element.tag != f"{TEI}entry":
            continue
        headwords = {
            text(orth)
            for orth in element.findall(f"./{TEI}form/{TEI}orth")
            if text(orth)
        }
        raw_pos = text(element.find(f"./{TEI}gramGrp/{TEI}pos")).lower()
        pos = POS_MAP.get(raw_pos, raw_pos.upper())
        meanings: list[str] = []
        for quote in element.findall(
            f"./{TEI}sense/{TEI}cit[@type='trans']/{TEI}quote"
        ):
            if quote.get(XML_LANG, "en") != "en":
                continue
            value = text(quote)
            if value and value not in meanings:
                meanings.append(value)
            if len(meanings) >= 8:
                break
        for headword in headwords:
            if meanings:
                yield headword, pos, meanings
        element.clear()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Install the FreeDict/Ding German-English dictionary locally."
    )
    parser.add_argument(
        "--database",
        type=Path,
        default=Settings.from_environment().database_path,
    )
    args = parser.parse_args()

    database = Database(args.database)
    database.delete_dictionary_source("freedict-deu-eng")
    inserted = 0
    with tempfile.TemporaryDirectory(prefix="polyglot-maxxing-freedict-") as temporary:
        archive_path = Path(temporary) / "deu-eng.tar.xz"
        print(f"Downloading FreeDict German-English {VERSION}…")
        download(archive_path)
        with tarfile.open(archive_path, mode="r:xz") as archive:
            member = archive.getmember("deu-eng/deu-eng.tei")
            stream = archive.extractfile(member)
            if stream is None:
                raise RuntimeError("The FreeDict archive did not contain deu-eng.tei")
            batch: list[tuple[str, str, list[str]]] = []
            for entry in entries(stream):
                batch.append(entry)
                if len(batch) >= 2_000:
                    inserted += database.insert_dictionary_entries(
                        batch, source="freedict-deu-eng"
                    )
                    batch.clear()
            inserted += database.insert_dictionary_entries(
                batch, source="freedict-deu-eng"
            )
    database.record_dictionary_source(
        name="FreeDict German-English",
        version=VERSION,
        source_url=SOURCE_URL,
        license_name="GPLv3 and AGPLv3 (see source archive COPYING and TEI header)",
    )
    database.close()
    print(f"Installed {inserted:,} German headword entries into {args.database}")


if __name__ == "__main__":
    main()
