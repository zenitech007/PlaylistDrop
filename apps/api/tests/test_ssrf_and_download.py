from __future__ import annotations

import httpx
import pytest

from app.errors import AppError
from app.main import create_app
from app.services.ssrf_guard import MatchedUrlRegistry, sanitize_filename


def test_sanitize_filename_strips_path_traversal_and_slugifies() -> None:
    assert sanitize_filename("../../etc/passwd") == "passwd.mp3"
    assert sanitize_filename("Daft Punk / One More Time!!.mp3") == "one-more-time.mp3"
    assert sanitize_filename("Café del Mar — Sunrise") == "cafe-del-mar-sunrise.mp3"
    assert sanitize_filename("///...") == "track.mp3"


def test_ssrf_guard_allows_registered_and_allowlisted_domains_only() -> None:
    registry = MatchedUrlRegistry(
        ttl_seconds=600,
        allowed_domains=("mp3d.jamendo.com",),
    )
    registry.register(
        track_id="t1",
        download_url="https://cdn.example-cc.org/audio/track1.mp3",
        artist="Artist",
        title="Track One",
        source="jamendo",
    )

    assert registry.validate_download_url("https://cdn.example-cc.org/audio/track1.mp3") is not None
    assert registry.validate_download_url("https://mp3d.jamendo.com/download/123/mp32/") is None

    for blocked in [
        "http://169.254.169.254/latest/meta-data/",
        "http://127.0.0.1:8000/health",
        "http://localhost/secret",
        "https://untrusted-site.evil/malware.mp3",
        "file:///etc/passwd",
    ]:
        with pytest.raises(AppError) as exc_info:
            registry.validate_download_url(blocked)
        assert exc_info.value.status_code == 400


@pytest.mark.asyncio
async def test_download_endpoint_rejects_unapproved_host_with_400(test_settings) -> None:
    transport = httpx.MockTransport(lambda req: httpx.Response(200, content=b"should-not-run"))
    async with httpx.AsyncClient(transport=transport) as mocked_http:
        app = create_app(settings=test_settings, http_client=mocked_http)
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                resp = await client.post(
                    "/api/download",
                    json={"downloadUrl": "https://169.254.169.254/latest/meta-data/"},
                )

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "SSRF_BLOCKED"


@pytest.mark.asyncio
async def test_download_endpoint_streams_valid_audio_and_enforces_content_type(
    test_settings,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if "bad-mime" in str(request.url):
            return httpx.Response(
                200,
                headers={"Content-Type": "text/html"},
                content=b"<html>not audio</html>",
            )
        return httpx.Response(
            200,
            headers={"Content-Type": "audio/mpeg", "Content-Length": "11"},
            content=b"ID3FAKEAUDIO",
        )

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as mocked_http:
        app = create_app(settings=test_settings, http_client=mocked_http)
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                good = await client.post(
                    "/api/download",
                    json={
                        "downloadUrl": "https://mp3d.jamendo.com/download/track/1/mp32/",
                        "filename": "../My Cool Track.mp3",
                    },
                )
                assert good.status_code == 200
                assert good.headers["content-type"].startswith("audio/mpeg")
                assert good.headers["content-disposition"] == 'attachment; filename="my-cool-track.mp3"'
                assert good.content == b"ID3FAKEAUDIO"

                bad = await client.post(
                    "/api/download",
                    json={"downloadUrl": "https://mp3d.jamendo.com/bad-mime"},
                )
                assert bad.status_code == 415
                assert bad.json()["error"]["code"] == "INVALID_AUDIO_CONTENT_TYPE"
