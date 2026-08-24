# Polyglot Maxxing companion

The companion is a loopback-only FastAPI service used by the Polyglot Maxxing
browser extension. It sends subtitle and tutor requests through an attached
ChatGPT/Codex account, analyzes subtitle words, caches results, and stores saved
vocabulary in SQLite.

The recommended Docker setup is documented in the repository root
[README](../../README.md).

## Native development

Requires Python 3.12 and `uv`:

```bash
uv sync --extra dev --extra nlp --extra codex
uv run pytest
uv run polyglot-maxxing-server
```

The service listens on `http://127.0.0.1:8765` by default. Useful endpoints:

- `GET /health`
- `POST /v1/cues/process`
- `POST /v1/words/insight/stream`
- `GET /v1/saved-words`
- `GET /v1/codex/status`

Configuration uses the `POLYGLOT_MAXXING_*` variables listed in the root
README. Do not commit the configured database or Codex home directory.
