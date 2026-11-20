from __future__ import annotations

import httpx
import pytest

from app.providers.base import parse_cc_license, score_track_match
from app.providers.jamendo import JamendoProvider
from app.schemas import Track


def test_score_track_match_exact_returns_one() -> None:
    score = score_track_match(
        query_title="Midnight Horizon (Remastered)",
        query_artist="Solaris & Friends",
        candidate_title="Midnight Horizon",
        candidate_artist="Solaris and Friends",
    )
    assert score == 1.0


def test_score_track_match_fuzzy_above_and_below_threshold() -> None:
    high_score = score_track_match(
        query_title="Electric Dreams",
        query_artist="Nova Pulse",
        candidate_title="Electric Dream",
        candidate_artist="Nova Pulse",
    )
    assert 0.8 <= high_score < 1.0

    low_score = score_track_match(
        query_title="Electric Dreams",
        query_artist="Nova Pulse",
        candidate_title="Acoustic Lullaby",
        candidate_artist="Different Band",
    )
    assert low_score < 0.8


def test_parse_cc_license_accepts_cc_and_rejects_proprietary() -> None:
    assert (
        parse_cc_license("http://creativecommons.org/licenses/by-nc-sa/3.0/")
        == "CC BY-NC-SA 3.0"
    )
    assert (
        parse_cc_license("https://creativecommons.org/publicdomain/zero/1.0/")
        == "CC0 1.0"
    )
    assert parse_cc_license("https://example.com/all-rights-reserved") is None
    assert parse_cc_license(None) is None


@pytest.mark.asyncio
async def test_jamendo_provider_filters_license_and_threshold() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "results": [
                    {
                        "id": "j1",
                        "name": "Sunset Drive",
                        "artist_name": "Lumen",
                        "audiodownload_allowed": True,
                        "audiodownload": "https://mp3d.jamendo.com/download/track/j1/mp32/",
                        "license_ccurl": "http://creativecommons.org/licenses/by/3.0/",
                    },
                    {
                        "id": "j2",
                        "name": "Sunset Drive",
                        "artist_name": "Lumen",
                        "audiodownload_allowed": False,
                        "audiodownload": "https://mp3d.jamendo.com/download/track/j2/mp32/",
                        "license_ccurl": "http://creativecommons.org/licenses/by/3.0/",
                    },
                    {
                        "id": "j3",
                        "name": "Completely Unrelated",
                        "artist_name": "Other",
                        "audiodownload_allowed": True,
                        "audiodownload": "https://mp3d.jamendo.com/download/track/j3/mp32/",
                        "license_ccurl": "http://creativecommons.org/licenses/by/3.0/",
                    },
                ]
            },
        )

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        provider = JamendoProvider(
            client=client,
            client_id="fake-client-id",
            calls_per_second=100.0,
            base_backoff_seconds=0.01,
        )
        tracks = [
            Track(
                id="am-1",
                name="Sunset Drive",
                artist="Lumen",
                album="Glow",
                durationMs=200000,
            )
        ]
        matches = await provider.match(tracks)

    assert len(matches) == 1
    assert matches[0].trackId == "am-1"
    assert matches[0].source == "jamendo"
    assert matches[0].license == "CC BY 3.0"
    assert matches[0].score == 1.0
    assert matches[0].downloadUrl == "https://mp3d.jamendo.com/download/track/j1/mp32/"
