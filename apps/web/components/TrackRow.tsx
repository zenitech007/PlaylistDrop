'use client';

import { AlertCircle, CheckCircle2, Disc3, Download, Loader2, MinusCircle } from 'lucide-react';
import Image from 'next/image';
import { useState } from 'react';
import { formatDurationMs, formatPlatformName, formatSourceName } from '../lib/format';
import type { EnrichedTrack, PlaylistSource } from '../lib/types';
import { PlatformIcon } from './PlatformIcon';

export interface SingleTrackDownloadState {
  status: 'idle' | 'downloading' | 'done' | 'error';
  errorMessage?: string;
}

interface TrackRowProps {
  track: EnrichedTrack;
  playlistSource: PlaylistSource;
  checked: boolean;
  downloadState: SingleTrackDownloadState;
  onToggleSelect: (trackId: string) => void;
  onDownloadTrack: (track: EnrichedTrack) => void;
}

export function TrackRow({
  track,
  playlistSource,
  checked,
  downloadState,
  onToggleSelect,
  onDownloadTrack,
}: TrackRowProps) {
  const [imgError, setImgError] = useState<boolean>(false);
  const isMatched = track.match !== null;
  const checkboxId = `track-select-${track.id}`;
  const isDownloading = downloadState.status === 'downloading';

  return (
    <tr
      className={`group border-b border-white/[0.06] transition-colors ${
        isMatched ? 'hover:bg-white/[0.03]' : 'opacity-70 hover:bg-white/[0.015]'
      }`}
    >
      <td className="w-11 py-3 pl-4 pr-2 align-middle">
        <div className="flex items-center justify-center">
          <input
            id={checkboxId}
            type="checkbox"
            checked={isMatched && checked}
            disabled={!isMatched}
            aria-disabled={!isMatched}
            aria-label={
              isMatched
                ? `Select ${track.name} by ${track.artist} for ZIP download`
                : `${track.name} by ${track.artist} is not available for download`
            }
            onChange={() => {
              if (isMatched) {
                onToggleSelect(track.id);
              }
            }}
            className="h-4 w-4 rounded border-white/25 bg-[#0A0D12] text-emerald-500 accent-emerald-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#12161F] disabled:cursor-not-allowed disabled:opacity-35 cursor-pointer"
          />
        </div>
      </td>

      <td className="py-3 px-3 align-middle">
        <div className="flex items-center gap-3 min-w-0">
          <div className="relative h-10 w-10 rounded-md overflow-hidden border border-white/[0.08] bg-gradient-to-br from-slate-800 to-slate-900 flex items-center justify-center shrink-0">
            {track.artworkUrl && !imgError ? (
              <Image
                src={track.artworkUrl}
                alt={`${track.album || track.name} artwork`}
                width={40}
                height={40}
                referrerPolicy="no-referrer"
                onError={() => setImgError(true)}
                className="h-10 w-10 object-cover"
              />
            ) : (
              <Disc3 className="h-5 w-5 text-slate-500" aria-hidden="true" />
            )}
          </div>

          <div className="min-w-0 flex-1">
            <label
              htmlFor={checkboxId}
              className={`block truncate text-sm font-medium text-slate-100 ${
                isMatched ? 'cursor-pointer' : 'cursor-default text-slate-300'
              }`}
            >
              {track.name}
            </label>
            <p className="truncate text-xs text-slate-400 mt-0.5">
              <span>{track.artist}</span>
              {track.album && (
                <>
                  <span aria-hidden="true" className="mx-1.5 text-slate-600">
                    ·
                  </span>
                  <span className="text-slate-500">{track.album}</span>
                </>
              )}
            </p>
            {/* Mobile compact status line */}
            <div className="mt-1 flex items-center gap-1.5 text-xs sm:hidden">
              {track.match ? (
                <span className="inline-flex items-center gap-1 text-emerald-400">
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>
                    Matched · {formatSourceName(track.match.source)} · {track.match.license}
                  </span>
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-slate-500">
                  <MinusCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span>Not available</span>
                </span>
              )}
            </div>
          </div>
        </div>
      </td>

      <td className="py-3 px-3 text-right align-middle font-mono text-xs text-slate-400 tabular-nums whitespace-nowrap">
        {formatDurationMs(track.durationMs)}
      </td>

      <td className="hidden md:table-cell py-3 px-3 align-middle whitespace-nowrap">
        <span className="inline-flex items-center gap-1.5 text-xs text-slate-300">
          <PlatformIcon source={playlistSource} className="h-3.5 w-3.5" />
          <span>{formatPlatformName(playlistSource)}</span>
        </span>
      </td>

      <td className="hidden sm:table-cell py-3 px-3 align-middle">
        {track.match ? (
          <div>
            <div className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span>Matched</span>
            </div>
            <p className="mt-0.5 text-xs text-slate-400 whitespace-nowrap">
              <span>{formatSourceName(track.match.source)}</span>
              <span aria-hidden="true" className="mx-1.5 text-slate-600">
                ·
              </span>
              <span>{track.match.license}</span>
              {track.match.bitrateKbps > 0 && (
                <>
                  <span aria-hidden="true" className="mx-1.5 text-slate-600">
                    ·
                  </span>
                  <span className="font-mono tabular-nums">{track.match.bitrateKbps} kbps</span>
                </>
              )}
            </p>
          </div>
        ) : (
          <div className="inline-flex items-center gap-1.5 text-xs text-slate-500">
            <MinusCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>Not available</span>
          </div>
        )}
      </td>

      <td className="py-3 pl-3 pr-4 text-right align-middle whitespace-nowrap">
        {isMatched ? (
          <div className="flex flex-col items-end gap-1">
            <button
              type="button"
              disabled={isDownloading}
              onClick={() => onDownloadTrack(track)}
              aria-label={`Download ${track.name} by ${track.artist}`}
              className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-white/[0.12] bg-white/[0.04] px-3 text-xs font-medium text-slate-200 hover:bg-white/[0.1] hover:text-white transition-colors whitespace-nowrap shrink-0 disabled:opacity-60 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            >
              {isDownloading ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  <span>Downloading</span>
                </>
              ) : (
                <>
                  <Download className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Download</span>
                </>
              )}
            </button>
            {downloadState.status === 'error' && downloadState.errorMessage && (
              <span
                role="alert"
                className="inline-flex items-center gap-1 text-[11px] text-red-400 max-w-[180px] truncate"
                title={downloadState.errorMessage}
              >
                <AlertCircle className="h-3 w-3 shrink-0" aria-hidden="true" />
                <span className="truncate">{downloadState.errorMessage}</span>
              </span>
            )}
          </div>
        ) : (
          <span className="text-xs text-slate-600" aria-label="Unavailable">
            —
          </span>
        )}
      </td>
    </tr>
  );
}
