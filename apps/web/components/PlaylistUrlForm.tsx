'use client';

import { ArrowRight, Link2, Loader2, X } from 'lucide-react';
import { type FormEvent, useId, useMemo, useState } from 'react';
import { formatPlatformName } from '../lib/format';
import { detectPlaylistUrl } from '../lib/validation';
import { PlatformIcon } from './PlatformIcon';

interface PlaylistUrlFormProps {
  initialUrl?: string;
  isLoading: boolean;
  onSubmitUrl: (url: string) => void;
}

export function PlaylistUrlForm({ initialUrl = '', isLoading, onSubmitUrl }: PlaylistUrlFormProps) {
  const [url, setUrl] = useState<string>(initialUrl);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const inputId = useId();
  const errorId = useId();
  const hintId = useId();

  const detection = useMemo(() => {
    if (!url.trim()) return null;
    return detectPlaylistUrl(url);
  }, [url]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = detectPlaylistUrl(url);
    if (!result.valid) {
      setInlineError(result.error);
      return;
    }
    setInlineError(null);
    onSubmitUrl(url.trim());
  }

  function handleChange(nextValue: string) {
    setUrl(nextValue);
    if (inlineError) {
      const check = detectPlaylistUrl(nextValue);
      if (check.valid || !nextValue.trim()) {
        setInlineError(null);
      }
    }
  }

  function handleClear() {
    setUrl('');
    setInlineError(null);
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="w-full max-w-3xl">
      <label htmlFor={inputId} className="block text-sm font-medium text-slate-200 mb-2">
        Public playlist URL (Deezer, Spotify, or YouTube)
      </label>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-stretch">
        <div className="relative flex-1">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-3.5 flex items-center text-slate-500"
          >
            {detection?.platform ? (
              <PlatformIcon source={detection.platform} className="h-4 w-4" />
            ) : (
              <Link2 className="h-4 w-4" />
            )}
          </span>

          <input
            id={inputId}
            name="playlistUrl"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={url}
            onChange={(e) => handleChange(e.target.value)}
            disabled={isLoading}
            placeholder="https://open.spotify.com/playlist/... or deezer.com / youtube.com"
            aria-invalid={inlineError !== null}
            aria-describedby={inlineError ? `${errorId} ${hintId}` : hintId}
            className={`h-12 w-full rounded-lg border bg-[#12161F] pl-10 pr-10 text-sm text-slate-100 placeholder:text-slate-500 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0A0D12] disabled:opacity-60 ${
              inlineError
                ? 'border-red-500/80 focus-visible:ring-red-400'
                : 'border-white/[0.12] hover:border-white/[0.22]'
            }`}
          />

          {url.length > 0 && !isLoading && (
            <button
              type="button"
              onClick={handleClear}
              aria-label="Clear URL"
              className="absolute inset-y-0 right-2 my-auto flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-white/[0.06] hover:text-slate-200 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <button
          type="submit"
          disabled={isLoading}
          className="inline-flex h-12 items-center justify-center gap-2 rounded-lg bg-emerald-500 px-6 text-sm font-semibold text-slate-950 hover:bg-emerald-400 active:bg-emerald-500 transition-colors whitespace-nowrap shrink-0 disabled:cursor-not-allowed disabled:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0A0D12]"
        >
          {isLoading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              <span>Loading…</span>
            </>
          ) : (
            <>
              <span>Load Playlist</span>
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </>
          )}
        </button>
      </div>

      {/* Live platform auto-detection hint */}
      <div
        id={hintId}
        aria-live="polite"
        className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
      >
        {detection?.platform ? (
          <span className="inline-flex items-center gap-1.5 font-medium text-slate-200">
            <PlatformIcon source={detection.platform} className="h-3.5 w-3.5" />
            <span>
              Detected: {formatPlatformName(detection.platform)} playlist
              {detection.valid ? '' : ' (finish pasting playlist link)'}
            </span>
          </span>
        ) : (
          <span className="text-slate-500">
            Supports public links from <span className="text-slate-300">Deezer</span>
            <span aria-hidden="true" className="mx-1.5 text-slate-600">
              ·
            </span>
            <span className="text-slate-300">Spotify</span>{' '}
            <span className="font-mono text-slate-500">(URL or spotify:playlist: URI)</span>
            <span aria-hidden="true" className="mx-1.5 text-slate-600">
              ·
            </span>
            <span className="text-slate-300">YouTube</span>
          </span>
        )}
      </div>

      {inlineError && (
        <p id={errorId} role="alert" className="mt-2 text-sm text-red-400">
          {inlineError}
        </p>
      )}
    </form>
  );
}
