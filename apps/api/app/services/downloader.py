from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass

import httpx

from app.errors import AppError
from app.logging_config import get_logger
from app.services.ssrf_guard import MatchedUrlRegistry, sanitize_filename

logger = get_logger(__name__)

CHUNK_SIZE = 65536


@dataclass
class ValidatedAudioStream:
    filename: str
    content_type: str
    content_length: int | None
    chunks: AsyncIterator[bytes]


def _is_valid_audio_content_type(content_type: str | None) -> bool:
    if not content_type:
        return False
    mime = content_type.split(";", 1)[0].strip().lower()
    return mime == "audio/mpeg" or mime.startswith("audio/")


async def open_validated_audio_stream(
    client: httpx.AsyncClient,
    registry: MatchedUrlRegistry,
    download_url: str,
    requested_filename: str | None = None,
    max_bytes: int = 50 * 1024 * 1024,
    timeout_seconds: float = 30.0,
) -> ValidatedAudioStream:
    """
    Validate SSRF allow-list, initiate upstream streaming request, verify audio Content-Type
    and 50MB size cap, and return an async chunk iterator without buffering the file in memory.
    """
    registered = registry.validate_download_url(download_url)

    timeout = httpx.Timeout(
        connect=10.0,
        read=timeout_seconds,
        write=10.0,
        pool=10.0,
    )

    request = client.build_request("GET", download_url, timeout=timeout)
    try:
        response = await client.send(request, stream=True, follow_redirects=True)
    except httpx.TimeoutException as exc:
        raise AppError(
            status_code=504,
            code="DOWNLOAD_TIMEOUT",
            message="Timed out while connecting to the audio source.",
        ) from exc
    except httpx.HTTPError as exc:
        logger.warning("download_upstream_error", error=str(exc))
        raise AppError(
            status_code=502,
            code="DOWNLOAD_UPSTREAM_ERROR",
            message="Could not connect to the audio source.",
        ) from exc

    # Re-verify final redirected host against SSRF guard
    try:
        registry.validate_download_url(str(response.url))
    except AppError:
        await response.aclose()
        raise

    if response.status_code >= 400:
        status = response.status_code
        await response.aclose()
        raise AppError(
            status_code=502 if status >= 500 else 404,
            code="UPSTREAM_AUDIO_UNAVAILABLE",
            message="The audio file could not be downloaded from the catalog source.",
        )

    content_type = response.headers.get("Content-Type", "")
    if not _is_valid_audio_content_type(content_type):
        await response.aclose()
        raise AppError(
            status_code=415,
            code="INVALID_AUDIO_CONTENT_TYPE",
            message="Upstream source did not return a valid audio file.",
        )

    content_length_header = response.headers.get("Content-Length")
    content_length: int | None = None
    if content_length_header and content_length_header.isdigit():
        content_length = int(content_length_header)
        if content_length > max_bytes:
            await response.aclose()
            raise AppError(
                status_code=413,
                code="FILE_TOO_LARGE",
                message="Audio file exceeds the 50 MB download limit.",
            )

    raw_name = requested_filename or (registered.filename if registered else "track.mp3")
    safe_filename = sanitize_filename(raw_name)

    async def _stream_chunks() -> AsyncIterator[bytes]:
        bytes_read = 0
        try:
            async for chunk in response.aiter_bytes(chunk_size=CHUNK_SIZE):
                bytes_read += len(chunk)
                if bytes_read > max_bytes:
                    logger.warning("download_size_limit_exceeded", bytes_read=bytes_read)
                    break
                yield chunk
        finally:
            await response.aclose()

    return ValidatedAudioStream(
        filename=safe_filename,
        content_type=content_type.split(";", 1)[0].strip().lower(),
        content_length=content_length,
        chunks=_stream_chunks(),
    )
