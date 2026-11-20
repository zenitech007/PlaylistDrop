from __future__ import annotations

import httpx

from app.config import Settings
from app.providers.base import TrackSourceProvider
from app.providers.jamendo import JamendoProvider
from app.schemas import MatchResult, Track


class ProviderRegistry:
    """
    Coordinates multiple TrackSourceProvider implementations.
    To add FMA, SoundCloud CC, or Internet Archive later, simply register another
    TrackSourceProvider instance here without modifying route handlers.
    """

    def __init__(self, providers: list[TrackSourceProvider]) -> None:
        self._providers = providers

    @property
    def providers(self) -> list[TrackSourceProvider]:
        return list(self._providers)

    async def match_tracks(self, tracks: list[Track]) -> list[MatchResult]:
        best_by_track_id: dict[str, MatchResult] = {}
        remaining = list(tracks)

        for provider in self._providers:
            if not remaining:
                break
            provider_matches = await provider.match(remaining)
            for match in provider_matches:
                existing = best_by_track_id.get(match.trackId)
                if existing is None or match.score > existing.score:
                    best_by_track_id[match.trackId] = match

            # Only query secondary providers for tracks not already exact-matched
            remaining = [
                t
                for t in tracks
                if t.id not in best_by_track_id or best_by_track_id[t.id].score < 1.0
            ]

        # Preserve input track order
        ordered: list[MatchResult] = []
        for track in tracks:
            if track.id in best_by_track_id:
                ordered.append(best_by_track_id[track.id])
        return ordered


def build_default_provider_registry(
    client: httpx.AsyncClient,
    settings: Settings,
) -> ProviderRegistry:
    providers: list[TrackSourceProvider] = [
        JamendoProvider(
            client=client,
            client_id=settings.jamendo_client_id,
            max_concurrency=settings.max_match_concurrency,
            timeout_seconds=settings.provider_timeout_seconds,
        ),
        # Future providers (FMAProvider, SoundCloudCCProvider) plug in right here.
    ]
    return ProviderRegistry(providers)
