import Link from 'next/link';

export function TopBar() {
  return (
    <header className="border-b border-white/[0.08] bg-[#0A0D12]/95 backdrop-blur-sm">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-8 px-4 sm:px-6 lg:px-8">
        <Link
          href="/"
          className="font-display text-lg font-semibold tracking-tight text-slate-100 whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0A0D12] rounded-sm"
        >
          PlaylistDrop
        </Link>

        <nav
          aria-label="Primary navigation"
          className="hidden md:flex items-center gap-7 text-sm font-medium text-slate-400"
        >
          <a
            href="#how-it-works"
            className="hover:text-slate-100 transition-colors whitespace-nowrap shrink-0"
          >
            How it works
          </a>
          <a
            href="#catalog-sources"
            className="hover:text-slate-100 transition-colors whitespace-nowrap shrink-0"
          >
            Sources
          </a>
          <a
            href="#licensing"
            className="hover:text-slate-100 transition-colors whitespace-nowrap shrink-0"
          >
            Licensing
          </a>
          <a
            href="#export-formats"
            className="hover:text-slate-100 transition-colors whitespace-nowrap shrink-0"
          >
            Export
          </a>
        </nav>

        <div className="flex items-center shrink-0">
          <a
            href="#playlist-input"
            className="inline-flex h-9 items-center justify-center rounded-md bg-emerald-500 px-4 text-sm font-medium text-slate-950 hover:bg-emerald-400 transition-colors whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0A0D12]"
          >
            Load Playlist
          </a>
        </div>
      </div>
    </header>
  );
}
