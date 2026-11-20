from __future__ import annotations

from functools import lru_cache
import json
from pathlib import Path

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


def _load_firebase_applet_config(config_path: str | None = None) -> dict[str, str]:
    """Load non-secret Firebase/Google Cloud project config if present in the monorepo."""
    candidates: list[Path] = []
    if config_path:
        candidates.append(Path(config_path))
    repo_root = Path(__file__).resolve().parents[3]
    candidates.append(repo_root / "firebase-applet-config.json")
    candidates.append(Path.cwd() / "firebase-applet-config.json")

    for path in candidates:
        if path.is_file():
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(raw, dict):
                    return {str(k): str(v) for k, v in raw.items() if isinstance(v, str)}
            except (OSError, json.JSONDecodeError):
                return {}
    return {}


class Settings(BaseSettings):
    """Application settings loaded from environment variables with optional Firebase config fallback."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    spotify_client_id: str = Field(default="", repr=False)
    spotify_client_secret: str = Field(default="", repr=False)
    youtube_api_key: str = Field(default="", repr=False)
    jamendo_client_id: str = Field(default="", repr=False)

    firebase_config_path: str = Field(default="")
    firebase_project_id: str = Field(default="")
    firebase_database_id: str = Field(default="")
    use_firebase_youtube_key: bool = Field(default=True)

    cors_origins: str = Field(default="http://localhost:3000")
    rate_limit_per_minute: int = Field(default=30, ge=1, le=600)
    max_playlist_tracks: int = Field(default=200, ge=1, le=500)
    max_download_mb: int = Field(default=50, ge=1, le=200)
    match_registry_ttl_seconds: int = Field(default=600, ge=60, le=3600)
    provider_timeout_seconds: float = Field(default=10.0, ge=1.0, le=60.0)
    max_match_concurrency: int = Field(default=5, ge=1, le=20)
    zip_job_ttl_seconds: int = Field(default=900, ge=60, le=3600)
    log_level: str = Field(default="INFO")

    allowed_download_domains: tuple[str, ...] = (
        "mp3d.jamendo.com",
        "mp3l.jamendo.com",
        "prod-1.storage.jamendo.com",
        "storage.jamendo.com",
        "cdn.jamendo.com",
        "audio.jamendo.com",
        "files.freemusicarchive.org",
    )

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def max_download_bytes(self) -> int:
        return self.max_download_mb * 1024 * 1024

    @field_validator("log_level")
    @classmethod
    def normalize_log_level(cls, value: str) -> str:
        return value.upper().strip() or "INFO"

    @model_validator(mode="after")
    def apply_firebase_fallback(self) -> Settings:
        fb = _load_firebase_applet_config(self.firebase_config_path or None)
        if not self.firebase_project_id and fb.get("projectId"):
            self.firebase_project_id = fb["projectId"]
        if not self.firebase_database_id and fb.get("firestoreDatabaseId"):
            self.firebase_database_id = fb["firestoreDatabaseId"]
        if not self.youtube_api_key.strip() and self.use_firebase_youtube_key and fb.get("apiKey"):
            self.youtube_api_key = fb["apiKey"].strip()
        return self


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
