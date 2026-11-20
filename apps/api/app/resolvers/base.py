from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Protocol
from urllib.parse import parse_qs, urlparse

from app.errors import AppError
from app.schemas import PlaylistData, PlaylistSource

DEEZER_PATH_RE = re.compile(r"^/(?:(?P<country>[a-zA-Z]{2})/)?playlist/(?P<playlist_id>\d+)$")
SPOTIFY_PATH_RE = re.compile(
    r"^/(?:intl-[a-zA-Z0-9-]+/)?playlist/(?P<playlist_id>[a-zA-Z0-9]{10,64})$"
)
SPOTIFY_URI_RE = re.compile(r"^spotify:playlist:(?P<playlist_id>[a-zA-Z0-9]{10,64})$")
YOUTUBE_LIST_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{10,128}$")

YOUTUBE_NOISE_RE = re.compile(
    r"\s*[\(\[]\s*(?:"
    r"official\s+(?:music\s+)?video|official\s+audio|official\s+lyric\s+video|"
    r"lyric\s+video|lyrics?|audio|hd|4k|hq|visualizer|music\s+video|"
    r"full\s+video|explicit|clean\s+version|live\s+performance|remastered(?:\s+\d{4})?"
    r")\s*[\)\]]",
    re.IGNORECASE,
)
YOUTUBE_PIPE_SUFFIX_RE = re.compile(
    r"\s*\|\s*(?:official.*|lyrics?.*|audio.*|hd.*|4k.*)$",
    re.IGNORECASE,
)
YOUTUBE_SEPARATOR_RE = re.compile(r"\s+(?:-|–|—|\|)\s+|:\s+")
CHANNEL_TOPIC_SUFFIX_RE = re.compile(r"\s*-\s*Topic$", re.IGNORECASE)
CHANNEL_VEVO_SUFFIX_RE = re.compile(r"(?:VEVO|Official)$", re.IGNORECASE)

SUPPORTED_PLATFORMS_MSG = (
    "Unsupported or malformed playlist URL. Supported platforms: "
    "Deezer (deezer.com/playlist/{id}), "
    "Spotify (open.spotify.com/playlist/{id} or spotify:playlist:{id}), "
    "and YouTube (youtube.com/playlist?list={id}, music.youtube.com/..., youtu.be/{video}?list={id})."
)


class TransientUpstreamError(Exception):
    """Raised on transient upstream 5xx/429/network errors eligible for exponential backoff."""


class PlaylistResolver(Protocol):
    """Protocol implemented by every playlist platform resolver (Deezer, Spotify, YouTube, etc.)."""

    source: PlaylistSource

    async def resolve(
        self, playlist_id: str, storefront: str | None = None
    ) -> PlaylistData:
        ...


@dataclass(frozen=True)
class ParsedPlaylistTarget:
    source: PlaylistSource
    playlist_id: str
    storefront: str | None = None


def parse_playlist_url(raw_url: str) -> ParsedPlaylistTarget:
    """
    Detect the playlist platform and extract playlist ID + optional storefront.
    Rejects unknown or malformed URLs with HTTP 400 listing supported platforms.
    """
    value = raw_url.strip()
    if not value:
        raise AppError(
            status_code=400,
            code="UNSUPPORTED_PLAYLIST_URL",
            message=SUPPORTED_PLATFORMS_MSG,
        )

    # Spotify URI: spotify:playlist:{id}
    uri_match = SPOTIFY_URI_RE.match(value)
    if uri_match:
        return ParsedPlaylistTarget(
            source="spotify",
            playlist_id=uri_match.group("playlist_id"),
            storefront=None,
        )

    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"}:
        raise AppError(
            status_code=400,
            code="UNSUPPORTED_PLAYLIST_URL",
            message=SUPPORTED_PLATFORMS_MSG,
        )

    host = (parsed.hostname or "").lower()
    path = parsed.path.rstrip("/")

    # Deezer: deezer.com/{country?}/playlist/{id}, www.deezer.com
    if host in {"deezer.com", "www.deezer.com"}:
        match = DEEZER_PATH_RE.match(path)
        if match:
            country = match.group("country")
            return ParsedPlaylistTarget(
                source="deezer",
                playlist_id=match.group("playlist_id"),
                storefront=country.lower() if country else None,
            )

    # Spotify: open.spotify.com/playlist/{id}
    if host == "open.spotify.com":
        match = SPOTIFY_PATH_RE.match(path)
        if match:
            return ParsedPlaylistTarget(
                source="spotify",
                playlist_id=match.group("playlist_id"),
                storefront=None,
            )

    # YouTube: youtube.com/playlist?list={id}, music.youtube.com/..., youtu.be/{video}?list={id}
    if host in {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"}:
        query = parse_qs(parsed.query)
        list_values = query.get("list") or []
        playlist_id = list_values[0].strip() if list_values else ""
        valid_path = (
            (host == "youtu.be" and len(path.strip("/")) >= 1)
            or path in {"/playlist", "/watch"}
        )
        if valid_path and playlist_id and YOUTUBE_LIST_ID_RE.match(playlist_id):
            return ParsedPlaylistTarget(
                source="youtube",
                playlist_id=playlist_id,
                storefront=None,
            )

    raise AppError(
        status_code=400,
        code="UNSUPPORTED_PLAYLIST_URL",
        message=SUPPORTED_PLATFORMS_MSG,
    )


def _clean_channel_name(channel_name: str) -> str:
    cleaned = CHANNEL_TOPIC_SUFFIX_RE.sub("", channel_name.strip()).strip()
    if len(cleaned) > 5 and CHANNEL_VEVO_SUFFIX_RE.search(cleaned):
        candidate = CHANNEL_VEVO_SUFFIX_RE.sub("", cleaned).strip(" -")
        if candidate:
            cleaned = candidate
    return cleaned or "Unknown Artist"


def parse_youtube_title(raw_title: str, channel_name: str) -> tuple[str, str]:
    """
    Pure parser converting messy YouTube video titles into (artist, title).
    Supports 'Artist - Title', 'Artist – Title', 'Artist — Title', and 'Artist: Title'
    patterns, strips common video/audio tags, and falls back to the cleaned channel name.
    """
    cleaned = YOUTUBE_NOISE_RE.sub("", raw_title.strip())
    cleaned = YOUTUBE_PIPE_SUFFIX_RE.sub("", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" -–—:")

    if not cleaned:
        return (_clean_channel_name(channel_name), raw_title.strip() or "Untitled Track")

    parts = YOUTUBE_SEPARATOR_RE.split(cleaned, maxsplit=1)
    if len(parts) == 2:
        artist_part = parts[0].strip(" -–—:\"'")
        title_part = parts[1].strip(" -–—:\"'")
        if artist_part and title_part:
            return (artist_part, title_part)

    return (_clean_channel_name(channel_name), cleaned)
