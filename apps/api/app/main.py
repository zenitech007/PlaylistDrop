from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass

import httpx
from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from app.config import Settings, get_settings
from app.errors import register_exception_handlers
from app.logging_config import configure_logging, get_logger
from app.middleware import InMemoryRateLimitMiddleware, RequestContextMiddleware
from app.providers.registry import ProviderRegistry, build_default_provider_registry
from app.resolvers.registry import ResolverRegistry, build_default_resolver_registry
from app.schemas import (
    DownloadRequest,
    MatchRequest,
    MatchResponse,
    PlaylistData,
    ResolveRequest,
    ZipJobCreatedResponse,
    ZipJobStatusResponse,
    ZipRequest,
)
from app.services.downloader import open_validated_audio_stream
from app.services.ssrf_guard import MatchedUrlRegistry
from app.services.zip_jobs import ZipJobManager

logger = get_logger(__name__)


@dataclass
class AppContainer:
    settings: Settings
    http_client: httpx.AsyncClient
    resolvers: ResolverRegistry
    providers: ProviderRegistry
    url_registry: MatchedUrlRegistry
    zip_jobs: ZipJobManager


def create_app(
    settings: Settings | None = None,
    http_client: httpx.AsyncClient | None = None,
    resolvers: ResolverRegistry | None = None,
    providers: ProviderRegistry | None = None,
) -> FastAPI:
    cfg = settings or get_settings()
    configure_logging(cfg.log_level)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        owns_client = http_client is None
        client = http_client or httpx.AsyncClient(
            limits=httpx.Limits(max_connections=50, max_keepalive_connections=20),
            timeout=httpx.Timeout(cfg.provider_timeout_seconds),
            headers={"User-Agent": "PlaylistDrop/1.0 (+https://playlistdrop.app)"},
        )
        url_registry = MatchedUrlRegistry(
            ttl_seconds=cfg.match_registry_ttl_seconds,
            allowed_domains=cfg.allowed_download_domains,
        )
        resolver_registry = resolvers or build_default_resolver_registry(client, cfg)
        provider_registry = providers or build_default_provider_registry(client, cfg)
        zip_manager = ZipJobManager(
            client=client,
            registry=url_registry,
            max_download_bytes=cfg.max_download_bytes,
            ttl_seconds=cfg.zip_job_ttl_seconds,
        )

        app.state.container = AppContainer(
            settings=cfg,
            http_client=client,
            resolvers=resolver_registry,
            providers=provider_registry,
            url_registry=url_registry,
            zip_jobs=zip_manager,
        )
        logger.info("api_started", cors_origins=cfg.cors_origin_list)
        try:
            yield
        finally:
            await zip_manager.shutdown()
            if owns_client:
                await client.aclose()
            logger.info("api_stopped")

    app = FastAPI(
        title="PlaylistDrop API",
        version="1.0.0",
        lifespan=lifespan,
    )

    register_exception_handlers(app)

    # Middleware order: outermost executes first (CORS -> RequestContext -> RateLimit)
    app.add_middleware(
        InMemoryRateLimitMiddleware,
        max_requests=cfg.rate_limit_per_minute,
        window_seconds=60.0,
    )
    app.add_middleware(RequestContextMiddleware)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cfg.cors_origin_list,
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type", "X-Request-ID"],
        expose_headers=["Content-Disposition", "Retry-After", "X-Request-ID"],
    )

    def _container(request: Request) -> AppContainer:
        return request.app.state.container

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/api/resolve", response_model=PlaylistData)
    async def resolve_playlist(body: ResolveRequest, request: Request) -> PlaylistData:
        container = _container(request)
        return await container.resolvers.resolve_url(body.url)

    @app.post("/api/match", response_model=MatchResponse)
    async def match_tracks(body: MatchRequest, request: Request) -> MatchResponse:
        container = _container(request)
        matches = await container.providers.match_tracks(body.tracks)
        track_lookup = {track.id: track for track in body.tracks}
        for match in matches:
            track = track_lookup.get(match.trackId)
            artist = track.artist if track else "Unknown Artist"
            title = track.name if track else match.trackId
            try:
                container.url_registry.register(
                    track_id=match.trackId,
                    download_url=match.downloadUrl,
                    artist=artist,
                    title=title,
                    source=match.source,
                )
            except ValueError:
                logger.warning(
                    "skipped_unsafe_match_url",
                    track_id=match.trackId,
                    source=match.source,
                )
        return MatchResponse(matches=matches)

    @app.post("/api/download")
    async def download_track(body: DownloadRequest, request: Request) -> StreamingResponse:
        container = _container(request)
        audio_stream = await open_validated_audio_stream(
            client=container.http_client,
            registry=container.url_registry,
            download_url=body.downloadUrl,
            requested_filename=body.filename,
            max_bytes=container.settings.max_download_bytes,
        )
        headers = {
            "Content-Disposition": f'attachment; filename="{audio_stream.filename}"',
            "X-Content-Type-Options": "nosniff",
        }
        if audio_stream.content_length is not None:
            headers["Content-Length"] = str(audio_stream.content_length)

        return StreamingResponse(
            audio_stream.chunks,
            media_type=audio_stream.content_type,
            headers=headers,
        )

    @app.post(
        "/api/download/zip",
        response_model=ZipJobCreatedResponse,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def create_zip_job(body: ZipRequest, request: Request) -> ZipJobCreatedResponse:
        container = _container(request)
        job = container.zip_jobs.start_job(body.trackIds)
        return ZipJobCreatedResponse(jobId=job.job_id)

    @app.get(
        "/api/download/zip/{job_id}/status",
        response_model=ZipJobStatusResponse,
    )
    async def get_zip_status(job_id: str, request: Request) -> ZipJobStatusResponse:
        container = _container(request)
        return container.zip_jobs.get_status(job_id)

    @app.get("/api/download/zip/{job_id}/file")
    async def download_zip_file(job_id: str, request: Request) -> StreamingResponse:
        container = _container(request)
        path, chunks = container.zip_jobs.stream_finished_zip(job_id)
        file_size = path.stat().st_size
        headers = {
            "Content-Disposition": f'attachment; filename="playlistdrop-{job_id[:8]}.zip"',
            "Content-Length": str(file_size),
            "X-Content-Type-Options": "nosniff",
        }
        return StreamingResponse(
            chunks,
            media_type="application/zip",
            headers=headers,
        )

    return app


app = create_app()
