'use client';

import { AlertCircle, Clock, ExternalLink, RefreshCw } from 'lucide-react';
import { PlaylistDropApiError } from '../lib/api';
import { YOUTUBE_CLOUD_ENABLE_URL } from '../lib/firebase';

interface ErrorBannerProps {
  error: PlaylistDropApiError;
  onRetry: () => void;
  onReset: () => void;
}

function getErrorHeading(error: PlaylistDropApiError): string {
  if (error.code === 'UNSUPPORTED_PLAYLIST_URL' || error.status === 400) {
    return 'Unsupported or malformed playlist URL';
  }
  if (error.code === 'PLAYLIST_NOT_FOUND' || error.status === 404) {
    return 'Playlist not found or private';
  }
  if (error.code === 'PLAYLIST_TOO_LARGE') {
    return 'Playlist exceeds the 200-track limit';
  }
  if (error.code === 'YOUTUBE_API_DISABLED') {
    return 'YouTube Data API v3 not enabled in Google Cloud';
  }
  if (error.code === 'YOUTUBE_QUOTA_EXCEEDED') {
    return 'YouTube API quota exceeded';
  }
  if (
    error.code === 'RATE_LIMITED' ||
    error.code === 'UPSTREAM_RATE_LIMITED' ||
    error.status === 429 ||
    error.status === 503
  ) {
    return 'Rate limit reached';
  }
  if (error.code === 'NETWORK_ERROR' || error.status === 0) {
    return 'Network connection error';
  }
  if (
    error.code === 'SPOTIFY_CONFIG_ERROR' ||
    error.code === 'SPOTIFY_AUTH_ERROR' ||
    error.code === 'YOUTUBE_CONFIG_ERROR' ||
    error.status === 500
  ) {
    return 'Server API credentials not configured';
  }
  return 'Could not load playlist';
}

export function ErrorBanner({ error, onRetry, onReset }: ErrorBannerProps) {
  const isThrottleOrQuota =
    error.status === 429 ||
    error.status === 503 ||
    error.code === 'RATE_LIMITED' ||
    error.code === 'UPSTREAM_RATE_LIMITED' ||
    error.code === 'YOUTUBE_QUOTA_EXCEEDED';

  const heading = getErrorHeading(error);

  return (
    <section
      role="alert"
      aria-live="assertive"
      className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8"
    >
      <div className="rounded-lg border border-red-500/30 bg-[#161217] p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3.5">
            {isThrottleOrQuota ? (
              <Clock className="h-5 w-5 text-amber-400 mt-0.5 shrink-0" aria-hidden="true" />
            ) : (
              <AlertCircle className="h-5 w-5 text-red-400 mt-0.5 shrink-0" aria-hidden="true" />
            )}

            <div>
              <h2 className="font-display text-base font-semibold text-slate-100">{heading}</h2>
              <p className="mt-1 text-sm leading-relaxed text-slate-300">{error.message}</p>

              {error.retryAfterSeconds !== null && (
                <p className="mt-2 text-xs font-mono text-amber-300 tabular-nums">
                  Suggested wait: {error.retryAfterSeconds}s before retrying.
                </p>
              )}

              {error.code === 'PLAYLIST_NOT_FOUND' && (
                <p className="mt-2 text-xs text-slate-400">
                  Verify the playlist is set to public on Deezer, Spotify, or YouTube and that the
                  full link was copied accurately.
                </p>
              )}

              {error.code === 'YOUTUBE_API_DISABLED' && (
                <div className="mt-3">
                  <a
                    href={YOUTUBE_CLOUD_ENABLE_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-8 items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 text-xs font-medium text-emerald-300 hover:bg-emerald-500/20 transition-colors"
                  >
                    <span>Enable YouTube Data API v3 in Google Cloud Console</span>
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  </a>
                </div>
              )}

              {error.code === 'YOUTUBE_QUOTA_EXCEEDED' && (
                <p className="mt-2 text-xs text-slate-400">
                  YouTube Data API enforces a daily project quota. Deezer playlists work without API
                  keys, and Spotify playlists remain unaffected.
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-slate-100 px-4 text-sm font-medium text-slate-950 hover:bg-white transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              <span>Retry</span>
            </button>
            <button
              type="button"
              onClick={onReset}
              className="inline-flex h-10 items-center justify-center rounded-md border border-white/[0.12] px-4 text-sm font-medium text-slate-300 hover:bg-white/[0.06] hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            >
              Clear
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
