import type { PlaylistSource } from './types';

export function formatDurationMs(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return '—';
  }
  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function formatPlatformName(source: PlaylistSource): string {
  if (source === 'deezer') return 'Deezer';
  if (source === 'spotify') return 'Spotify';
  return 'YouTube';
}

export function formatSourceName(source: string): string {
  const normalized = source.trim().toLowerCase();
  if (normalized === 'jamendo') return 'Jamendo';
  if (normalized === 'fma') return 'Free Music Archive';
  if (normalized === 'soundcloud') return 'SoundCloud CC';
  if (normalized === 'deezer') return 'Deezer';
  if (normalized === 'spotify') return 'Spotify';
  if (normalized === 'youtube') return 'YouTube';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

export function slugifyFilename(value: string, extension: string): string {
  const cleaned = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
  const base = cleaned || 'playlistdrop-export';
  const ext = extension.startsWith('.') ? extension : `.${extension}`;
  return `${base}${ext}`;
}
