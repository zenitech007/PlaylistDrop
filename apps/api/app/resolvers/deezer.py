from __future__ import annotations

from typing import Any

import httpx

from app.errors import AppError
from app.logging_config import get_logger
from app.providers.base import retry_with_backoff
from app.resolvers.base import TransientUpstreamError
from app.schemas import PlaylistData, PlaylistSource, Track

logger = get_logger(__name__)

DEEZER_API_BASE = "https://api.deezer.com"


def normalize_deezer_playlist(
    payload: dict[str, Any],
    extra_tracks: list[dict[str, Any]] | None = None,
    max_tracks: int = 200,
) -> PlaylistData:
    """Normalize Deezer playlist JSON into PlaylistData."""
    nb_tracks = payload.get("nb_tracks")
    if isinstance(nb_tracks, int) and nb_tracks > max_tracks:
        raise AppError(
            status_code=422,
            code="PLAYLIST_TOO_LARGE",
            message=(
                f"This playlist has {nb_tracks} tracks, which exceeds the maximum "
                f"limit of {max_tracks} tracks."
            ),
        )

    raw_tracks_obj = payload.get("tracks") or {}
    raw_tracks: list[dict[str, Any]] = list(raw_tracks_obj.get("data") or [])
    if extra_tracks:
        raw_tracks.extend(extra_tracks)

    if len(raw_tracks) > max_tracks:
        raise AppError(
            status_code=422,
            code="PLAYLIST_TOO_LARGE",
            message=(
                f"This playlist exceeds the maximum limit of {max_tracks} tracks."
            ),
        )

    tracks: list[Track] = []
    for item in raw_tracks:
        if not isinstance(item, dict):
            continue
        track_id = str(item.get("id") or "").strip()
        title = str(item.get("title") or "").strip()
        artist_obj = item.get("artist") or {}
        artist_name = (
            str(artist_obj.get("name") or "").strip()
            if isinstance(artist_obj, dict)
            else ""
        )
        if not track_id or not title or not artist_name:
            continue

        album_obj = item.get("album") or {}
        album_name = (
            str(album_obj.get("title") or "").strip()
            if isinstance(album_obj, dict)
            else ""
        )
        artwork_url = None
        if isinstance(album_obj, dict):
            artwork_url = (
                album_obj.get("cover_medium")
                or album_obj.get("cover_big")
                or album_obj.get("cover")
            )

        duration_sec = item.get("duration")
        duration_ms = (
            int(duration_sec) * 1000
            if isinstance(duration_sec, (int, float)) and duration_sec >= 0
            else 0
        )

        tracks.append(
            Track(
                id=f"deezer:{track_id}",
                name=title,
                artist=artist_name,
                album=album_name,
                durationMs=duration_ms,
                artworkUrl=str(artwork_url) if isinstance(artwork_url, str) and artwork_url else None,
            )
        )

    creator = payload.get("creator") or {}
    owner = (
        str(creator.get("name")).strip()
        if isinstance(creator, dict) and creator.get("name")
        else None
    )
    playlist_art = (
        payload.get("picture_big")
        or payload.get("picture_medium")
        or payload.get("picture")
    )

    return PlaylistData(
        id=str(payload.get("id") or ""),
        name=str(payload.get("title") or "Untitled Deezer Playlist"),
        owner=owner,
        artworkUrl=str(playlist_art) if isinstance(playlist_art, str) and playlist_art else None,
        tracks=tracks,
        source="deezer",
        partial=False,
    )


class DeezerResolver:
    """Credential-free public Deezer playlist resolver."""

    source: PlaylistSource = "deezer"

    def __init__(
        self,
        client: httpx.AsyncClient,
        max_tracks: int = 200,
        timeout_seconds: float = 10.0,
        max_retries: int = 3,
        base_backoff_seconds: float = 0.35,
    ) -> None:
        self._client = client
        self._max_tracks = max_tracks
        self._timeout = timeout_seconds
        self._max_retries = max_retries
        self._base_backoff_seconds = base_backoff_seconds

    async def _get_json(self, url: str) -> dict[str, Any]:
        async def _attempt() -> dict[str, Any]:
            response = await self._client.get(url, timeout=self._timeout)
            if response.status_code in {429, 500, 502, 503, 504}:
                raise TransientUpstreamError(f"Deezer status {response.status_code}")
            if response.status_code == 404:
                raise AppError(
                    status_code=404,
                    code="PLAYLIST_NOT_FOUND",
                    message="Deezer playlist was not found or is private.",
                )
            response.raise_for_status()
            data = response.json()
            if not isinstance(data, dict):
                raise AppError(
                    status_code=502,
                    code="UPSTREAM_ERROR",
                    message="Unexpected response from Deezer API.",
                )
            # Deezer returns HTTP 200 with an inline {"error": {"code": ...}} object
            err = data.get("error")
            if isinstance(err, dict):
                code = err.get("code")
                if code == 4:
                    raise TransientUpstreamError("Deezer quota limit exceeded")
                if code in {800, 300, 200}:
                    raise AppError(
                        status_code=404,
                        code="PLAYLIST_NOT_FOUND",
                        message="Deezer playlist not found or is set to private.",
                    )
                raise AppError(
                    status_code=502,
                    code="DEEZER_API_ERROR",
                    message=str(err.get("message") or "Deezer returned an error."),
                )
            return data

        try:
            return await retry_with_backoff(
                _attempt,
                max_attempts=self._max_retries,
                base_delay_seconds=self._base_backoff_seconds,
                retryable_exceptions=(
                    httpx.TimeoutException,
                    httpx.TransportError,
                    TransientUpstreamError,
                ),
            )
        except AppError:
            raise
        except TransientUpstreamError as exc:
            raise AppError(
                status_code=503,
                code="UPSTREAM_RATE_LIMITED",
                message="Deezer API is temporarily busy. Please retry shortly.",
                headers={"Retry-After": "15"},
            ) from exc
        except httpx.TimeoutException as exc:
            raise AppError(
                status_code=504,
                code="UPSTREAM_TIMEOUT",
                message="Timed out contacting Deezer API. Please try again.",
            ) from exc
        except httpx.HTTPError as exc:
            logger.warning("deezer_network_error", error=str(exc))
            raise AppError(
                status_code=502,
                code="UPSTREAM_NETWORK_ERROR",
                message="Unable to reach Deezer API.",
            ) from exc

    async def resolve(
        self, playlist_id: str, storefront: str | None = None
    ) -> PlaylistData:
        _ = storefront
        payload = await self._get_json(f"{DEEZER_API_BASE}/playlist/{playlist_id}")

        nb_tracks = payload.get("nb_tracks")
        if isinstance(nb_tracks, int) and nb_tracks > self._max_tracks:
            raise AppError(
                status_code=422,
                code="PLAYLIST_TOO_LARGE",
                message=(
                    f"This playlist has {nb_tracks} tracks, which exceeds the maximum "
                    f"limit of {self._max_tracks} tracks."
                ),
            )

        tracks_obj = payload.get("tracks") or {}
        first_page_count = len(tracks_obj.get("data") or [])
        extra_tracks: list[dict[str, Any]] = []
        next_url = tracks_obj.get("next")

        while isinstance(next_url, str) and next_url:
            page = await self._get_json(next_url)
            page_items = page.get("data") or []
            if first_page_count + len(extra_tracks) + len(page_items) > self._max_tracks:
                raise AppError(
                    status_code=422,
                    code="PLAYLIST_TOO_LARGE",
                    message=(
                        f"This playlist exceeds the maximum limit of {self._max_tracks} tracks."
                    ),
                )
            extra_tracks.extend(page_items)
            next_url = page.get("next")

        return normalize_deezer_playlist(
            payload=payload,
            extra_tracks=extra_tracks,
            max_tracks=self._max_tracks,
        )
