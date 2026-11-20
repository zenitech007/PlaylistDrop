import type { PlaylistSource } from './types';

const DEEZER_PATH_RE = /^\/(?:([a-zA-Z]{2})\/)?playlist\/(\d+)$/;
const SPOTIFY_PATH_RE = /^\/(?:intl-[a-zA-Z0-9-]+\/)?playlist\/([a-zA-Z0-9]{10,64})$/;
const SPOTIFY_URI_RE = /^spotify:playlist:([a-zA-Z0-9]{10,64})$/;
const YOUTUBE_LIST_ID_RE = /^[a-zA-Z0-9_-]{10,128}$/;

export interface PlaylistUrlDetection {
  valid: boolean;
  platform: PlaylistSource | null;
  error: string | null;
  playlistId?: string;
  storefront?: string;
}

const SUPPORTED_ERROR =
  'Unsupported playlist URL. Paste a public link from Deezer, Spotify (or spotify:playlist: URI), or YouTube.';

export function detectPlaylistUrl(rawUrl: string): PlaylistUrlDetection {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return {
      valid: false,
      platform: null,
      error: 'Paste a public playlist URL from Deezer, Spotify, or YouTube to continue.',
    };
  }

  // Spotify URI detection
  const uriMatch = SPOTIFY_URI_RE.exec(trimmed);
  if (uriMatch) {
    return {
      valid: true,
      platform: 'spotify',
      error: null,
      playlistId: uriMatch[1],
    };
  }
  if (trimmed.toLowerCase().startsWith('spotify:')) {
    return {
      valid: false,
      platform: 'spotify',
      error: 'Spotify URIs must follow the format spotify:playlist:{id}.',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    // Soft hint while typing before full protocol is entered
    const lower = trimmed.toLowerCase();
    const partialPlatform: PlaylistSource | null = lower.includes('spotify')
      ? 'spotify'
      : lower.includes('deezer')
        ? 'deezer'
        : lower.includes('youtube') || lower.includes('youtu.be')
          ? 'youtube'
          : null;
    return {
      valid: false,
      platform: partialPlatform,
      error: SUPPORTED_ERROR,
    };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return {
      valid: false,
      platform: null,
      error: SUPPORTED_ERROR,
    };
  }

  const host = parsed.hostname.toLowerCase();
  const normalizedPath = parsed.pathname.replace(/\/+$/, '');

  // Deezer
  if (host === 'deezer.com' || host === 'www.deezer.com') {
    const match = DEEZER_PATH_RE.exec(normalizedPath);
    if (match) {
      return {
        valid: true,
        platform: 'deezer',
        error: null,
        storefront: match[1]?.toLowerCase(),
        playlistId: match[2],
      };
    }
    return {
      valid: false,
      platform: 'deezer',
      error: 'Deezer links must point to a playlist: https://www.deezer.com/playlist/{id}.',
    };
  }

  // Spotify
  if (host === 'open.spotify.com') {
    const match = SPOTIFY_PATH_RE.exec(normalizedPath);
    if (match) {
      return {
        valid: true,
        platform: 'spotify',
        error: null,
        playlistId: match[1],
      };
    }
    return {
      valid: false,
      platform: 'spotify',
      error: 'Spotify links must point to a playlist: https://open.spotify.com/playlist/{id}.',
    };
  }

  // YouTube
  if (
    host === 'youtube.com' ||
    host === 'www.youtube.com' ||
    host === 'm.youtube.com' ||
    host === 'music.youtube.com' ||
    host === 'youtu.be'
  ) {
    const listId = parsed.searchParams.get('list')?.trim() ?? '';
    const validPath =
      (host === 'youtu.be' && normalizedPath.replace(/^\/+/, '').length > 0) ||
      normalizedPath === '/playlist' ||
      normalizedPath === '/watch';

    if (validPath && listId && YOUTUBE_LIST_ID_RE.test(listId)) {
      return {
        valid: true,
        platform: 'youtube',
        error: null,
        playlistId: listId,
      };
    }
    return {
      valid: false,
      platform: 'youtube',
      error:
        'YouTube links must include a playlist ID (?list=...), such as youtube.com/playlist?list={id} or youtu.be/{video}?list={id}.',
    };
  }

  return {
    valid: false,
    platform: null,
    error: SUPPORTED_ERROR,
  };
}
