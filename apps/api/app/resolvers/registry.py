from __future__ import annotations

import httpx

from app.config import Settings
from app.errors import AppError
from app.resolvers.base import PlaylistResolver, parse_playlist_url
from app.resolvers.deezer import DeezerResolver
from app.resolvers.spotify import SpotifyResolver
from app.resolvers.youtube import YouTubeResolver
from app.schemas import PlaylistData, PlaylistSource


class ResolverRegistry:
    """
    Protocol-based router dispatching URLs to the matching PlaylistResolver.
    Adding a new platform requires only one new resolver file registered here.
    """

    def __init__(self, resolvers: list[PlaylistResolver]) -> None:
        self._resolvers: dict[PlaylistSource, PlaylistResolver] = {
            resolver.source: resolver for resolver in resolvers
        }

    async def resolve_url(self, url: str) -> PlaylistData:
        target = parse_playlist_url(url)
        resolver = self._resolvers.get(target.source)
        if resolver is None:
            raise AppError(
                status_code=400,
                code="UNSUPPORTED_PLATFORM",
                message=f"No resolver registered for platform '{target.source}'.",
            )
        return await resolver.resolve(
            playlist_id=target.playlist_id,
            storefront=target.storefront,
        )


def build_default_resolver_registry(
    client: httpx.AsyncClient,
    settings: Settings,
) -> ResolverRegistry:
    resolvers: list[PlaylistResolver] = [
        DeezerResolver(
            client=client,
            max_tracks=settings.max_playlist_tracks,
            timeout_seconds=settings.provider_timeout_seconds,
        ),
        SpotifyResolver(
            client=client,
            client_id=settings.spotify_client_id,
            client_secret=settings.spotify_client_secret,
            max_tracks=settings.max_playlist_tracks,
            timeout_seconds=settings.provider_timeout_seconds,
        ),
        YouTubeResolver(
            client=client,
            api_key=settings.youtube_api_key,
            max_tracks=settings.max_playlist_tracks,
            timeout_seconds=settings.provider_timeout_seconds,
        ),
    ]
    return ResolverRegistry(resolvers)
