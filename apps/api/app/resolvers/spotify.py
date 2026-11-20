from __future__ import annotations

import asyncio
import base64
import time
from typing import Any

import httpx

from app.errors import AppError
from app.logging_config import get_logger
from app.providers.base import retry_with_backoff
from app.resolvers.base import TransientUpstreamError
from app.schemas import PlaylistData, PlaylistSource, Track

logger = get_logger(__name__)

SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token"
SPOTIFY_API_BASE = "https://api.spotify.com/v1"
TOKEN_EXPIRY_BUFFER_SECONDS = 60.0


def normalize_spotify_playlist(
    payload: dict[str, Any],
    extra_items: list[dict[str, Any]] | None = None,
    max_tracks: int = 200,
) -> PlaylistData:
    """Normalize Spotify Web API playlist JSON into PlaylistData."""
    tracks_obj = payload.get("tracks") or {}
    reported_total = tracks_obj.get("total")
    if isinstance(reported_total, int) and reported_total > max_tracks:
        raise AppError(
            status_code=422,
            code="PLAYLIST_TOO_LARGE",
            message=(
                f"This playlist has {reported_total} tracks, which exceeds the maximum "
                f"limit of {max_tracks} tracks."
            ),
        )

    raw_items: list[dict[str, Any]] = list(tracks_obj.get("items") or [])
    if extra_items:
        raw_items.extend(extra_items)

    if len(raw_items) > max_tracks:
        raise AppError(
            status_code=422,
            code="PLAYLIST_TOO_LARGE",
            message=(
                f"This playlist exceeds the maximum limit of {max_tracks} tracks."
            ),
        )

    tracks: list[Track] = []
    for entry in raw_items:
        if not isinstance(entry, dict):
            continue
        track_obj = entry.get("track")
        if not isinstance(track_obj, dict):
            continue
        track_id = str(track_obj.get("id") or "").strip()
        name = str(track_obj.get("name") or "").strip()
        artists_list = track_obj.get("artists") or []
        artist_names = [
            str(a.get("name") or "").strip()
            for a in artists_list
            if isinstance(a, dict) and a.get("name")
        ]
        artist = ", ".join(artist_names)
        if not track_id or not name or not artist:
            continue

        album_obj = track_obj.get("album") or {}
        album_name = (
            str(album_obj.get("name") or "").strip()
            if isinstance(album_obj, dict)
            else ""
        )
        album_images = album_obj.get("images") if isinstance(album_obj, dict) else None
        artwork_url = _pick_spotify_image(album_images)

        duration_raw = track_obj.get("duration_ms")
        duration_ms = (
            int(duration_raw)
            if isinstance(duration_raw, (int, float)) and duration_raw >= 0
            else 0
        )

        tracks.append(
            Track(
                id=f"spotify:{track_id}",
                name=name,
                artist=artist,
                album=album_name,
                durationMs=duration_ms,
                artworkUrl=artwork_url,
            )
        )

    owner_obj = payload.get("owner") or {}
    owner = (
        str(owner_obj.get("display_name") or owner_obj.get("id") or "").strip() or None
        if isinstance(owner_obj, dict)
        else None
    )

    return PlaylistData(
        id=str(payload.get("id") or ""),
        name=str(payload.get("name") or "Untitled Spotify Playlist"),
        owner=owner,
        artworkUrl=_pick_spotify_image(payload.get("images")),
        tracks=tracks,
        source="spotify",
        partial=False,
    )


def _pick_spotify_image(images: Any) -> str | None:
    if not isinstance(images, list) or not images:
        return None
    # Prefer medium (~300px) image when multiple sizes exist
    for img in images:
        if isinstance(img, dict) and isinstance(img.get("url"), str):
            width = img.get("width")
            if isinstance(width, int) and 150 <= width <= 400:
                return img["url"]
    first = images[0]
    if isinstance(first, dict) and isinstance(first.get("url"), str):
        return first["url"]
    return None


class SpotifyResolver:
    """Spotify playlist resolver using Client Credentials OAuth with 60s token expiry buffer."""

    source: PlaylistSource = "spotify"

    def __init__(
        self,
        client: httpx.AsyncClient,
        client_id: str,
        client_secret: str,
        max_tracks: int = 200,
        timeout_seconds: float = 10.0,
        max_retries: int = 3,
        base_backoff_seconds: float = 0.35,
    ) -> None:
        self._client = client
        self._client_id = client_id.strip()
        self._client_secret = client_secret.strip()
        self._max_tracks = max_tracks
        self._timeout = timeout_seconds
        self._max_retries = max_retries
        self._base_backoff_seconds = base_backoff_seconds

        self._token_lock = asyncio.Lock()
        self._cached_token: str | None = None
        self._token_expires_at: float = 0.0

    async def _get_access_token(self, force_refresh: bool = False) -> str:
        if not self._client_id or not self._client_secret:
            raise AppError(
                status_code=500,
                code="SPOTIFY_CONFIG_ERROR",
                message=(
                    "Spotify API credentials are not configured on the server. "
                    "Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in the API environment."
                ),
            )

        now = time.monotonic()
        if (
            not force_refresh
            and self._cached_token
            and now < (self._token_expires_at - TOKEN_EXPIRY_BUFFER_SECONDS)
        ):
            return self._cached_token

        async with self._token_lock:
            now = time.monotonic()
            if (
                not force_refresh
                and self._cached_token
                and now < (self._token_expires_at - TOKEN_EXPIRY_BUFFER_SECONDS)
            ):
                return self._cached_token

            basic = base64.b64encode(
                f"{self._client_id}:{self._client_secret}".encode("utf-8")
            ).decode("ascii")

            async def _fetch_token() -> tuple[str, float]:
                response = await self._client.post(
                    SPOTIFY_TOKEN_URL,
                    data={"grant_type": "client_credentials"},
                    headers={
                        "Authorization": f"Basic {basic}",
                        "Content-Type": "application/x-www-form-urlencoded",
                    },
                    timeout=self._timeout,
                )
                if response.status_code in {429, 500, 502, 503, 504}:
                    raise TransientUpstreamError(f"Spotify token status {response.status_code}")
                if response.status_code in {400, 401}:
                    logger.error("spotify_client_credentials_rejected", status_code=response.status_code)
                    raise AppError(
                        status_code=500,
                        code="SPOTIFY_AUTH_ERROR",
                        message=(
                            "Spotify rejected the server client credentials. "
                            "Verify SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET."
                        ),
                    )
                response.raise_for_status()
                body = response.json()
                access_token = str(body.get("access_token") or "")
                expires_in = float(body.get("expires_in") or 3600)
                if not access_token:
                    raise AppError(
                        status_code=502,
                        code="SPOTIFY_AUTH_ERROR",
                        message="Spotify did not return an access token.",
                    )
                return access_token, time.monotonic() + expires_in

            try:
                token, expires_at = await retry_with_backoff(
                    _fetch_token,
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
            except Exception as exc:
                raise AppError(
                    status_code=502,
                    code="UPSTREAM_NETWORK_ERROR",
                    message="Unable to authenticate with Spotify API.",
                ) from exc

            self._cached_token = token
            self._token_expires_at = expires_at
            return token

    async def _get_spotify_json(self, url: str) -> dict[str, Any]:
        last_retry_after = "30"

        async def _attempt() -> dict[str, Any]:
            nonlocal last_retry_after
            token = await self._get_access_token()
            response = await self._client.get(
                url,
                headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
                timeout=self._timeout,
            )
            if response.status_code == 401:
                token = await self._get_access_token(force_refresh=True)
                response = await self._client.get(
                    url,
                    headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
                    timeout=self._timeout,
                )
            if response.status_code == 429:
                last_retry_after = response.headers.get("Retry-After", "30")
                raise TransientUpstreamError("Spotify rate limited")
            if response.status_code in {500, 502, 503, 504}:
                raise TransientUpstreamError(f"Spotify status {response.status_code}")
            if response.status_code == 404:
                raise AppError(
                    status_code=404,
                    code="PLAYLIST_NOT_FOUND",
                    message="Spotify playlist not found or is private. Make sure the playlist is public.",
                )
            if response.status_code == 403:
                raise AppError(
                    status_code=404,
                    code="PLAYLIST_NOT_FOUND",
                    message="Spotify playlist is private or restricted.",
                )
            response.raise_for_status()
            data = response.json()
            if not isinstance(data, dict):
                raise AppError(
                    status_code=502,
                    code="UPSTREAM_ERROR",
                    message="Unexpected response from Spotify API.",
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
                message="Spotify API rate limit reached. Please retry shortly.",
                headers={"Retry-After": last_retry_after},
            ) from exc
        except httpx.TimeoutException as exc:
            raise AppError(
                status_code=504,
                code="UPSTREAM_TIMEOUT",
                message="Timed out contacting Spotify API.",
            ) from exc
        except httpx.HTTPError as exc:
            logger.warning("spotify_network_error", error=str(exc))
            raise AppError(
                status_code=502,
                code="UPSTREAM_NETWORK_ERROR",
                message="Unable to reach Spotify API.",
            ) from exc

    async def resolve(
        self, playlist_id: str, storefront: str | None = None
    ) -> PlaylistData:
        _ = storefront
        payload = await self._get_spotify_json(f"{SPOTIFY_API_BASE}/playlists/{playlist_id}")

        tracks_obj = payload.get("tracks") or {}
        reported_total = tracks_obj.get("total")
        if isinstance(reported_total, int) and reported_total > self._max_tracks:
            raise AppError(
                status_code=422,
                code="PLAYLIST_TOO_LARGE",
                message=(
                    f"This playlist has {reported_total} tracks, which exceeds the maximum "
                    f"limit of {self._max_tracks} tracks."
                ),
            )

        first_page_count = len(tracks_obj.get("items") or [])
        extra_items: list[dict[str, Any]] = []
        next_url = tracks_obj.get("next")

        while isinstance(next_url, str) and next_url:
            page = await self._get_spotify_json(next_url)
            page_items = page.get("items") or []
            if first_page_count + len(extra_items) + len(page_items) > self._max_tracks:
                raise AppError(
                    status_code=422,
                    code="PLAYLIST_TOO_LARGE",
                    message=(
                        f"This playlist exceeds the maximum limit of {self._max_tracks} tracks."
                    ),
                )
            extra_items.extend(page_items)
            next_url = page.get("next")

        return normalize_spotify_playlist(
            payload=payload,
            extra_items=extra_items,
            max_tracks=self._max_tracks,
        )
