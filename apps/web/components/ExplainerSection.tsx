export function ExplainerSection() {
  return (
    <section
      id="how-it-works"
      aria-labelledby="how-it-works-heading"
      className="mx-auto max-w-6xl px-4 py-16 sm:px-6 lg:px-8 border-t border-white/[0.08]"
    >
      <div className="max-w-2xl">
        <h2
          id="how-it-works-heading"
          className="font-display text-2xl font-semibold tracking-tight text-slate-100 text-balance"
        >
          How PlaylistDrop resolves and matches audio
        </h2>
        <p className="mt-3 text-[15px] leading-relaxed text-slate-400 tracking-[0.01em]">
          No user login required. PlaylistDrop reads public playlist metadata from Deezer, Spotify,
          or YouTube and only enables audio downloads for tracks released under open Creative
          Commons licenses.
        </p>
      </div>

      <div className="mt-10 grid grid-cols-1 gap-8 md:grid-cols-3 md:gap-0 md:divide-x md:divide-white/[0.08]">
        <div className="md:pr-8">
          <h3 className="font-display text-base font-semibold text-slate-100">
            01. Resolve public playlists
          </h3>
          <p className="mt-2.5 text-sm leading-relaxed text-slate-400">
            Paste any public Deezer, Spotify (URL or URI), or YouTube playlist up to 200 tracks. The
            backend auto-detects the platform, cleans messy YouTube titles into artist and track
            names, and normalizes artwork and durations.
          </p>
        </div>

        <div id="catalog-sources" className="md:px-8">
          <h3 className="font-display text-base font-semibold text-slate-100">
            02. Match Creative Commons
          </h3>
          <p className="mt-2.5 text-sm leading-relaxed text-slate-400">
            Each track is checked against the Jamendo free catalog in bounded concurrent batches.
            Only exact or high-confidence fuzzy matches (score &ge; 0.80) with downloadable Creative
            Commons licenses are enabled.
          </p>
        </div>

        <div id="export-formats" className="md:pl-8">
          <h3 className="font-display text-base font-semibold text-slate-100">
            03. Stream files or ZIP
          </h3>
          <p className="mt-2.5 text-sm leading-relaxed text-slate-400">
            Download matched MP3 files individually or package selected tracks into a single
            streamed ZIP archive. Unmatched commercial tracks remain visible and can always be
            exported as CSV or JSON.
          </p>
        </div>
      </div>

      <div
        id="licensing"
        className="mt-12 border-t border-white/[0.08] pt-8 flex flex-col gap-3 sm:flex-row sm:items-baseline sm:justify-between"
      >
        <div>
          <h3 className="text-sm font-semibold text-slate-200">
            Transparent licensing &amp; download safety
          </h3>
          <p className="mt-1 text-sm text-slate-400 max-w-3xl">
            Downloads are streamed exclusively from verified Creative Commons audio hosts returned
            by Jamendo (CC BY, CC BY-SA, CC BY-NC, CC0). Every download is SSRF-guarded against a
            10-minute matched-URL registry, Content-Type verified, and capped at 50 MB per file.
          </p>
        </div>
        <p className="text-xs font-mono text-slate-500 whitespace-nowrap shrink-0 tabular-nums">
          Max 200 tracks · 50 MB/file
        </p>
      </div>
    </section>
  );
}
