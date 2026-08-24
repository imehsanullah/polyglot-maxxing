FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    STANZA_RESOURCES_DIR=/opt/stanza_resources \
    POLYGLOT_MAXXING_HOST=0.0.0.0 \
    POLYGLOT_MAXXING_DATABASE=/data/polyglot-maxxing.db \
    POLYGLOT_MAXXING_CODEX_HOME=/data/codex \
    POLYGLOT_MAXXING_CODEX_TRANSLATION_MODEL=gpt-5.6-luna \
    POLYGLOT_MAXXING_CODEX_TRANSLATION_EFFORT=low

WORKDIR /app

COPY pyproject.toml README.md ./
COPY src/polyglot_maxxing/__init__.py ./src/polyglot_maxxing/__init__.py

RUN pip install torch --index-url https://download.pytorch.org/whl/cpu \
    && pip install ".[nlp,codex]" \
    && python -c "import stanza; stanza.download('de', processors='tokenize,pos,lemma', model_dir='/opt/stanza_resources')"

COPY src ./src

RUN pip install --no-deps --force-reinstall .

RUN mkdir -p /data

EXPOSE 8765

HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=6 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/health', timeout=3)"]

CMD ["polyglot-maxxing-server"]
