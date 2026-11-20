import { formatDurationMs, formatPlatformName, slugifyFilename } from './format';
import type { EnrichedTrack, PlaylistData } from './types';

function escapeCsvCell(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function buildTracklistCsv(playlist: PlaylistData, tracks: EnrichedTrack[]): string {
  const headers = [
    'Track ID',
    'Title',
    'Artist',
    'Album',
    'Duration',
    'Playlist Source',
    'Status',
    'Catalog Source',
    'License',
    'Bitrate (kbps)',
    'Match Score',
    'Download URL',
  ];

  const rows = tracks.map((track) => [
    track.id,
    track.name,
    track.artist,
    track.album,
    formatDurationMs(track.durationMs),
    formatPlatformName(playlist.source),
    track.match ? 'Matched' : 'Not available',
    track.match?.source ?? '',
    track.match?.license ?? '',
    track.match ? String(track.match.bitrateKbps) : '',
    track.match ? track.match.score.toFixed(2) : '',
    track.match?.downloadUrl ?? '',
  ]);

  return [headers, ...rows]
    .map((row) => row.map((cell) => escapeCsvCell(cell)).join(','))
    .join('\r\n');
}

export function buildTracklistJson(playlist: PlaylistData, tracks: EnrichedTrack[]): string {
  const payload = {
    exportedAt: new Date().toISOString(),
    playlist: {
      id: playlist.id,
      name: playlist.name,
      owner: playlist.owner,
      source: playlist.source,
      partial: Boolean(playlist.partial),
      artworkUrl: playlist.artworkUrl,
    },
    summary: {
      total: tracks.length,
      matched: tracks.filter((t) => t.match !== null).length,
      unmatched: tracks.filter((t) => t.match === null).length,
    },
    tracks: tracks.map((track) => ({
      id: track.id,
      name: track.name,
      artist: track.artist,
      album: track.album,
      durationMs: track.durationMs,
      durationFormatted: formatDurationMs(track.durationMs),
      artworkUrl: track.artworkUrl,
      status: track.match ? 'matched' : 'unavailable',
      match: track.match,
    })),
  };
  return JSON.stringify(payload, null, 2);
}

export function triggerBlobDownload(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
  }, 1500);
}

export function exportTracklistAsCsv(playlist: PlaylistData, tracks: EnrichedTrack[]): void {
  const csv = buildTracklistCsv(playlist, tracks);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  triggerBlobDownload(blob, slugifyFilename(playlist.name, 'csv'));
}

export function exportTracklistAsJson(playlist: PlaylistData, tracks: EnrichedTrack[]): void {
  const json = buildTracklistJson(playlist, tracks);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  triggerBlobDownload(blob, slugifyFilename(playlist.name, 'json'));
}
