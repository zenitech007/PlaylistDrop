'use client';

import { Loader2 } from 'lucide-react';

interface TracklistSkeletonProps {
  phase: 'resolving' | 'matching';
  trackCountHint?: number;
}

const SKELETON_ROWS = [0, 1, 2, 3, 4, 5, 6, 7];

export function TracklistSkeleton({ phase, trackCountHint }: TracklistSkeletonProps) {
  const statusText =
    phase === 'resolving'
      ? 'Resolving playlist…'
      : trackCountHint
        ? `Matching ${trackCountHint} tracks against free catalogs…`
        : 'Matching tracks against free catalogs…';

  return (
    <section
      aria-busy="true"
      aria-label="Loading playlist"
      className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:px-8"
    >
      <div
        role="status"
        aria-live="polite"
        className="flex items-center gap-3 pb-6 border-b border-white/[0.08]"
      >
        <Loader2 className="h-5 w-5 animate-spin text-emerald-400 shrink-0" aria-hidden="true" />
        <div>
          <p className="text-base font-medium text-slate-100">{statusText}</p>
          <p className="text-xs text-slate-400 mt-0.5">
            {phase === 'resolving'
              ? 'Fetching public playlist metadata and normalizing tracks.'
              : 'Checking Jamendo Creative Commons catalog in bounded rate-limited batches.'}
          </p>
        </div>
      </div>

      <div className="mt-6 rounded-lg border border-white/[0.08] bg-[#12161F] overflow-hidden">
        <div className="grid grid-cols-[40px_1fr_68px_104px_180px_110px] items-center gap-4 border-b border-white/[0.08] px-4 py-3 text-xs font-medium text-slate-500">
          <div className="h-4 w-4 rounded bg-white/[0.06]" />
          <div>Track</div>
          <div className="text-right">Time</div>
          <div className="hidden md:block">Source</div>
          <div className="hidden sm:block">Status</div>
          <div className="text-right">Action</div>
        </div>

        <ul className="divide-y divide-white/[0.06]">
          {SKELETON_ROWS.map((row) => (
            <li
              key={row}
              className="grid grid-cols-[40px_1fr_68px_104px_180px_110px] items-center gap-4 px-4 py-3 animate-pulse"
            >
              <div className="h-4 w-4 rounded bg-white/[0.06]" />
              <div className="flex items-center gap-3 min-w-0">
                <div className="h-10 w-10 rounded-md bg-white/[0.07] shrink-0" />
                <div className="space-y-2 flex-1 min-w-0">
                  <div className="h-3.5 w-2/5 rounded bg-white/[0.08]" />
                  <div className="h-3 w-1/4 rounded bg-white/[0.05]" />
                </div>
              </div>
              <div className="ml-auto h-3.5 w-10 rounded bg-white/[0.06]" />
              <div className="hidden md:block h-3.5 w-16 rounded bg-white/[0.06]" />
              <div className="hidden sm:block space-y-1.5">
                <div className="h-3.5 w-24 rounded bg-white/[0.07]" />
                <div className="h-2.5 w-32 rounded bg-white/[0.04]" />
              </div>
              <div className="ml-auto h-8 w-24 rounded-md bg-white/[0.06]" />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
