import type { Metadata } from 'next';
import { DM_Sans, JetBrains_Mono, Plus_Jakarta_Sans } from 'next/font/google';
import './globals.css';

const plusJakarta = Plus_Jakarta_Sans({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-plus-jakarta',
  display: 'swap',
});

const dmSans = DM_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-dm-sans',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-jetbrains-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'PlaylistDrop — Deezer, Spotify & YouTube Playlists to Creative Commons Downloads',
  description:
    'Resolve public Deezer, Spotify, or YouTube playlists without login, match tracks against Jamendo Creative Commons catalogs, and download audio individually or as a streamed ZIP.',
  openGraph: {
    title: 'PlaylistDrop — Deezer, Spotify & YouTube Playlists to Creative Commons Downloads',
    description:
      'Resolve public Deezer, Spotify, or YouTube playlists without login, match tracks against Jamendo Creative Commons catalogs, and download audio individually or as a streamed ZIP.',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'PlaylistDrop',
    description:
      'Match public Deezer, Spotify, and YouTube playlists to Creative Commons audio downloads and CSV/JSON exports.',
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${plusJakarta.variable} ${dmSans.variable} ${jetbrainsMono.variable} dark`}
    >
      <body
        suppressHydrationWarning
        className="min-h-screen bg-[#0A0D12] font-sans text-slate-100 antialiased selection:bg-emerald-500/30 selection:text-emerald-100"
      >
        {children}
      </body>
    </html>
  );
}
