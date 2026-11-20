from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

PlaylistSource = Literal["deezer", "spotify", "youtube"]


class ErrorDetail(BaseModel):
    code: str
    message: str


class ErrorEnvelope(BaseModel):
    error: ErrorDetail


class ResolveRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    url: str = Field(..., min_length=1, max_length=2048)


class Track(BaseModel):
    id: str = Field(..., min_length=1, max_length=200)
    name: str = Field(..., min_length=1, max_length=300)
    artist: str = Field(..., min_length=1, max_length=300)
    album: str = Field(default="", max_length=300)
    durationMs: int = Field(..., ge=0)
    artworkUrl: str | None = None


class PlaylistData(BaseModel):
    id: str
    name: str
    owner: str | None = None
    artworkUrl: str | None = None
    tracks: list[Track]
    source: PlaylistSource
    partial: bool = False


class MatchRequest(BaseModel):
    tracks: list[Track] = Field(..., min_length=1, max_length=200)


class MatchResult(BaseModel):
    trackId: str
    source: str
    downloadUrl: str
    license: str
    bitrateKbps: int = Field(..., ge=0)
    score: float = Field(..., ge=0.0, le=1.0)


class MatchResponse(BaseModel):
    matches: list[MatchResult]


class DownloadRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    downloadUrl: str = Field(..., min_length=10, max_length=2048)
    filename: str | None = Field(default=None, max_length=200)


class ZipRequest(BaseModel):
    trackIds: list[str] = Field(..., min_length=1, max_length=200)


class ZipJobCreatedResponse(BaseModel):
    jobId: str


ZipStatus = Literal["pending", "running", "done", "failed"]


class ZipJobStatusResponse(BaseModel):
    status: ZipStatus
    completed: int = Field(..., ge=0)
    total: int = Field(..., ge=0)
    downloadUrl: str | None = None
    error: str | None = None
