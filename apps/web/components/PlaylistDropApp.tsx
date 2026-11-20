'use client';

import { AlertCircle, Bookmark, Cloud, Trash2, X } from 'lucide-react';
import { motion } from 'motion/react';
import { useCallback, useMemo, useState } from 'react';
import { matchTracks, PlaylistDropApiError, resolvePlaylist } from '../lib/api';
import { toSafeFirestoreDocId } from '../lib/firebase';
import { formatPlatformName } from '../lib/format';
import type { EnrichedTrack, LoadingPhase, MatchResult, PlaylistData } from '../lib/types';
import { ErrorBanner } from './ErrorBanner';
import { useFirebase } from './FirebaseProvider';
import { FirebaseSettingsPanel } from './FirebaseSettingsPanel';
import { PlatformIcon } from './PlatformIcon';
import { PlaylistUrlForm } from './PlaylistUrlForm';
import { ResultsView } from './ResultsView';
import { TracklistSkeleton } from './TracklistSkeleton';

interface PlaylistDropAppProps {
  apiBaseUrl: string;
}

export function PlaylistDropApp({ apiBaseUrl }: PlaylistDropAppProps) {
  const {
    projectId,
    user,
    isAdmin,
    runtimeConfig,
    savedPlaylists,
    firestoreError,
    clearFirestoreError,
    savePlaylistBookmark,
    deletePlaylistBookmark,
  } = useFirebase();

  const [phase, setPhase] = useState<LoadingPhase>('idle');
  const [lastUrl, setLastUrl] = useState<string>('');
  const [playlist, setPlaylist] = useState<PlaylistData | null>(null);
  const [tracks, setTracks] = useState<EnrichedTrack[]>([]);
  const [trackCountHint, setTrackCountHint] = useState<number | undefined>(undefined);
  const [error, setError] = useState<PlaylistDropApiError | null>(null);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [savingBookmark, setSavingBookmark] = useState<boolean>(false);
  const [bookmarkFeedback, setBookmarkFeedback] = useState<string | null>(null);

  const effectiveApiBaseUrl = runtimeConfig.nextPublicApiUrl || apiBaseUrl;

  const currentDocId = useMemo(
    () => (playlist ? toSafeFirestoreDocId(`${playlist.source}_${playlist.id}`) : null),
    [playlist]
  );

  const isCurrentPlaylistSaved = useMemo(
    () => currentDocId !== null && savedPlaylists.some((saved) => saved.docId === currentDocId),
    [currentDocId, savedPlaylists]
  );

  const loadPlaylist = useCallback(
    async (url: string) => {
      setLastUrl(url);
      setError(null);
      setBookmarkFeedback(null);
      setPlaylist(null);
      setTracks([]);
      setTrackCountHint(undefined);
      setPhase('resolving');

      try {
        const resolved = await resolvePlaylist(url, effectiveApiBaseUrl);
        setPlaylist(resolved);
        setTrackCountHint(resolved.tracks.length);

        if (resolved.tracks.length === 0) {
          setTracks([]);
          setPhase('ready');
          return;
        }

        setPhase('matching');
        const matchResponse = await matchTracks(resolved.tracks, effectiveApiBaseUrl);
        const matchById = new Map<string, MatchResult>(
          matchResponse.matches.map((match) => [match.trackId, match])
        );

        const enriched: EnrichedTrack[] = resolved.tracks.map((track) => ({
          ...track,
          match: matchById.get(track.id) ?? null,
        }));

        setTracks(enriched);
        setPhase('ready');
      } catch (err) {
        const apiError =
          err instanceof PlaylistDropApiError
            ? err
            : new PlaylistDropApiError(
                0,
                'UNKNOWN_ERROR',
                'An unexpected error occurred while processing the playlist.'
              );
        setError(apiError);
        setPhase('error');
      }
    },
    [effectiveApiBaseUrl]
  );

  const handleReset = useCallback(() => {
    setPhase('idle');
    setPlaylist(null);
    setTracks([]);
    setError(null);
    setBookmarkFeedback(null);
    setTrackCountHint(undefined);
  }, []);

  const handleSavePlaylist = useCallback(async () => {
    if (!playlist || !lastUrl) return;
    if (!user) {
      setSettingsOpen(true);
      setBookmarkFeedback('Sign in with Google in Firebase Config to save playlists.');
      return;
    }
    setSavingBookmark(true);
    setBookmarkFeedback(null);
    try {
      const matchedCount = tracks.filter((t) => t.match !== null).length;
      await savePlaylistBookmark(playlist, lastUrl, matchedCount);
    } catch (err) {
      setBookmarkFeedback(
        err instanceof Error ? err.message : 'Could not save playlist to Firebase.'
      );
    } finally {
      setSavingBookmark(false);
    }
  }, [lastUrl, playlist, savePlaylistBookmark, tracks, user]);

  const isLoading = phase === 'resolving' || phase === 'matching';

  return (
    <div>
      {/* Hero section */}
      <section
        id="playlist-input"
        className={`mx-auto max-w-6xl px-4 sm:px-6 lg:px-8 transition-all ${
          phase === 'ready'
            ? 'pt-10 pb-8 border-b border-white/[0.08]'
            : 'pt-16 pb-12 sm:pt-24 sm:pb-16'
        }`}
      >
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
        >
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs font-medium text-emerald-400">
              Deezer · Spotify · YouTube · Creative Commons audio · No login required
            </p>

            <button
              type="button"
              onClick={() => setSettingsOpen((prev) => !prev)}
              aria-expanded={settingsOpen}
              className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs font-medium transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 ${
                settingsOpen
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                  : 'border-white/[0.1] bg-[#12161F] text-slate-300 hover:bg-white/[0.06] hover:text-slate-100'
              }`}
            >
              <Cloud className="h-3.5 w-3.5 text-emerald-400 shrink-0" aria-hidden="true" />
              <span>Firebase Config</span>
              {user && isAdmin && (
                <span className="text-[11px] font-mono text-slate-400">· Admin</span>
              )}
            </button>
          </div>

          <h1
            className={`font-display font-semibold tracking-tight text-slate-100 text-balance ${
              phase === 'ready'
                ? 'text-2xl sm:text-3xl max-w-2xl'
                : 'text-4xl sm:text-5xl lg:text-[3.25rem] leading-[1.08] max-w-3xl'
            }`}
          >
            Turn public playlists into free Creative Commons audio downloads
          </h1>

          {phase !== 'ready' && (
            <p className="mt-5 max-w-2xl text-base leading-relaxed text-slate-400 tracking-[0.01em]">
              Paste a public Deezer, Spotify, or YouTube playlist URL to resolve its tracklist and
              match available tracks against Jamendo&apos;s Creative Commons catalog. Download
              matched MP3s individually or as a streamed ZIP, and export any tracklist as CSV or
              JSON.
            </p>
          )}

          <div className={phase === 'ready' ? 'mt-5' : 'mt-9'}>
            <PlaylistUrlForm
              initialUrl={lastUrl}
              isLoading={isLoading}
              onSubmitUrl={(url) => {
                void loadPlaylist(url);
              }}
            />
          </div>

          <p className="mt-3 text-[11px] text-slate-500 font-mono">
            Cloud project: {projectId}
            {effectiveApiBaseUrl ? ` · API: ${effectiveApiBaseUrl}` : ' · API: same-origin /api'}
          </p>
        </motion.div>
      </section>

      {firestoreError && (
        <div role="alert" className="mx-auto max-w-6xl px-4 pb-4 sm:px-6 lg:px-8">
          <div className="flex items-start justify-between gap-3 rounded-lg border border-red-500/30 bg-[#161217] px-4 py-3 text-xs text-red-200">
            <div className="flex items-start gap-2.5 min-w-0">
              <AlertCircle className="h-4 w-4 text-red-400 mt-0.5 shrink-0" aria-hidden="true" />
              <span className="break-all">Firestore operation failed: {firestoreError}</span>
            </div>
            <button
              type="button"
              onClick={clearFirestoreError}
              aria-label="Dismiss Firestore error"
              className="flex h-6 w-6 items-center justify-center rounded text-red-300 hover:bg-red-500/15 shrink-0"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>
      )}

      {bookmarkFeedback && (
        <div role="status" className="mx-auto max-w-6xl px-4 pb-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-[#1A160E] px-4 py-2.5 text-xs text-amber-200">
            <span>{bookmarkFeedback}</span>
            <button
              type="button"
              onClick={() => setBookmarkFeedback(null)}
              aria-label="Dismiss message"
              className="flex h-6 w-6 items-center justify-center rounded text-amber-300 hover:bg-amber-500/15 shrink-0"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>
      )}

      <FirebaseSettingsPanel isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {user && savedPlaylists.length > 0 && phase !== 'ready' && (
        <section
          aria-label="Saved playlists"
          className="mx-auto max-w-6xl px-4 pb-10 sm:px-6 lg:px-8"
        >
          <div className="rounded-lg border border-white/[0.08] bg-[#12161F] p-5">
            <div className="flex items-center justify-between gap-2 mb-3">
              <div className="flex items-center gap-2">
                <Bookmark className="h-4 w-4 text-emerald-400" aria-hidden="true" />
                <h2 className="font-display text-sm font-semibold text-slate-100">
                  Saved Playlists
                </h2>
              </div>
              <span className="text-[11px] font-mono text-slate-500 tabular-nums">
                {savedPlaylists.length} stored in Firestore
              </span>
            </div>

            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
              {savedPlaylists.map((item) => (
                <div
                  key={item.docId}
                  className="flex items-center justify-between gap-2 rounded-md border border-white/[0.08] bg-[#0A0D12] px-3 py-2.5"
                >
                  <button
                    type="button"
                    disabled={isLoading}
                    onClick={() => {
                      void loadPlaylist(item.url);
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left hover:text-emerald-300 transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 rounded"
                  >
                    <PlatformIcon source={item.source} className="h-4 w-4 shrink-0" />
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium text-slate-100">{item.name}</p>
                      <p className="text-[11px] text-slate-400 font-mono tabular-nums">
                        {formatPlatformName(item.source)} · {item.matchedCount}/{item.trackCount}{' '}
                        matched
                      </p>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void deletePlaylistBookmark(item.docId);
                    }}
                    aria-label={`Remove ${item.name} from saved playlists`}
                    className="flex h-7 w-7 items-center justify-center rounded text-slate-500 hover:bg-white/[0.06] hover:text-red-400 transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {isLoading && <TracklistSkeleton phase={phase} trackCountHint={trackCountHint} />}

      {phase === 'error' && error && (
        <ErrorBanner
          error={error}
          onRetry={() => {
            if (lastUrl) {
              void loadPlaylist(lastUrl);
            }
          }}
          onReset={handleReset}
        />
      )}

      {phase === 'ready' && playlist && (
        <ResultsView
          playlist={playlist}
          tracks={tracks}
          apiBaseUrl={effectiveApiBaseUrl}
          onLoadAnother={handleReset}
          onSavePlaylist={() => {
            void handleSavePlaylist();
          }}
          isSaved={isCurrentPlaylistSaved}
          isSavingPlaylist={savingBookmark}
        />
      )}
    </div>
  );
}
