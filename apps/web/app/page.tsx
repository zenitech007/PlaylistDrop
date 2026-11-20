import { ExplainerSection } from '../components/ExplainerSection';
import { FirebaseProvider } from '../components/FirebaseProvider';
import { PlaylistDropApp } from '../components/PlaylistDropApp';
import { TopBar } from '../components/TopBar';

export default function HomePage() {
  const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8000';

  return (
    <div className="flex min-h-screen flex-col bg-[#0A0D12]">
      <TopBar />

      <main className="flex-1">
        <FirebaseProvider>
          <PlaylistDropApp apiBaseUrl={apiBaseUrl} />
        </FirebaseProvider>
        <ExplainerSection />
      </main>

      <footer className="border-t border-white/[0.08] py-8">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <p>PlaylistDrop — Creative Commons playlist matching &amp; audio packaging.</p>
          <p>Downloads sourced strictly from open-license catalogs (Jamendo CC).</p>
        </div>
      </footer>
    </div>
  );
}
