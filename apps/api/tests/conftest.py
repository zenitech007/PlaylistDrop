from __future__ import annotations

import pytest

from app.config import Settings


@pytest.fixture
def test_settings() -> Settings:
    return Settings(
        spotify_client_id="test-spotify-client-id",
        spotify_client_secret="test-spotify-client-secret",
        youtube_api_key="test-youtube-api-key",
        jamendo_client_id="test-jamendo-client-id",
        cors_origins="http://localhost:3000",
        rate_limit_per_minute=100,
        max_playlist_tracks=200,
        max_download_mb=50,
        match_registry_ttl_seconds=600,
        provider_timeout_seconds=5.0,
        max_match_concurrency=5,
    )
