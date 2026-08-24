from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI, HTTPException, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from .analysis import MultilingualAnalyzer
from .codex import (
    CodexAuthenticationError,
    CodexEnricher,
    CodexUnavailableError,
)
from .config import Settings
from .database import Database
from .models import (
    CueInput,
    CodexLoginStartResponse,
    CodexLogoutResponse,
    CodexModelInfo,
    CodexModelsResponse,
    CodexStatusResponse,
    HealthResponse,
    ProcessCuesRequest,
    ProcessCuesResponse,
    ProcessedCue,
    SavedWord,
    SavedWordInput,
    SavedWordUpdate,
    WordInsightRequest,
    WordInsightResponse,
    WordInsights,
)
from .translation import (
    CodexTranslationProvider,
    TranslationError,
    TranslationProvider,
)


CACHE_VERSION = "v2-structured-single-cue"
WORD_INSIGHT_CACHE_VERSION = "v3-combined-word-dossier"


def _create_translator(
    settings: Settings, codex: CodexEnricher
) -> TranslationProvider:
    return CodexTranslationProvider(
        codex=codex,
        model=settings.codex_translation_model,
        effort=settings.codex_translation_effort,
        timeout_seconds=settings.codex_translation_timeout_seconds,
    )


def _cache_key(
    model: str,
    effort: str,
    source: str,
    target: str,
    text: str,
    context_before: str | None,
    context_after: str | None,
) -> str:
    value = "\0".join(
        (
            CACHE_VERSION,
            model,
            effort,
            source,
            target,
            context_before or "",
            text,
            context_after or "",
        )
    ).encode()
    return hashlib.sha256(value).hexdigest()


def _word_insight_cache_key(request: WordInsightRequest) -> str:
    value = json.dumps(
        {
            "version": WORD_INSIGHT_CACHE_VERSION,
            "model": request.model,
            "effort": request.effort,
            "word": request.word,
            "lemma": request.lemma,
            "context": request.context,
            "context_translation": request.context_translation,
            "pos": request.pos,
            "morphology": request.morphology,
            "meanings": request.meanings,
            "source_language": request.source_language,
            "target_language": request.target_language,
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return hashlib.sha256(value).hexdigest()


def _parse_cached_word_insights(content: str | None) -> WordInsights | None:
    if content is None:
        return None
    try:
        return WordInsights.model_validate_json(content)
    except ValueError:
        return None


def _word_insight_response(
    request: WordInsightRequest,
    insights: WordInsights,
    *,
    cached: bool,
) -> WordInsightResponse:
    return WordInsightResponse(
        insights=insights,
        model=request.model,
        cached=cached,
    )


def create_app(
    settings: Settings | None = None,
    *,
    translator: TranslationProvider | None = None,
    database: Database | None = None,
    codex: CodexEnricher | None = None,
) -> FastAPI:
    settings = settings or Settings.from_environment()
    database = database or Database(settings.database_path)
    codex = codex or CodexEnricher(
        enabled=True,
        codex_home=settings.codex_home,
        timeout_seconds=settings.codex_timeout_seconds,
        concurrency=settings.codex_concurrency,
    )
    translator = translator or _create_translator(settings, codex)
    analyzer = MultilingualAnalyzer(database, enable_stanza=settings.enable_stanza)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        yield
        await translator.close()
        await codex.close()
        database.close()

    app = FastAPI(
        title="Polyglot Maxxing companion",
        version="0.1.0",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost", "http://127.0.0.1"],
        allow_origin_regex=r"^(chrome|moz)-extension://[a-zA-Z0-9_-]+$",
        allow_methods=["GET", "POST", "PATCH", "DELETE"],
        allow_headers=["Content-Type"],
    )

    @app.get("/health", response_model=HealthResponse)
    async def health() -> HealthResponse:
        reachable, authenticated = await translator.health()
        return HealthResponse(
            status="ok" if reachable and authenticated else "degraded",
            translation_provider=translator.provider_name,
            translation_service_reachable=reachable,
            codex_authenticated=authenticated,
            model=translator.model_name,
            analyzer=analyzer.name,
        )

    @app.post("/v1/cues/process", response_model=ProcessCuesResponse)
    async def process_cues(request: ProcessCuesRequest) -> ProcessCuesResponse:
        translations: list[str | None] = [None] * len(request.cues)
        missing: list[tuple[int, CueInput, str]] = []
        for index, cue in enumerate(request.cues):
            key = _cache_key(
                request.model,
                request.effort,
                request.source_language,
                request.target_language,
                cue.text,
                cue.context_before,
                cue.context_after,
            )
            cached = database.get_cached_translation(key)
            if cached is not None:
                translations[index] = cached
            else:
                missing.append((index, cue, key))

        try:
            if missing:
                batch = [
                    {
                        "id": cue.id,
                        "text": cue.text,
                        "context_before": cue.context_before,
                        "context_after": cue.context_after,
                    }
                    for _, cue, _ in missing
                ]
                translate_batch = getattr(translator, "translate_batch", None)
                if translate_batch is not None:
                    generated = await translate_batch(
                        batch,
                        request.source_language,
                        request.target_language,
                        model=request.model,
                        effort=request.effort,
                    )
                else:
                    generated = await asyncio.gather(
                        *(
                            translator.translate(
                                cue.text,
                                request.source_language,
                                request.target_language,
                                context_before=cue.context_before,
                                context_after=cue.context_after,
                            )
                            for _, cue, _ in missing
                        )
                    )
                if len(generated) != len(missing):
                    raise TranslationError(
                        "Translation provider returned the wrong number of cues."
                    )
                for (index, cue, key), translation in zip(
                    missing, generated, strict=True
                ):
                    translations[index] = translation
                    database.put_cached_translation(
                        cache_key=key,
                        model=request.model,
                        source_language=request.source_language,
                        target_language=request.target_language,
                        source_text=cue.text,
                        translation=translation,
                    )
        except TranslationError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error

        completed_translations = [
            translation if translation is not None else "" for translation in translations
        ]

        result = [
            ProcessedCue(
                **cue.model_dump(),
                translation=translation,
                tokens=analyzer.analyze(
                    cue.text,
                    request.source_language,
                    request.target_language,
                ),
            )
            for cue, translation in zip(
                request.cues, completed_translations, strict=True
            )
        ]
        return ProcessCuesResponse(cues=result, model=request.model)

    @app.post("/v1/saved-words", response_model=SavedWord)
    async def save_word(word: SavedWordInput) -> SavedWord:
        return SavedWord.model_validate(database.save_word(word))

    @app.get("/v1/saved-words", response_model=list[SavedWord])
    async def saved_words() -> list[SavedWord]:
        return [SavedWord.model_validate(row) for row in database.list_saved_words()]

    @app.post("/v1/saved-words/toggle-stage", response_model=SavedWord)
    async def toggle_saved_word_stage(word: SavedWordInput) -> SavedWord:
        return SavedWord.model_validate(database.toggle_word_stage(word))

    @app.patch("/v1/saved-words/{saved_word_id}", response_model=SavedWord)
    async def update_saved_word(
        saved_word_id: int, update: SavedWordUpdate
    ) -> SavedWord:
        try:
            row = database.update_saved_word_stage(saved_word_id, update.learning_stage)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="Saved word not found") from error
        return SavedWord.model_validate(row)

    @app.delete(
        "/v1/saved-words/{saved_word_id}",
        status_code=status.HTTP_204_NO_CONTENT,
    )
    async def delete_saved_word(saved_word_id: int) -> Response:
        if not database.delete_saved_word(saved_word_id):
            raise HTTPException(status_code=404, detail="Saved word not found")
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @app.get("/v1/codex/status", response_model=CodexStatusResponse)
    async def codex_status() -> CodexStatusResponse:
        return CodexStatusResponse.model_validate(await codex.status())

    @app.get("/v1/codex/models", response_model=CodexModelsResponse)
    async def codex_models() -> CodexModelsResponse:
        try:
            models = [
                CodexModelInfo.model_validate(item) for item in await codex.models()
            ]
        except CodexUnavailableError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        return CodexModelsResponse(models=models)

    @app.post("/v1/codex/login/start", response_model=CodexLoginStartResponse)
    async def codex_login_start() -> CodexLoginStartResponse:
        try:
            return CodexLoginStartResponse.model_validate(
                await codex.start_device_login()
            )
        except CodexUnavailableError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error

    @app.post("/v1/codex/logout", response_model=CodexLogoutResponse)
    async def codex_logout() -> CodexLogoutResponse:
        try:
            await codex.logout()
        except CodexUnavailableError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        return CodexLogoutResponse()

    @app.post("/v1/codex/login/switch", response_model=CodexLoginStartResponse)
    async def codex_login_switch() -> CodexLoginStartResponse:
        try:
            return CodexLoginStartResponse.model_validate(
                await codex.switch_account()
            )
        except CodexUnavailableError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error

    async def resolve_word_insights(
        request: WordInsightRequest,
        on_delta: Callable[[str], Awaitable[None]] | None = None,
    ) -> tuple[WordInsights, bool]:
        cache_key = _word_insight_cache_key(request)
        cached = _parse_cached_word_insights(
            database.get_cached_word_insight(cache_key)
        )
        if cached is not None:
            return cached, True
        generated = await codex.enrich_bundle(
            word=request.word,
            lemma=request.lemma,
            context=request.context,
            context_translation=request.context_translation,
            pos=request.pos,
            morphology=request.morphology,
            meanings=request.meanings,
            source_language=request.source_language,
            target_language=request.target_language,
            model=request.model,
            effort=request.effort,
            on_delta=on_delta,
        )
        insights = WordInsights.model_validate(generated)
        database.put_cached_word_insight(
            cache_key=cache_key,
            model=request.model,
            effort=request.effort,
            kind="bundle",
            word=request.word,
            context=request.context,
            content=insights.model_dump_json(),
        )
        return insights, False

    @app.post(
        "/v1/words/insight",
        response_model=WordInsightResponse,
        response_model_exclude_none=True,
    )
    async def word_insight(request: WordInsightRequest) -> WordInsightResponse:
        try:
            insights, cached = await resolve_word_insights(request)
        except CodexAuthenticationError as error:
            raise HTTPException(status_code=401, detail=str(error)) from error
        except CodexUnavailableError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        return _word_insight_response(request, insights, cached=cached)

    @app.post("/v1/words/insight/stream")
    async def word_insight_stream(request: WordInsightRequest) -> StreamingResponse:
        async def events() -> AsyncIterator[str]:
            queue: asyncio.Queue[dict[str, object]] = asyncio.Queue()

            async def forward_delta(delta: str) -> None:
                await queue.put({"type": "delta", "delta": delta})

            async def produce() -> None:
                try:
                    insights, cached = await resolve_word_insights(
                        request,
                        on_delta=forward_delta,
                    )
                    response = _word_insight_response(
                        request,
                        insights,
                        cached=cached,
                    )
                    await queue.put(
                        {
                            "type": "done",
                            **response.model_dump(by_alias=True, exclude_none=True),
                        }
                    )
                except asyncio.CancelledError:
                    raise
                except CodexAuthenticationError as error:
                    await queue.put(
                        {"type": "error", "error": str(error), "status": 401}
                    )
                except Exception as error:
                    await queue.put(
                        {"type": "error", "error": str(error), "status": 503}
                    )

            producer = asyncio.create_task(produce())
            try:
                while True:
                    event = await queue.get()
                    yield json.dumps(event, ensure_ascii=False) + "\n"
                    if event["type"] in {"done", "error"}:
                        break
            finally:
                if not producer.done():
                    producer.cancel()
                with suppress(asyncio.CancelledError):
                    await producer

        return StreamingResponse(
            events(),
            media_type="application/x-ndjson",
            headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
        )

    return app
