from __future__ import annotations

import ipaddress
import re
import time
import unicodedata
from dataclasses import dataclass
from urllib.parse import urlparse

from app.errors import AppError

SLUG_NON_ALNUM_RE = re.compile(r"[^a-z0-9]+")


@dataclass(frozen=True)
class RegisteredMatch:
    track_id: str
    download_url: str
    hostname: str
    filename: str
    source: str
    expires_at: float


def sanitize_filename(raw_name: str, default_ext: str = ".mp3") -> str:
    """Slugify a filename, strip any path traversal characters, and enforce a safe extension."""
    # Remove directory components and null bytes
    cleaned = raw_name.replace("\x00", "").replace("\\", "/")
    cleaned = cleaned.split("/")[-1]
    cleaned = cleaned.replace("..", "")

    # Separate extension if safe audio extension is present
    ext = default_ext
    lower = cleaned.lower()
    for candidate_ext in (".mp3", ".flac", ".ogg", ".wav", ".m4a"):
        if lower.endswith(candidate_ext):
            ext = candidate_ext
            cleaned = cleaned[: -len(candidate_ext)]
            break

    normalized = unicodedata.normalize("NFKD", cleaned).encode("ascii", "ignore").decode("ascii")
    slug = SLUG_NON_ALNUM_RE.sub("-", normalized.lower()).strip("-")
    if not slug:
        slug = "track"

    # Keep filenames compact and filesystem-safe
    slug = slug[:120].rstrip("-") or "track"
    return f"{slug}{ext}"


def _is_forbidden_host(hostname: str) -> bool:
    """Block localhost, loopback, link-local, and private IP literals."""
    lower = hostname.lower().strip(".")
    if not lower or lower in {"localhost", "ip6-localhost", "metadata.google.internal"}:
        return True
    if lower.endswith(".local") or lower.endswith(".internal"):
        return True

    try:
        ip = ipaddress.ip_address(lower)
        return (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_multicast
            or ip.is_reserved
            or ip.is_unspecified
        )
    except ValueError:
        return False


class MatchedUrlRegistry:
    """In-memory SSRF allow-list of matched track download URLs with a 10-minute TTL."""

    def __init__(
        self,
        ttl_seconds: int = 600,
        allowed_domains: tuple[str, ...] = (),
    ) -> None:
        self._ttl_seconds = ttl_seconds
        self._allowed_domains = frozenset(d.lower().strip(".") for d in allowed_domains if d.strip())
        self._by_url: dict[str, RegisteredMatch] = {}
        self._by_track_id: dict[str, RegisteredMatch] = {}
        self._registered_hosts: dict[str, float] = {}

    def _purge_expired(self, now: float | None = None) -> None:
        current = now if now is not None else time.monotonic()
        expired_urls = [url for url, entry in self._by_url.items() if entry.expires_at <= current]
        for url in expired_urls:
            self._by_url.pop(url, None)

        expired_tracks = [
            tid for tid, entry in self._by_track_id.items() if entry.expires_at <= current
        ]
        for tid in expired_tracks:
            self._by_track_id.pop(tid, None)

        expired_hosts = [
            host for host, exp in self._registered_hosts.items() if exp <= current
        ]
        for host in expired_hosts:
            self._registered_hosts.pop(host, None)

    def register(
        self,
        track_id: str,
        download_url: str,
        artist: str,
        title: str,
        source: str,
    ) -> RegisteredMatch:
        parsed = urlparse(download_url)
        if parsed.scheme not in {"https", "http"} or not parsed.hostname:
            raise ValueError("Invalid download URL.")
        hostname = parsed.hostname.lower().strip(".")
        if _is_forbidden_host(hostname):
            raise ValueError("Refusing to register non-public host.")

        expires_at = time.monotonic() + self._ttl_seconds
        filename = sanitize_filename(f"{artist} - {title}")
        entry = RegisteredMatch(
            track_id=track_id,
            download_url=download_url,
            hostname=hostname,
            filename=filename,
            source=source,
            expires_at=expires_at,
        )
        self._by_url[download_url] = entry
        self._by_track_id[track_id] = entry
        self._registered_hosts[hostname] = expires_at
        return entry

    def get_by_track_id(self, track_id: str) -> RegisteredMatch | None:
        self._purge_expired()
        return self._by_track_id.get(track_id)

    def validate_download_url(self, download_url: str) -> RegisteredMatch | None:
        """
        Validate that a download URL is permitted by the SSRF guard.

        Allows:
          1. Exact URL or hostname returned by a recent match (within 10-min TTL), OR
          2. Hostname explicitly listed in allowed_download_domains.
        Rejects everything else (including private IPs, file://, metadata endpoints) with HTTP 400.
        """
        self._purge_expired()
        parsed = urlparse(download_url.strip())

        if parsed.scheme not in {"https", "http"}:
            raise AppError(
                status_code=400,
                code="INVALID_DOWNLOAD_URL",
                message="Only HTTP/HTTPS audio download URLs are permitted.",
            )

        if parsed.username or parsed.password:
            raise AppError(
                status_code=400,
                code="INVALID_DOWNLOAD_URL",
                message="Credentials in download URLs are not permitted.",
            )

        hostname = (parsed.hostname or "").lower().strip(".")
        if not hostname or _is_forbidden_host(hostname):
            raise AppError(
                status_code=400,
                code="SSRF_BLOCKED",
                message="Download host is not permitted.",
            )

        exact_match = self._by_url.get(download_url.strip())
        if exact_match is not None:
            return exact_match

        if hostname in self._registered_hosts or hostname in self._allowed_domains:
            return None

        raise AppError(
            status_code=400,
            code="SSRF_BLOCKED",
            message=(
                "Download URL is not from a verified matched track or allowed catalog domain."
            ),
        )
