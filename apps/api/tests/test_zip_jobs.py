from __future__ import annotations

import asyncio
import io
import zipfile

import httpx
import pytest

from app.main import create_app
from app.providers.registry import ProviderRegistry
from app.schemas import MatchResult, Track


class FakeProvider:
    name = "jamendo"

    async def match(self, tracks: list[Track]) -> list[MatchResult]:
        return [
            MatchResult(
                trackId=track.id,
                source="jamendo",
                downloadUrl=f"https://mp3d.jamendo.com/download/track/{track.id}/mp32/",
                license="CC BY 3.0",
                bitrateKbps=192,
                score=1.0,
            )
            for track in tracks
        ]


@pytest.mark.asyncio
async def test_zip_job_end_to_end_flow(test_settings) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        track_key = str(request.url).split("/")[-3]
        audio_bytes = f"ID3-AUDIO-DATA-FOR-{track_key}".encode("utf-8")
        return httpx.Response(
            200,
            headers={
                "Content-Type": "audio/mpeg",
                "Content-Length": str(len(audio_bytes)),
            },
            content=audio_bytes,
        )

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as mocked_http:
        app = create_app(
            settings=test_settings,
            http_client=mocked_http,
            providers=ProviderRegistry([FakeProvider()]),
        )
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client:
                # 1. Populate matched URL registry via /api/match
                match_resp = await client.post(
                    "/api/match",
                    json={
                        "tracks": [
                            {
                                "id": "t1",
                                "name": "Solar Wind",
                                "artist": "Aurora",
                                "album": "Sky",
                                "durationMs": 180000,
                            },
                            {
                                "id": "t2",
                                "name": "Deep Drift",
                                "artist": "Aurora",
                                "album": "Sky",
                                "durationMs": 210000,
                            },
                        ]
                    },
                )
                assert match_resp.status_code == 200
                assert len(match_resp.json()["matches"]) == 2

                # 2. Kick off ZIP job -> 202 with jobId
                zip_resp = await client.post(
                    "/api/download/zip",
                    json={"trackIds": ["t1", "t2"]},
                )
                assert zip_resp.status_code == 202
                job_id = zip_resp.json()["jobId"]

                # 3. Poll /status until done
                status_payload = {}
                for _ in range(30):
                    status_resp = await client.get(f"/api/download/zip/{job_id}/status")
                    assert status_resp.status_code == 200
                    status_payload = status_resp.json()
                    if status_payload["status"] in {"done", "failed"}:
                        break
                    await asyncio.sleep(0.05)

                assert status_payload["status"] == "done"
                assert status_payload["completed"] == 2
                assert status_payload["total"] == 2
                assert status_payload["downloadUrl"] == f"/api/download/zip/{job_id}/file"

                # 4. Stream and inspect resulting ZIP archive
                file_resp = await client.get(status_payload["downloadUrl"])
                assert file_resp.status_code == 200
                assert file_resp.headers["content-type"] == "application/zip"

                with zipfile.ZipFile(io.BytesIO(file_resp.content), "r") as zf:
                    names = sorted(zf.namelist())
                    assert names == ["aurora-deep-drift.mp3", "aurora-solar-wind.mp3"]
                    assert zf.read("aurora-solar-wind.mp3") == b"ID3-AUDIO-DATA-FOR-t1"
                    assert zf.read("aurora-deep-drift.mp3") == b"ID3-AUDIO-DATA-FOR-t2"
