from __future__ import annotations

import httpx
import pytest

from app.errors import AppError
from app.main import create_app
from app.resolvers.base import parse_playlist_url, parse_youtube_title
from app.resolvers.deezer import normalize_deezer_playlist
from app.resolvers.spotify import SpotifyResolver, normalize_spotify_playlist
from app.resolvers.youtube import YouTubeResolver, normalize_youtube_playlist


@pytest.mark.parametrize(
    ("url", "expected_source", "expected_id", "expected_storefront"),
    [
        ("https://www.deezer.com/en/playlist/908622995", "deezer", "908622995", "en"),
        ("https://deezer.com/playlist/123456789?utm=share", "deezer", "123456789", None),
        (
            "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc",
            "spotify",
            "37i9dQZF1DXcBWIGoYBM5M",
            None,
        ),
        ("spotify:playlist:37i9dQZF1DXcBWIGoYBM5M", "spotify", "37i9dQZF1DXcBWIGoYBM5M", None),
        (
            "https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI",
            "youtube",
            "PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI",
            None,
        ),
        (
            "https://music.youtube.com/playlist?list=PL1234567890abcdef",
            "youtube",
            "PL1234567890abcdef",
            None,
        ),
        (
            "https://youtu.be/dQw4w9WgXcQ?list=PL1234567890abcdef",
            "youtube",
            "PL1234567890abcdef",
            None,
        ),
    ],
)
def test_parse_playlist_url_supports_all_three_platforms(
    url: str,
    expected_source: str,
    expected_id: str,
    expected_storefront: str | None,
) -> None:
    parsed = parse_playlist_url(url)
    assert parsed.source == expected_source
    assert parsed.playlist_id == expected_id
    assert parsed.storefront == expected_storefront


@pytest.mark.parametrize(
    "bad_url",
    [
        "",
        "not-a-url",
        "https://music.apple.com/us/playlist/demo/pl.u-1234",
        "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT",
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        "https://deezer.com/album/123456",
        "ftp://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M",
    ],
)
def test_parse_playlist_url_rejects_malformed_with_400_and_platform_list(bad_url: str) -> None:
    with pytest.raises(AppError) as exc_info:
        parse_playlist_url(bad_url)
    assert exc_info.value.status_code == 400
    msg = exc_info.value.message.lower()
    assert "deezer" in msg
    assert "spotify" in msg
    assert "youtube" in msg


@pytest.mark.parametrize(
    ("raw_title", "channel", "expected_artist", "expected_title"),
    [
        ("Lumen Echo - Solar Drift (Official Video)", "LumenEchoVEVO", "Lumen Echo", "Solar Drift"),
        ("Maren Sol: Quiet Harbor [Official Audio]", "Indie Uploads", "Maren Sol", "Quiet Harbor"),
        ("Koda — Midnight Rain (Lyrics) [HD]", "Koda Official", "Koda", "Midnight Rain"),
        ("Ambient Study Session", "ChilledCow - Topic", "ChilledCow", "Ambient Study Session"),
        ("Night Sky (Official Music Video)", "SynthWaveVEVO", "SynthWave", "Night Sky"),
    ],
)
def test_parse_youtube_title_pure_function(
    raw_title: str,
    channel: str,
    expected_artist: str,
    expected_title: str,
) -> None:
    artist, title = parse_youtube_title(raw_title, channel)
    assert artist == expected_artist
    assert title == expected_title


def test_normalize_deezer_playlist_and_cap() -> None:
    payload = {
        "id": 908622995,
        "title": "Indie Chill",
        "nb_tracks": 1,
        "picture_big": "https://e-cdns-images.dzcdn.net/images/playlist/cover.jpg",
        "creator": {"name": "Deezer Editor"},
        "tracks": {
            "data": [
                {
                    "id": 111,
                    "title": "Solar Drift",
                    "duration": 205,
                    "artist": {"name": "Lumen Echo"},
                    "album": {
                        "title": "Horizons",
                        "cover_medium": "https://e-cdns-images.dzcdn.net/images/cover/a.jpg",
                    },
                }
            ]
        },
    }
    data = normalize_deezer_playlist(payload)
    assert data.source == "deezer"
    assert data.name == "Indie Chill"
    assert data.owner == "Deezer Editor"
    assert data.partial is False
    assert len(data.tracks) == 1
    assert data.tracks[0].durationMs == 205000

    with pytest.raises(AppError) as exc_info:
        normalize_deezer_playlist({**payload, "nb_tracks": 250}, max_tracks=200)
    assert exc_info.value.status_code == 422


def test_normalize_spotify_playlist() -> None:
    payload = {
        "id": "37i9dQZF1DXcBWIGoYBM5M",
        "name": "Creative Focus",
        "owner": {"display_name": "Spotify Curator"},
        "images": [{"url": "https://i.scdn.co/image/pl300", "width": 300}],
        "tracks": {
            "total": 1,
            "items": [
                {
                    "track": {
                        "id": "sp1",
                        "name": "Morning Glow",
                        "duration_ms": 195000,
                        "artists": [{"name": "Nora Vale"}],
                        "album": {
                            "name": "Daybreak",
                            "images": [{"url": "https://i.scdn.co/image/ab300", "width": 300}],
                        },
                    }
                }
            ],
        },
    }
    data = normalize_spotify_playlist(payload)
    assert data.source == "spotify"
    assert data.owner == "Spotify Curator"
    assert len(data.tracks) == 1
    assert data.tracks[0].artist == "Nora Vale"


def test_normalize_youtube_playlist_skips_deleted_and_parses_titles() -> None:
    items = [
        {
            "id": "item1",
            "snippet": {
                "title": "Aether - Cloud Nine (Official Audio)",
                "videoOwnerChannelTitle": "Aether - Topic",
                "resourceId": {"videoId": "vid1"},
                "thumbnails": {"medium": {"url": "https://i.ytimg.com/vi/vid1/mqdefault.jpg"}},
            },
        },
        {
            "id": "item2",
            "snippet": {
                "title": "Deleted video",
                "resourceId": {"videoId": "vid2"},
            },
        },
    ]
    data = normalize_youtube_playlist("PL1234567890", items, partial=True)
    assert data.source == "youtube"
    assert data.partial is True
    assert len(data.tracks) == 1
    assert data.tracks[0].artist == "Aether"
    assert data.tracks[0].name == "Cloud Nine"


@pytest.mark.asyncio
async def test_deezer_resolver_maps_error_800_to_404(test_settings) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"error": {"type": "DataException", "message": "no data", "code": 800}})

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as mocked_http:
        app = create_app(settings=test_settings, http_client=mocked_http)
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                resp = await client.post(
                    "/api/resolve",
                    json={"url": "https://www.deezer.com/us/playlist/999999999"},
                )

    assert resp.status_code == 404
    assert resp.json()["error"]["code"] == "PLAYLIST_NOT_FOUND"


@pytest.mark.asyncio
async def test_spotify_resolver_caches_token_and_resolves_playlist() -> None:
    token_calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal token_calls
        if str(request.url) == "https://accounts.spotify.com/api/token":
            token_calls += 1
            return httpx.Response(200, json={"access_token": "tok-123", "expires_in": 3600})
        if "playlists/37i9dQZF1DXcBWIGoYBM5M" in str(request.url):
            assert request.headers["Authorization"] == "Bearer tok-123"
            return httpx.Response(
                200,
                json={
                    "id": "37i9dQZF1DXcBWIGoYBM5M",
                    "name": "Test Spotify",
                    "owner": {"display_name": "Tester"},
                    "images": [],
                    "tracks": {
                        "total": 1,
                        "items": [
                            {
                                "track": {
                                    "id": "t1",
                                    "name": "Horizon",
                                    "duration_ms": 180000,
                                    "artists": [{"name": "Koda"}],
                                    "album": {"name": "Sky", "images": []},
                                }
                            }
                        ],
                    },
                },
            )
        return httpx.Response(404)

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        resolver = SpotifyResolver(
            client=client,
            client_id="cid",
            client_secret="csec",
            base_backoff_seconds=0.01,
        )
        first = await resolver.resolve("37i9dQZF1DXcBWIGoYBM5M")
        second = await resolver.resolve("37i9dQZF1DXcBWIGoYBM5M")

    assert first.name == "Test Spotify"
    assert second.name == "Test Spotify"
    assert token_calls == 1


@pytest.mark.asyncio
async def test_youtube_resolver_paginates_and_returns_partial_on_quota_exceeded() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if "pageToken=page2" in str(request.url):
            return httpx.Response(
                403,
                json={
                    "error": {
                        "errors": [{"reason": "quotaExceeded"}],
                        "message": "The request cannot be completed because you have exceeded your quota.",
                    }
                },
            )
        return httpx.Response(
            200,
            json={
                "nextPageToken": "page2",
                "pageInfo": {"totalResults": 80},
                "items": [
                    {
                        "id": "pi-1",
                        "snippet": {
                            "title": "Nova - Starlight (Official Audio)",
                            "videoOwnerChannelTitle": "Nova",
                            "resourceId": {"videoId": "v1"},
                            "thumbnails": {},
                        },
                    }
                ],
            },
        )

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        resolver = YouTubeResolver(
            client=client,
            api_key="fake-yt-key",
            base_backoff_seconds=0.01,
        )
        result = await resolver.resolve("PL1234567890abcdef")

    assert result.source == "youtube"
    assert result.partial is True
    assert len(result.tracks) == 1
    assert result.tracks[0].artist == "Nova"
    assert result.tracks[0].name == "Starlight"
