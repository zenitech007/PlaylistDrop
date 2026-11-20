from __future__ import annotations

from typing import Any

import httpx

from app.errors import AppError
from app.logging_config import get_logger
from app.providers.base import retry_with_backoff
from app.resolvers.base import TransientUpstreamError, parse_youtube_title
from app.schemas import PlaylistData, PlaylistSource, Track

logger = get_logger(__name__)

YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3"


class YouTubeQuotaExceededError(Exception):
    """Raised when YouTube Data API v3 reports quotaExceeded / dailyLimitExceeded."""


def _is_quota_error(response: httpx.Response) -> bool:
    if response.status_code != 403:
        return False
    try:
        payload = response.json()
    except Exception:
        return False
    err = payload.get("error") or {}
    errors = err.get("errors") or []
    for item in errors:
        if isinstance(item, dict) and item.get("reason") in {
            "quotaExceeded",
            "dailyLimitExceeded",
            "userRateLimitExceeded",
        }:
            return True
    message = str(err.get("message") or "").lower()
    return "quota" in message


def _is_service_disabled_error(response: httpx.Response) -> bool:
    if response.status_code != 403:
        return False
    try:
        payload = response.json()
    except Exception:
        return False
    err = payload.get("error") or {}
    errors = err.get("errors") or []
    for item in errors:
        if isinstance(item, dict) and item.get("reason") in {
            "accessNotConfigured",
            "API_KEY_SERVICE_BLOCKED",
            "SERVICE_DISABLED",
        }:
            return True
    message = str(err.get("message") or "").lower()
    return (
        "has not been used in project" in message
        or "is disabled" in message
        or "api_key_service_blocked" in message
    )


def _pick_youtube_thumbnail(thumbnails: Any) -> str | None:
    if not isinstance(thumbnails, dict):
        return None
    for key in ("medium", "high", "standard", "default"):
        entry = thumbnails.get(key)
        if isinstance(entry, dict) and isinstance(entry.get("url"), str):
            return entry["url"]
    return None


def normalize_youtube_playlist(
    playlist_id: str,
    items: list[dict[str, Any]],
    playlist_meta: dict[str, Any] | None = None,
    partial: bool = False,
    max_tracks: int = 200,
) -> PlaylistData:
    """Normalize YouTube Data API v3 playlistItems into PlaylistData."""
    if len(items) > max_tracks:
        raise AppError(
            status_code=422,
            code="PLAYLIST_TOO_LARGE",
            message=(
                f"This playlist exceeds the maximum limit of {max_tracks} tracks."
            ),
        )

    tracks: list[Track] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        snippet = item.get("snippet") or {}
        if not isinstance(snippet, dict):
            continue

        raw_title = str(snippet.get("title") or "").strip()
        if not raw_title or raw_title.lower() in {"deleted video", "private video"}:
            continue

        resource = snippet.get("resourceId") or {}
        video_id = (
            str(resource.get("videoId") or "").strip()
            if isinstance(resource, dict)
            else ""
        )
        track_id = video_id or str(item.get("id") or "").strip()
        if not track_id:
            continue

        channel_name = str(
            snippet.get("videoOwnerChannelTitle")
            or snippet.get("channelTitle")
            or "Unknown Artist"
        ).strip()

        artist, clean_title = parse_youtube_title(raw_title, channel_name)
        artwork_url = _pick_youtube_thumbnail(snippet.get("thumbnails"))

        tracks.append(
            Track(
                id=f"youtube:{track_id}",
                name=clean_title,
                artist=artist,
                album="",
                durationMs=0,
                artworkUrl=artwork_url,
            )
        )

    meta_snippet = (playlist_meta or {}).get("snippet") or {}
    playlist_name = (
        str(meta_snippet.get("title")).strip()
        if isinstance(meta_snippet, dict) and meta_snippet.get("title")
        else f"YouTube Playlist ({playlist_id})"
    )
    owner = (
        str(meta_snippet.get("channelTitle")).strip()
        if isinstance(meta_snippet, dict) and meta_snippet.get("channelTitle")
        else None
    )
    playlist_art = (
        _pick_youtube_thumbnail(meta_snippet.get("thumbnails"))
        if isinstance(meta_snippet, dict)
        else None
    )
    if not playlist_art and tracks:
        playlist_art = tracks[0].artworkUrl

    return PlaylistData(
        id=playlist_id,
        name=playlist_name,
        owner=owner,
        artworkUrl=playlist_art,
        tracks=tracks,
        source="youtube",
        partial=partial,
    )


class YouTubeResolver:
    """YouTube Data API v3 playlist resolver with pagination, quota-aware partial fallback, and title parsing."""

    source: PlaylistSource = "youtube"

    def __init__(
        self,
        client: httpx.AsyncClient,
        api_key: str,
        max_tracks: int = 200,
        timeout_seconds: float = 10.0,
        max_retries: int = 3,
        base_backoff_seconds: float = 0.35,
    ) -> None:
        self._client = client
        self._api_key = api_key.strip()
        self._max_tracks = max_tracks
        self._timeout = timeout_seconds
        self._max_retries = max_retries
        self._base_backoff_seconds = base_backoff_seconds

    async def _get_youtube_json(
        self, endpoint: str, params: dict[str, Any]
    ) -> dict[str, Any]:
        async def _attempt() -> dict[str, Any]:
            response = await self._client.get(
                f"{YOUTUBE_API_BASE}/{endpoint}",
                params={**params, "key": self._api_key},
                timeout=self._timeout,
            )
            if _is_quota_error(response):
                raise YouTubeQuotaExceededError("YouTube Data API quota exceeded")
            if response.status_code in {429, 500, 502, 503, 504}:
                raise TransientUpstreamError(f"YouTube status {response.status_code}")
            if response.status_code == 404:
                raise AppError(
                    status_code=404,
                    code="PLAYLIST_NOT_FOUND",
                    message="YouTube playlist not found or is set to private.",
                )
            if response.status_code == 400:
                raise AppError(
                    status_code=500,
                    code="YOUTUBE_CONFIG_ERROR",
                    message="YouTube API rejected the request. Verify YOUTUBE_API_KEY is valid.",
                )
            if _is_service_disabled_error(response):
                raise AppError(
                    status_code=503,
                    code="YOUTUBE_API_DISABLED",
                    message=(
                        "YouTube Data API v3 is not enabled yet for the configured Google Cloud "
                        "project. Enable YouTube Data API v3 in Google Cloud Console and retry."
                    ),
                )
            if response.status_code == 403:
                raise AppError(
                    status_code=404,
                    code="PLAYLIST_NOT_FOUND",
                    message="YouTube playlist is private or inaccessible.",
                )
            response.raise_for_status()
            data = response.json()
            if not isinstance(data, dict):
                raise AppError(
                    status_code=502,
                    code="UPSTREAM_ERROR",
                    message="Unexpected response from YouTube API.",
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
        except (AppError, YouTubeQuotaExceededError):
            raise
        except TransientUpstreamError as exc:
            raise AppError(
                status_code=503,
                code="UPSTREAM_RATE_LIMITED",
                message="YouTube API is temporarily busy. Please retry shortly.",
                headers={"Retry-After": "30"},
            ) from exc
        except httpx.TimeoutException as exc:
            raise AppError(
                status_code=504,
                code="UPSTREAM_TIMEOUT",
                message="Timed out contacting YouTube API.",
            ) from exc
        except httpx.HTTPError as exc:
            logger.warning("youtube_network_error", error=str(exc))
            raise AppError(
                status_code=502,
                code="UPSTREAM_NETWORK_ERROR",
                message="Unable to reach YouTube Data API.",
            ) from exc

    async def resolve(
        self, playlist_id: str, storefront: str | None = None
    ) -> PlaylistData:
        _ = storefront
        if not self._api_key:
            raise AppError(
                status_code=500,
                code="YOUTUBE_CONFIG_ERROR",
                message=(
                    "YouTube API key is not configured on the server. "
                    "Set YOUTUBE_API_KEY in the API environment."
                ),
            )

        collected_items: list[dict[str, Any]] = []
        next_page_token: str | None = None
        partial = False

        while True:
            params: dict[str, Any] = {
                "part": "snippet",
                "playlistId": playlist_id,
                "maxResults": 50,
            }
            if next_page_token:
                params["pageToken"] = next_page_token

            try:
                page = await self._get_youtube_json("playlistItems", params)
            except YouTubeQuotaExceededError as exc:
                if collected_items:
                    logger.warning(
                        "youtube_quota_exceeded_partial",
                        playlist_id=playlist_id,
                        fetched_count=len(collected_items),
                    )
                    partial = True
                    break
                raise AppError(
                    status_code=503,
                    code="YOUTUBE_QUOTA_EXCEEDED",
                    message=(
                        "YouTube Data API daily quota has been exceeded. "
                        "Please try again later or try a Spotify or Deezer playlist."
                    ),
                    headers={"Retry-After": "3600"},
                ) from exc

            page_info = page.get("pageInfo") or {}
            total_results = page_info.get("totalResults")
            if isinstance(total_results, int) and total_results > self._max_tracks:
                raise AppError(
                    status_code=422,
                    code="PLAYLIST_TOO_LARGE",
                    message=(
                        f"This playlist has {total_results} tracks, which exceeds the maximum "
                        f"limit of {self._max_tracks} tracks."
                    ),
                )

            page_items = page.get("items") or []
            if len(collected_items) + len(page_items) > self._max_tracks:
                raise AppError(
                    status_code=422,
                    code="PLAYLIST_TOO_LARGE",
                    message=(
                        f"This playlist exceeds the maximum limit of {self._max_tracks} tracks."
                    ),
                )
            collected_items.extend(page_items)

            next_page_token = page.get("nextPageToken")
            if not isinstance(next_page_token, str) or not next_page_token:
                break

        # Best-effort playlist title/owner lookup (skip if quota already hit)
        playlist_meta: dict[str, Any] | None = None
        if not partial:
            try:
                meta_resp = await self._get_youtube_json(
                    "playlists", {"part": "snippet", "id": playlist_id}
                )
                meta_items = meta_resp.get("items") or []
                if meta_items and isinstance(meta_items[0], dict):
                    playlist_meta = meta_items[0]
            except (YouTubeQuotaExceededError, AppError):
                playlist_meta = None

        return normalize_youtube_playlist(
            playlist_id=playlist_id,
            items=collected_items,
            playlist_meta=playlist_meta,
            partial=partial,
            max_tracks=self._max_tracks,
        )
