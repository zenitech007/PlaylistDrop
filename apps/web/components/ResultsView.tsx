'use client';

import {
  AlertTriangle,
  Bookmark,
  BookmarkCheck,
  Disc3,
  FileJson,
  FileSpreadsheet,
  Info,
  Loader2,
  RotateCcw,
  Search,
  X,
} from 'lucide-react';
import Image from 'next/image';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  downloadSingleTrack,
  getZipJobStatus,
  PlaylistDropApiError,
  resolveAbsoluteDownloadUrl,
  startZipJob,
  triggerFileUrlDownload,
} from '../lib/api';
import { exportTracklistAsCsv, exportTracklistAsJson } from '../lib/export';
import { formatPlatformName, slugifyFilename } from '../lib/format';
import type { EnrichedTrack, PlaylistData, TrackFilter } from '../lib/types';
import { PlatformIcon } from './PlatformIcon';
import { StickyActionBar, type ZipProgressState } from './StickyActionBar';
import { type SingleTrackDownloadState, TrackRow } from './TrackRow';

interface ResultsViewProps {
  playlist: PlaylistData;
  tracks: EnrichedTrack[];
  apiBaseUrl: string;
  pollIntervalMs?: number;
  onLoadAnother: () => void;
  onSavePlaylist?: () => void;
  isSaved?: boolean;
  isSavingPlaylist?: boolean;
}

const INITIAL_ZIP_STATE: ZipProgressState = {
  phase: 'idle',
  jobId: null,
  completed: 0,
  total: 0,
  downloadUrl: null,
  error: null,
};

export function ResultsView({
  playlist,
  tracks,
  apiBaseUrl,
  pollIntervalMs = 1000,
  onLoadAnother,
  onSavePlaylist,
  isSaved = false,
  isSavingPlaylist = false,
}: ResultsViewProps) {
  const [playlistArtError, setPlaylistArtError] = useState<boolean>(false);
  const [partialDismissed, setPartialDismissed] = useState<boolean>(false);
  const [filter, setFilter] = useState<TrackFilter>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');

  const matchedTracks = useMemo(() => tracks.filter((track) => track.match !== null), [tracks]);
  const matchedIds = useMemo(() => matchedTracks.map((track) => track.id), [matchedTracks]);

  // Default: all matched tracks checked, unmatched disabled
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set(matchedIds));
  const [trackDownloads, setTrackDownloads] = useState<Record<string, SingleTrackDownloadState>>(
    {}
  );
  const [zipState, setZipState] = useState<ZipProgressState>(INITIAL_ZIP_STATE);

  const selectAllRef = useRef<HTMLInputElement | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isMountedRef = useRef<boolean>(true);

  const matchedCount = matchedTracks.length;
  const unmatchedCount = tracks.length - matchedCount;
  const selectedCount = selectedIds.size;
  const allMatchedSelected = matchedCount > 0 && selectedCount === matchedCount;
  const someMatchedSelected = selectedCount > 0 && selectedCount < matchedCount;

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (pollTimerRef.current !== null) {
        clearInterval(pollTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someMatchedSelected;
    }
  }, [someMatchedSelected]);

  const filteredTracks = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return tracks.filter((track) => {
      if (filter === 'matched' && track.match === null) return false;
      if (filter === 'unmatched' && track.match !== null) return false;
      if (!q) return true;
      return (
        track.name.toLowerCase().includes(q) ||
        track.artist.toLowerCase().includes(q) ||
        track.album.toLowerCase().includes(q)
      );
    });
  }, [tracks, filter, searchQuery]);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const handleToggleTrack = useCallback((trackId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(trackId)) {
        next.delete(trackId);
      } else {
        next.add(trackId);
      }
      return next;
    });
  }, []);

  const handleToggleAllMatched = useCallback(() => {
    setSelectedIds((prev) => {
      if (prev.size === matchedIds.length) {
        return new Set();
      }
      return new Set(matchedIds);
    });
  }, [matchedIds]);

  const handleDownloadSingleTrack = useCallback(
    async (track: EnrichedTrack) => {
      if (!track.match) return;
      setTrackDownloads((prev) => ({
        ...prev,
        [track.id]: { status: 'downloading' },
      }));

      try {
        await downloadSingleTrack(track.match.downloadUrl, track.artist, track.name, apiBaseUrl);
        if (!isMountedRef.current) return;
        setTrackDownloads((prev) => ({
          ...prev,
          [track.id]: { status: 'done' },
        }));
      } catch (err) {
        if (!isMountedRef.current) return;
        const message =
          err instanceof PlaylistDropApiError ? err.message : 'Download failed. Please retry.';
        setTrackDownloads((prev) => ({
          ...prev,
          [track.id]: { status: 'error', errorMessage: message },
        }));
      }
    },
    [apiBaseUrl]
  );

  const triggerZipFile = useCallback(
    (relativeOrAbsoluteUrl: string) => {
      const absolute = resolveAbsoluteDownloadUrl(relativeOrAbsoluteUrl, apiBaseUrl);
      const filename = slugifyFilename(playlist.name, 'zip');
      triggerFileUrlDownload(absolute, filename);
    },
    [apiBaseUrl, playlist.name]
  );

  const pollJobStatus = useCallback(
    async (jobId: string) => {
      try {
        const status = await getZipJobStatus(jobId, apiBaseUrl);
        if (!isMountedRef.current) return;

        setZipState({
          phase: status.status,
          jobId,
          completed: status.completed,
          total: status.total,
          downloadUrl: status.downloadUrl,
          error: status.error,
        });

        if (status.status === 'done') {
          stopPolling();
          if (status.downloadUrl) {
            triggerZipFile(status.downloadUrl);
          }
        } else if (status.status === 'failed') {
          stopPolling();
        }
      } catch (err) {
        if (!isMountedRef.current) return;
        stopPolling();
        const message =
          err instanceof PlaylistDropApiError
            ? err.message
            : 'Lost connection while checking ZIP progress.';
        setZipState((prev) => ({
          ...prev,
          phase: 'failed',
          error: message,
        }));
      }
    },
    [apiBaseUrl, stopPolling, triggerZipFile]
  );

  const handleStartZip = useCallback(async () => {
    const idsToZip = matchedIds.filter((id) => selectedIds.has(id));
    if (idsToZip.length === 0) return;

    stopPolling();
    setZipState({
      phase: 'starting',
      jobId: null,
      completed: 0,
      total: idsToZip.length,
      downloadUrl: null,
      error: null,
    });

    try {
      const created = await startZipJob(idsToZip, apiBaseUrl);
      if (!isMountedRef.current) return;

      setZipState({
        phase: 'pending',
        jobId: created.jobId,
        completed: 0,
        total: idsToZip.length,
        downloadUrl: null,
        error: null,
      });

      void pollJobStatus(created.jobId);
      pollTimerRef.current = setInterval(() => {
        void pollJobStatus(created.jobId);
      }, pollIntervalMs);
    } catch (err) {
      if (!isMountedRef.current) return;
      const message =
        err instanceof PlaylistDropApiError ? err.message : 'Could not start ZIP archive job.';
      setZipState({
        phase: 'failed',
        jobId: null,
        completed: 0,
        total: idsToZip.length,
        downloadUrl: null,
        error: message,
      });
    }
  }, [apiBaseUrl, matchedIds, pollIntervalMs, pollJobStatus, selectedIds, stopPolling]);

  return (
    <section aria-label="Playlist results" className="flex flex-col">
      <div className="mx-auto w-full max-w-6xl px-4 pt-8 pb-12 sm:px-6 lg:px-8">
        {/* Playlist header summary */}
        <div className="flex flex-col gap-5 border-b border-white/[0.08] pb-6 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-4 min-w-0">
            <div className="relative h-16 w-16 rounded-lg overflow-hidden border border-white/[0.1] bg-gradient-to-br from-slate-800 to-slate-900 flex items-center justify-center shrink-0">
              {playlist.artworkUrl && !playlistArtError ? (
                <Image
                  src={playlist.artworkUrl}
                  alt={`${playlist.name} cover artwork`}
                  width={64}
                  height={64}
                  referrerPolicy="no-referrer"
                  onError={() => setPlaylistArtError(true)}
                  className="h-16 w-16 object-cover"
                />
              ) : (
                <Disc3 className="h-7 w-7 text-slate-500" aria-hidden="true" />
              )}
            </div>

            <div className="min-w-0">
              <h2 className="font-display text-2xl font-semibold tracking-tight text-slate-100 truncate">
                {playlist.name}
              </h2>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-400">
                <span className="inline-flex items-center gap-1.5 text-slate-200 font-medium">
                  <PlatformIcon source={playlist.source} className="h-3.5 w-3.5" />
                  <span>{formatPlatformName(playlist.source)}</span>
                </span>
                {playlist.owner && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="text-slate-300">{playlist.owner}</span>
                  </>
                )}
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums">{tracks.length} tracks</span>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums text-emerald-400">
                  {matchedCount} matched
                </span>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums">{unmatchedCount} unavailable</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 self-start sm:self-auto shrink-0">
            {onSavePlaylist && (
              <button
                type="button"
                disabled={isSavingPlaylist}
                onClick={onSavePlaylist}
                className={`inline-flex h-9 items-center justify-center gap-1.5 rounded-md border px-3.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 ${
                  isSaved
                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/15'
                    : 'border-white/[0.12] text-slate-300 hover:bg-white/[0.06] hover:text-slate-100'
                }`}
              >
                {isSavingPlaylist ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : isSaved ? (
                  <BookmarkCheck className="h-3.5 w-3.5" aria-hidden="true" />
                ) : (
                  <Bookmark className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                <span>{isSaved ? 'Saved' : 'Save'}</span>
              </button>
            )}
            <button
              type="button"
              onClick={onLoadAnother}
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-white/[0.12] px-3.5 text-xs font-medium text-slate-300 hover:bg-white/[0.06] hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Load another</span>
            </button>
          </div>
        </div>

        {/* Dismissible partial-results API quota warning banner */}
        {playlist.partial && !partialDismissed && (
          <div
            role="status"
            aria-live="polite"
            className="mt-6 rounded-lg border border-amber-500/30 bg-[#1A160E] px-4 py-3.5 flex items-start justify-between gap-4"
          >
            <div className="flex items-start gap-3">
              <AlertTriangle
                className="h-4 w-4 text-amber-400 mt-0.5 shrink-0"
                aria-hidden="true"
              />
              <div className="text-xs leading-relaxed text-amber-100">
                <span className="font-semibold">Some tracks were skipped due to API quota.</span>{' '}
                <span className="text-amber-200/80">
                  Showing the {tracks.length} tracks retrieved before the upstream quota limit was
                  reached.
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setPartialDismissed(true)}
              aria-label="Dismiss quota warning"
              className="flex h-7 w-7 items-center justify-center rounded-md text-amber-300 hover:bg-amber-500/15 hover:text-amber-100 transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        )}

        {/* All-unmatched guidance banner */}
        {matchedCount === 0 && (
          <div
            role="status"
            className="mt-6 rounded-lg border border-amber-500/25 bg-[#171510] p-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex items-start gap-3">
              <Info className="h-5 w-5 text-amber-400 mt-0.5 shrink-0" aria-hidden="true" />
              <div>
                <h3 className="text-sm font-semibold text-slate-100">
                  No Creative Commons downloads found for this playlist
                </h3>
                <p className="mt-1 text-xs leading-relaxed text-slate-300 max-w-2xl">
                  None of these {tracks.length} tracks matched a free Creative Commons release on
                  Jamendo. You can still export the full resolved tracklist as CSV or JSON for
                  archiving or manual lookup.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => exportTracklistAsCsv(playlist, tracks)}
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md bg-slate-100 px-3.5 text-xs font-semibold text-slate-950 hover:bg-white transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
              >
                <FileSpreadsheet className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Export CSV</span>
              </button>
              <button
                type="button"
                onClick={() => exportTracklistAsJson(playlist, tracks)}
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-white/[0.15] px-3.5 text-xs font-medium text-slate-200 hover:bg-white/[0.06] transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
              >
                <FileJson className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Export JSON</span>
              </button>
            </div>
          </div>
        )}

        {/* Controls toolbar: segmented filters, search, CSV/JSON export */}
        <div className="mt-6 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-3">
            <div
              role="group"
              aria-label="Filter tracks by availability"
              className="inline-flex items-center rounded-lg border border-white/[0.08] bg-[#12161F] p-1"
            >
              {(
                [
                  { id: 'all', label: `All (${tracks.length})` },
                  { id: 'matched', label: `Matched (${matchedCount})` },
                  { id: 'unmatched', label: `Unavailable (${unmatchedCount})` },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setFilter(tab.id)}
                  aria-pressed={filter === tab.id}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 ${
                    filter === tab.id
                      ? 'bg-white/[0.12] text-slate-100'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="relative flex-1 sm:w-64 sm:flex-none">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-500"
              />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                aria-label="Filter tracks by title, artist, or album"
                placeholder="Filter tracks…"
                className="h-9 w-full rounded-lg border border-white/[0.08] bg-[#12161F] pl-8 pr-3 text-xs text-slate-100 placeholder:text-slate-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
              />
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => exportTracklistAsCsv(playlist, tracks)}
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-white/[0.1] bg-[#12161F] px-3.5 text-xs font-medium text-slate-200 hover:bg-white/[0.07] transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            >
              <FileSpreadsheet className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
              <span>Export CSV</span>
            </button>
            <button
              type="button"
              onClick={() => exportTracklistAsJson(playlist, tracks)}
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-md border border-white/[0.1] bg-[#12161F] px-3.5 text-xs font-medium text-slate-200 hover:bg-white/[0.07] transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            >
              <FileJson className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
              <span>Export JSON</span>
            </button>
          </div>
        </div>

        {/* Tracklist table */}
        <div className="mt-4 overflow-x-auto rounded-lg border border-white/[0.08] bg-[#12161F]">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-white/[0.08] text-xs font-medium text-slate-400">
                <th scope="col" className="w-11 py-3 pl-4 pr-2">
                  <div className="flex items-center justify-center">
                    <input
                      ref={selectAllRef}
                      type="checkbox"
                      checked={allMatchedSelected}
                      disabled={matchedCount === 0}
                      onChange={handleToggleAllMatched}
                      aria-label="Select all matched tracks"
                      className="h-4 w-4 rounded border-white/25 bg-[#0A0D12] text-emerald-500 accent-emerald-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#12161F] disabled:cursor-not-allowed disabled:opacity-35 cursor-pointer"
                    />
                  </div>
                </th>
                <th scope="col" className="py-3 px-3">
                  Track
                </th>
                <th scope="col" className="py-3 px-3 text-right">
                  Duration
                </th>
                <th scope="col" className="hidden md:table-cell py-3 px-3">
                  Source
                </th>
                <th scope="col" className="hidden sm:table-cell py-3 px-3">
                  Catalog Match
                </th>
                <th scope="col" className="py-3 pl-3 pr-4 text-right">
                  File
                </th>
              </tr>
            </thead>
            <tbody>
              {filteredTracks.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-sm text-slate-400">
                    No tracks match your current filter.
                  </td>
                </tr>
              ) : (
                filteredTracks.map((track) => (
                  <TrackRow
                    key={track.id}
                    track={track}
                    playlistSource={playlist.source}
                    checked={selectedIds.has(track.id)}
                    downloadState={trackDownloads[track.id] ?? { status: 'idle' }}
                    onToggleSelect={handleToggleTrack}
                    onDownloadTrack={handleDownloadSingleTrack}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {matchedCount > 0 && (
        <StickyActionBar
          selectedCount={selectedCount}
          matchedCount={matchedCount}
          zipState={zipState}
          onStartZip={() => {
            void handleStartZip();
          }}
          onTriggerZipDownload={() => {
            if (zipState.downloadUrl) {
              triggerZipFile(zipState.downloadUrl);
            }
          }}
        />
      )}
    </section>
  );
}
