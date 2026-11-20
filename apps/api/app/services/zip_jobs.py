from __future__ import annotations

import asyncio
import os
import tempfile
import time
import uuid
import zipfile
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from pathlib import Path

import httpx

from app.errors import AppError
from app.logging_config import get_logger
from app.schemas import ZipJobStatusResponse, ZipStatus
from app.services.downloader import CHUNK_SIZE, open_validated_audio_stream
from app.services.ssrf_guard import MatchedUrlRegistry, RegisteredMatch

logger = get_logger(__name__)


@dataclass
class ZipJob:
    job_id: str
    status: ZipStatus
    completed: int
    total: int
    created_at: float = field(default_factory=time.monotonic)
    temp_path: Path | None = None
    error: str | None = None
    task: asyncio.Task[None] | None = None


class ZipJobManager:
    """
    In-memory async ZIP job manager (dict + asyncio.Task).
    Streams each audio track in 64KB chunks directly into a disk-backed ZIP entry
    so whole files are never buffered in RAM.
    Upgrade path: replace in-memory dict + temp files with Redis + object storage workers.
    """

    def __init__(
        self,
        client: httpx.AsyncClient,
        registry: MatchedUrlRegistry,
        max_download_bytes: int = 50 * 1024 * 1024,
        ttl_seconds: int = 900,
    ) -> None:
        self._client = client
        self._registry = registry
        self._max_download_bytes = max_download_bytes
        self._ttl_seconds = ttl_seconds
        self._jobs: dict[str, ZipJob] = {}

    def _cleanup_expired(self) -> None:
        now = time.monotonic()
        expired_ids = [
            job_id
            for job_id, job in self._jobs.items()
            if (now - job.created_at) > self._ttl_seconds
            and job.status in {"done", "failed"}
        ]
        for job_id in expired_ids:
            job = self._jobs.pop(job_id, None)
            if job and job.temp_path and job.temp_path.exists():
                try:
                    job.temp_path.unlink()
                except OSError:
                    pass

    def start_job(self, track_ids: list[str]) -> ZipJob:
        self._cleanup_expired()

        # Deduplicate preserving order
        unique_ids = list(dict.fromkeys(track_ids))
        matches: list[RegisteredMatch] = []
        missing_ids: list[str] = []
        for track_id in unique_ids:
            entry = self._registry.get_by_track_id(track_id)
            if entry is None:
                missing_ids.append(track_id)
            else:
                matches.append(entry)

        if not matches:
            raise AppError(
                status_code=400,
                code="NO_MATCHED_TRACKS_FOUND",
                message=(
                    "None of the requested tracks are currently in the matched download registry. "
                    "Please re-load the playlist and try again."
                ),
            )

        job_id = uuid.uuid4().hex
        job = ZipJob(
            job_id=job_id,
            status="pending",
            completed=0,
            total=len(matches),
        )
        self._jobs[job_id] = job
        job.task = asyncio.create_task(self._run_zip_job(job, matches))
        logger.info(
            "zip_job_started",
            job_id=job_id,
            total=len(matches),
            skipped_unregistered=len(missing_ids),
        )
        return job

    async def _run_zip_job(self, job: ZipJob, matches: list[RegisteredMatch]) -> None:
        job.status = "running"
        fd, raw_path = tempfile.mkstemp(prefix=f"playlistdrop-{job.job_id}-", suffix=".zip")
        os.close(fd)
        temp_path = Path(raw_path)
        job.temp_path = temp_path

        used_names: dict[str, int] = {}
        packaged_count = 0

        try:
            # ZIP_STORED avoids wasting CPU trying to re-compress already-compressed MP3 audio
            with zipfile.ZipFile(temp_path, mode="w", compression=zipfile.ZIP_STORED) as zf:
                for entry in matches:
                    arcname = _deduplicate_filename(entry.filename, used_names)
                    try:
                        audio_stream = await open_validated_audio_stream(
                            client=self._client,
                            registry=self._registry,
                            download_url=entry.download_url,
                            requested_filename=arcname,
                            max_bytes=self._max_download_bytes,
                        )
                        with zf.open(arcname, mode="w") as zip_entry:
                            async for chunk in audio_stream.chunks:
                                await asyncio.to_thread(zip_entry.write, chunk)
                        packaged_count += 1
                    except Exception as track_exc:
                        logger.warning(
                            "zip_job_track_skipped",
                            job_id=job.job_id,
                            track_id=entry.track_id,
                            error=str(track_exc),
                        )
                    finally:
                        job.completed += 1

            if packaged_count == 0:
                job.status = "failed"
                job.error = "Unable to download any of the selected audio tracks."
                if temp_path.exists():
                    temp_path.unlink(missing_ok=True)
                return

            job.status = "done"
            logger.info(
                "zip_job_completed",
                job_id=job.job_id,
                packaged=packaged_count,
                total=job.total,
            )
        except Exception as exc:
            logger.error("zip_job_failed", job_id=job.job_id, exc_info=exc)
            job.status = "failed"
            job.error = "ZIP archive creation failed. Please try again."
            if temp_path.exists():
                temp_path.unlink(missing_ok=True)

    def get_status(self, job_id: str) -> ZipJobStatusResponse:
        self._cleanup_expired()
        job = self._jobs.get(job_id)
        if job is None:
            raise AppError(
                status_code=404,
                code="ZIP_JOB_NOT_FOUND",
                message="ZIP job not found or has expired.",
            )

        download_url = (
            f"/api/download/zip/{job.job_id}/file" if job.status == "done" else None
        )
        return ZipJobStatusResponse(
            status=job.status,
            completed=job.completed,
            total=job.total,
            downloadUrl=download_url,
            error=job.error,
        )

    def stream_finished_zip(self, job_id: str) -> tuple[Path, AsyncIterator[bytes]]:
        job = self._jobs.get(job_id)
        if job is None:
            raise AppError(
                status_code=404,
                code="ZIP_JOB_NOT_FOUND",
                message="ZIP job not found or has expired.",
            )
        if job.status != "done" or not job.temp_path or not job.temp_path.exists():
            raise AppError(
                status_code=409,
                code="ZIP_JOB_NOT_READY",
                message="ZIP archive is not ready for download yet.",
            )

        path = job.temp_path

        async def _file_chunks() -> AsyncIterator[bytes]:
            with path.open("rb") as fh:
                while True:
                    chunk = await asyncio.to_thread(fh.read, CHUNK_SIZE)
                    if not chunk:
                        break
                    yield chunk

        return path, _file_chunks()

    async def shutdown(self) -> None:
        for job in list(self._jobs.values()):
            if job.task and not job.task.done():
                job.task.cancel()
            if job.temp_path and job.temp_path.exists():
                job.temp_path.unlink(missing_ok=True)
        self._jobs.clear()


def _deduplicate_filename(filename: str, used: dict[str, int]) -> str:
    if filename not in used:
        used[filename] = 1
        return filename
    count = used[filename]
    used[filename] = count + 1
    stem, dot, ext = filename.rpartition(".")
    if not dot:
        return f"{filename}-{count}"
    return f"{stem}-{count}.{ext}"
