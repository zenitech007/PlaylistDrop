'use client';

import { AlertCircle, CheckCircle2, Download, Loader2, Package, RefreshCw } from 'lucide-react';
import type { ZipJobStatus } from '../lib/types';

export interface ZipProgressState {
  phase: 'idle' | 'starting' | ZipJobStatus;
  jobId: string | null;
  completed: number;
  total: number;
  downloadUrl: string | null;
  error: string | null;
}

interface StickyActionBarProps {
  selectedCount: number;
  matchedCount: number;
  zipState: ZipProgressState;
  onStartZip: () => void;
  onTriggerZipDownload: () => void;
}

export function StickyActionBar({
  selectedCount,
  matchedCount,
  zipState,
  onStartZip,
  onTriggerZipDownload,
}: StickyActionBarProps) {
  const isBusy =
    zipState.phase === 'starting' || zipState.phase === 'pending' || zipState.phase === 'running';

  const progressPercent =
    zipState.total > 0 ? Math.min(100, Math.round((zipState.completed / zipState.total) * 100)) : 0;

  return (
    <div className="sticky bottom-0 z-30 border-t border-white/[0.1] bg-[#0D1118]/95 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
        <div aria-live="polite" aria-atomic="true" className="min-w-0 flex-1">
          {isBusy ? (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-4 text-xs sm:text-sm">
                <span className="inline-flex items-center gap-2 font-medium text-slate-100">
                  <Loader2
                    className="h-4 w-4 animate-spin text-emerald-400 shrink-0"
                    aria-hidden="true"
                  />
                  <span>
                    {zipState.phase === 'starting'
                      ? 'Starting ZIP archive…'
                      : `Packaging ${zipState.completed} of ${zipState.total} tracks…`}
                  </span>
                </span>
                <span className="font-mono text-xs text-slate-400 tabular-nums shrink-0">
                  {progressPercent}%
                </span>
              </div>
              <div
                role="progressbar"
                aria-label="ZIP download progress"
                aria-valuemin={0}
                aria-valuemax={Math.max(1, zipState.total)}
                aria-valuenow={zipState.completed}
                className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.08]"
              >
                <div
                  className="h-full rounded-full bg-emerald-400 transition-transform duration-200 origin-left"
                  style={{ transform: `scaleX(${Math.max(0.04, progressPercent / 100)})` }}
                />
              </div>
            </div>
          ) : zipState.phase === 'done' ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="inline-flex items-center gap-1.5 font-medium text-emerald-400">
                <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span>ZIP archive ready</span>
              </span>
              <span className="text-xs text-slate-400 font-mono tabular-nums">
                {zipState.completed} {zipState.completed === 1 ? 'track' : 'tracks'} packaged ·
                Individual downloads still available
              </span>
            </div>
          ) : zipState.phase === 'failed' ? (
            <div role="alert" className="flex items-center gap-2 text-sm text-red-400">
              <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="truncate">
                {zipState.error ?? 'ZIP archive failed. Try again or download tracks individually.'}
              </span>
            </div>
          ) : (
            <p className="text-sm text-slate-300 tabular-nums">
              <span className="font-semibold text-slate-100">{selectedCount}</span> of{' '}
              <span className="font-semibold text-slate-100">{matchedCount}</span> matched{' '}
              {matchedCount === 1 ? 'track' : 'tracks'} selected
            </p>
          )}
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          {zipState.phase === 'done' && zipState.downloadUrl && (
            <button
              type="button"
              onClick={onTriggerZipDownload}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md border border-emerald-400/40 bg-emerald-500/10 px-4 text-sm font-medium text-emerald-300 hover:bg-emerald-500/20 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            >
              <Download className="h-4 w-4" aria-hidden="true" />
              <span>Save ZIP again</span>
            </button>
          )}

          {zipState.phase === 'failed' ? (
            <button
              type="button"
              disabled={selectedCount === 0}
              onClick={onStartZip}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-emerald-500 px-5 text-sm font-semibold text-slate-950 hover:bg-emerald-400 transition-colors whitespace-nowrap shrink-0 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              <span>Retry ZIP ({selectedCount})</span>
            </button>
          ) : (
            <button
              type="button"
              disabled={selectedCount === 0 || isBusy}
              onClick={onStartZip}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-emerald-500 px-5 text-sm font-semibold text-slate-950 hover:bg-emerald-400 transition-colors whitespace-nowrap shrink-0 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
            >
              {isBusy ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  <span>Preparing ZIP…</span>
                </>
              ) : (
                <>
                  <Package className="h-4 w-4" aria-hidden="true" />
                  <span>Download Selected ({selectedCount})</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
