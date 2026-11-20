from __future__ import annotations

import asyncio
import re
import time
import unicodedata
from difflib import SequenceMatcher
from typing import Awaitable, Callable, Protocol, TypeVar

from app.schemas import MatchResult, Track

T = TypeVar("T")

PARENS_RE = re.compile(r"\s*[\(\[].*?[\)\]]\s*")
NON_WORD_RE = re.compile(r"[^a-z0-9\s]+")
WHITESPACE_RE = re.compile(r"\s+")

CC_LICENSE_URL_RE = re.compile(
    r"creativecommons\.org/(?:licenses/(?P<kind>[a-z-]+)/(?P<ver>[0-9.]+)|publicdomain/zero/(?P<cc0>[0-9.]+))",
    re.IGNORECASE,
)


class TrackSourceProvider(Protocol):
    """Protocol implemented by every free/CC track catalog provider (Jamendo, FMA, SoundCloud, etc.)."""

    name: str

    async def match(self, tracks: list[Track]) -> list[MatchResult]:
        ...


def normalize_music_text(value: str) -> str:
    """Normalize track titles and artist names for deterministic + fuzzy matching."""
    ascii_text = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    cleaned = ascii_text.lower()
    cleaned = cleaned.replace("&", " and ")
    cleaned = re.sub(r"\b(?:feat\.?|ft\.?|featuring)\b.*$", "", cleaned)
    cleaned = PARENS_RE.sub(" ", cleaned)
    cleaned = NON_WORD_RE.sub(" ", cleaned)
    return WHITESPACE_RE.sub(" ", cleaned).strip()


def score_track_match(
    query_title: str,
    query_artist: str,
    candidate_title: str,
    candidate_artist: str,
) -> float:
    """
    Score candidate track match against query track.
    Exact normalized title + artist returns 1.0; fuzzy similarity otherwise (0.0..0.99).
    """
    q_title = normalize_music_text(query_title)
    q_artist = normalize_music_text(query_artist)
    c_title = normalize_music_text(candidate_title)
    c_artist = normalize_music_text(candidate_artist)

    if not q_title or not q_artist or not c_title or not c_artist:
        return 0.0

    if q_title == c_title and q_artist == c_artist:
        return 1.0

    title_ratio = SequenceMatcher(None, q_title, c_title).ratio()
    artist_ratio = SequenceMatcher(None, q_artist, c_artist).ratio()

    # Weight title slightly higher while requiring strong artist agreement
    if artist_ratio < 0.6 or title_ratio < 0.6:
        return round(min(title_ratio, artist_ratio), 4)

    weighted = (title_ratio * 0.55) + (artist_ratio * 0.45)
    # Reserve 1.0 strictly for exact normalized matches
    return round(min(weighted, 0.99), 4)


def parse_cc_license(license_url: str | None) -> str | None:
    """
    Validate that a license URL is a recognized Creative Commons license allowing free download.
    Returns a clean label like 'CC BY-NC-SA 3.0' or None if not a valid CC license.
    """
    if not license_url:
        return None
    match = CC_LICENSE_URL_RE.search(license_url)
    if not match:
        return None
    if match.group("cc0"):
        return f"CC0 {match.group('cc0')}"
    kind = match.group("kind").upper()
    version = match.group("ver")
    return f"CC {kind} {version}"


class AsyncRateLimiter:
    """Simple async spacing rate limiter per provider."""

    def __init__(self, calls_per_second: float) -> None:
        self._min_interval = 1.0 / max(calls_per_second, 0.1)
        self._lock = asyncio.Lock()
        self._last_call = 0.0

    async def acquire(self) -> None:
        async with self._lock:
            now = time.monotonic()
            wait_time = self._min_interval - (now - self._last_call)
            if wait_time > 0:
                await asyncio.sleep(wait_time)
            self._last_call = time.monotonic()


async def retry_with_backoff(
    operation: Callable[[], Awaitable[T]],
    max_attempts: int = 3,
    base_delay_seconds: float = 0.35,
    retryable_exceptions: tuple[type[BaseException], ...] = (Exception,),
) -> T:
    """Execute an async operation with exponential backoff up to max_attempts."""
    last_error: BaseException | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            return await operation()
        except retryable_exceptions as exc:
            last_error = exc
            if attempt >= max_attempts:
                break
            delay = base_delay_seconds * (2 ** (attempt - 1))
            await asyncio.sleep(delay)
    assert last_error is not None
    raise last_error
