from __future__ import annotations

import asyncio
from typing import Any

import httpx

from app.logging_config import get_logger
from app.providers.base import (
    AsyncRateLimiter,
    parse_cc_license,
    retry_with_backoff,
    score_track_match,
)
from app.schemas import MatchResult, Track

logger = get_logger(__name__)

JAMENDO_TRACKS_API = "https://api.jamendo.com/v3.0/tracks/"
ACCEPTANCE_SCORE_THRESHOLD = 0.8


class JamendoRateLimitError(Exception):
    """Raised when Jamendo signals temporary throttling so backoff can retry."""


class JamendoProvider:
    """Creative Commons track matcher backed by the Jamendo v3.0 public catalog API."""

    name = "jamendo"

    def __init__(
        self,
        client: httpx.AsyncClient,
        client_id: str,
        max_concurrency: int = 5,
        timeout_seconds: float = 10.0,
        calls_per_second: float = 8.0,
        max_retries: int = 3,
        base_backoff_seconds: float = 0.35,
    ) -> None:
        self._client = client
        self._client_id = client_id.strip()
        self._semaphore = asyncio.Semaphore(max(1, max_concurrency))
        self._timeout = timeout_seconds
        self._rate_limiter = AsyncRateLimiter(calls_per_second)
        self._max_retries = max_retries
        self._base_backoff_seconds = base_backoff_seconds

    async def match(self, tracks: list[Track]) -> list[MatchResult]:
        if not self._client_id:
            logger.warning("jamendo_client_id_missing")
            return []

        tasks = [self._match_single_bounded(track) for track in tracks]
        results = await asyncio.gather(*tasks)
        return [result for result in results if result is not None]

    async def _match_single_bounded(self, track: Track) -> MatchResult | None:
        async with self._semaphore:
            try:
                return await self._match_single(track)
            except Exception as exc:
                logger.warning(
                    "jamendo_track_match_failed",
                    track_id=track.id,
                    error=str(exc),
                )
                return None

    async def _query_jamendo(self, params: dict[str, Any]) -> list[dict[str, Any]]:
        async def _attempt() -> list[dict[str, Any]]:
            await self._rate_limiter.acquire()
            response = await self._client.get(
                JAMENDO_TRACKS_API,
                params=params,
                timeout=self._timeout,
            )
            if response.status_code in {429, 500, 502, 503, 504}:
                raise JamendoRateLimitError(f"Jamendo transient status {response.status_code}")
            response.raise_for_status()
            payload = response.json()
            results = payload.get("results")
            return results if isinstance(results, list) else []

        return await retry_with_backoff(
            _attempt,
            max_attempts=self._max_retries,
            base_delay_seconds=self._base_backoff_seconds,
            retryable_exceptions=(
                httpx.TimeoutException,
                httpx.TransportError,
                JamendoRateLimitError,
            ),
        )

    async def _match_single(self, track: Track) -> MatchResult | None:
        params: dict[str, Any] = {
            "client_id": self._client_id,
            "format": "json",
            "limit": 5,
            "namesearch": track.name,
            "artist_name": track.artist,
            "audioformat": "mp32",
            "include": "licenses",
        }
        candidates = await self._query_jamendo(params)

        # Fallback broader query if strict artist_name returned no rows
        if not candidates:
            fallback_params: dict[str, Any] = {
                "client_id": self._client_id,
                "format": "json",
                "limit": 5,
                "search": f"{track.artist} {track.name}",
                "audioformat": "mp32",
                "include": "licenses",
            }
            candidates = await self._query_jamendo(fallback_params)

        best_match: MatchResult | None = None
        for item in candidates:
            if not isinstance(item, dict):
                continue

            if not item.get("audiodownload_allowed", False):
                continue

            download_url = str(item.get("audiodownload") or "").strip()
            if not download_url.startswith(("https://", "http://")):
                continue

            cc_license = parse_cc_license(item.get("license_ccurl"))
            if not cc_license:
                continue

            candidate_title = str(item.get("name") or "")
            candidate_artist = str(item.get("artist_name") or "")
            score = score_track_match(
                query_title=track.name,
                query_artist=track.artist,
                candidate_title=candidate_title,
                candidate_artist=candidate_artist,
            )

            if score < ACCEPTANCE_SCORE_THRESHOLD:
                continue

            # Jamendo mp32 format is VBR MP3 (~192-320 kbps); use 192 as conservative default
            bitrate = 192
            if best_match is None or score > best_match.score:
                best_match = MatchResult(
                    trackId=track.id,
                    source=self.name,
                    downloadUrl=download_url,
                    license=cc_license,
                    bitrateKbps=bitrate,
                    score=score,
                )

        return best_match
