import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  MatchResult,
  PlaylistData,
  Track,
  ZipJobStatus,
  ZipJobStatusResponse,
} from '@/apps/web/lib/types';
import { detectPlaylistUrl } from '@/apps/web/lib/validation';
import firebaseConfig from '@/firebase-applet-config.json';
import { NextRequest, NextResponse } from 'next/server';

const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_PLAYLIST_TRACKS = 200;
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const MATCH_REGISTRY_TTL_MS = 10 * 60 * 1000;
const ZIP_JOB_TTL_MS = 15 * 60 * 1000;
const PROVIDER_TIMEOUT_MS = 10_000;
const MAX_MATCH_CONCURRENCY = 5;
const SPOTIFY_TOKEN_BUFFER_MS = 60_000;
const FIREBASE_CONFIG_CACHE_TTL_MS = 30_000;

const ALLOWED_DOWNLOAD_DOMAINS = new Set<string>([
  'mp3d.jamendo.com',
  'mp3l.jamendo.com',
  'prod-1.storage.jamendo.com',
  'storage.jamendo.com',
  'cdn.jamendo.com',
  'audio.jamendo.com',
  'files.freemusicarchive.org',
]);

export interface RegisteredMatch {
  trackId: string;
  downloadUrl: string;
  hostname: string;
  filename: string;
  source: string;
  expiresAt: number;
}

interface ZipJobRecord {
  jobId: string;
  status: ZipJobStatus;
  completed: number;
  total: number;
  createdAt: number;
  tempPath: string | null;
  error: string | null;
}

interface SpotifyTokenCache {
  token: string;
  expiresAt: number;
}

interface FirebaseRuntimeConfig {
  fastapiUrl: string;
  nextPublicApiUrl: string;
  useFirebaseYoutubeKey: boolean;
  fetchedAt: number;
}

interface GlobalStore {
  rateBuckets: Map<string, number[]>;
  byUrl: Map<string, RegisteredMatch>;
  byTrackId: Map<string, RegisteredMatch>;
  registeredHosts: Map<string, number>;
  zipJobs: Map<string, ZipJobRecord>;
  spotifyToken: SpotifyTokenCache | null;
  firebaseRuntimeConfig: FirebaseRuntimeConfig | null;
}

const globalRef = globalThis as typeof globalThis & { __playlistDropStore?: GlobalStore };

function getStore(): GlobalStore {
  if (!globalRef.__playlistDropStore) {
    globalRef.__playlistDropStore = {
      rateBuckets: new Map(),
      byUrl: new Map(),
      byTrackId: new Map(),
      registeredHosts: new Map(),
      zipJobs: new Map(),
      spotifyToken: null,
      firebaseRuntimeConfig: null,
    };
  }
  return globalRef.__playlistDropStore;
}

function isSafeFastApiBaseUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  if (
    !host ||
    host === 'metadata.google.internal' ||
    host === 'metadata' ||
    host.endsWith('.internal') ||
    /^169\.254\./.test(host) ||
    /^0\./.test(host) ||
    host.startsWith('fe80:')
  ) {
    return false;
  }
  return true;
}

async function getFirebaseRuntimeConfig(): Promise<FirebaseRuntimeConfig> {
  const store = getStore();
  const now = Date.now();
  if (
    store.firebaseRuntimeConfig &&
    now - store.firebaseRuntimeConfig.fetchedAt < FIREBASE_CONFIG_CACHE_TTL_MS
  ) {
    return store.firebaseRuntimeConfig;
  }

  const fallback: FirebaseRuntimeConfig = {
    fastapiUrl: '',
    nextPublicApiUrl: '',
    useFirebaseYoutubeKey: true,
    fetchedAt: now,
  };

  const projectId = firebaseConfig.projectId?.trim();
  const databaseId = firebaseConfig.firestoreDatabaseId?.trim() || '(default)';
  const apiKey = firebaseConfig.apiKey?.trim();

  if (!projectId || !apiKey) {
    store.firebaseRuntimeConfig = fallback;
    return fallback;
  }

  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(databaseId)}/documents/appConfig/runtime?key=${encodeURIComponent(apiKey)}`;

  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(4_000),
      cache: 'no-store',
    });
    if (!resp.ok) {
      store.firebaseRuntimeConfig = fallback;
      return fallback;
    }

    const payload = (await resp.json()) as {
      fields?: Record<string, { stringValue?: string; booleanValue?: boolean }>;
    };
    const fields = payload.fields ?? {};
    const rawFastApi =
      typeof fields.fastapiUrl?.stringValue === 'string'
        ? fields.fastapiUrl.stringValue.trim()
        : '';
    const rawNextApi =
      typeof fields.nextPublicApiUrl?.stringValue === 'string'
        ? fields.nextPublicApiUrl.stringValue.trim()
        : '';
    const useFirebaseYoutubeKey =
      typeof fields.useFirebaseYoutubeKey?.booleanValue === 'boolean'
        ? fields.useFirebaseYoutubeKey.booleanValue
        : true;

    const resolved: FirebaseRuntimeConfig = {
      fastapiUrl: rawFastApi && isSafeFastApiBaseUrl(rawFastApi) ? rawFastApi : '',
      nextPublicApiUrl: rawNextApi && isSafeFastApiBaseUrl(rawNextApi) ? rawNextApi : '',
      useFirebaseYoutubeKey,
      fetchedAt: now,
    };
    store.firebaseRuntimeConfig = resolved;
    return resolved;
  } catch {
    store.firebaseRuntimeConfig = fallback;
    return fallback;
  }
}

export function jsonError(
  status: number,
  code: string,
  message: string,
  extraHeaders?: Record<string, string>
): NextResponse {
  return NextResponse.json(
    { error: { code, message } },
    {
      status,
      headers: {
        'X-Request-ID': crypto.randomUUID(),
        ...(extraHeaders ?? {}),
      },
    }
  );
}

export function checkRateLimit(request: NextRequest): NextResponse | null {
  const store = getStore();
  const forwarded = request.headers.get('x-forwarded-for');
  const clientIp = forwarded?.split(',')[0]?.trim() || '127.0.0.1';
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;

  const existing = store.rateBuckets.get(clientIp) ?? [];
  const active = existing.filter((ts) => ts > cutoff);

  if (active.length >= RATE_LIMIT_MAX) {
    const oldest = active[0] ?? now;
    const retryAfter = Math.max(1, Math.ceil((RATE_LIMIT_WINDOW_MS - (now - oldest)) / 1000));
    store.rateBuckets.set(clientIp, active);
    return jsonError(
      429,
      'RATE_LIMITED',
      `Rate limit exceeded (${RATE_LIMIT_MAX} requests/minute). Please retry in ${retryAfter} seconds.`,
      { 'Retry-After': String(retryAfter) }
    );
  }

  active.push(now);
  store.rateBuckets.set(clientIp, active);
  return null;
}

export async function maybeProxyToFastApi(
  request: NextRequest,
  apiPath: string
): Promise<Response | null> {
  const envFastApiUrl = process.env.FASTAPI_URL?.trim() ?? '';
  let fastApiUrl = envFastApiUrl;

  if (!fastApiUrl) {
    const firebaseRuntime = await getFirebaseRuntimeConfig();
    fastApiUrl = firebaseRuntime.fastapiUrl;
  }

  if (!fastApiUrl || !isSafeFastApiBaseUrl(fastApiUrl)) {
    return null;
  }

  const target = `${fastApiUrl.replace(/\/+$/, '')}${apiPath}`;
  const headers = new Headers();
  const contentType = request.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);
  const reqId = request.headers.get('x-request-id') ?? crypto.randomUUID();
  headers.set('x-request-id', reqId);

  const method = request.method;
  const body = method === 'GET' || method === 'HEAD' ? undefined : await request.text();

  const upstream = await fetch(target, {
    method,
    headers,
    body,
    cache: 'no-store',
  });

  const outHeaders = new Headers();
  for (const key of [
    'content-type',
    'content-disposition',
    'content-length',
    'retry-after',
    'x-request-id',
  ]) {
    const val = upstream.headers.get(key);
    if (val) outHeaders.set(key, val);
  }
  outHeaders.set('x-content-type-options', 'nosniff');

  return new Response(upstream.body, {
    status: upstream.status,
    headers: outHeaders,
  });
}

export function sanitizeAudioFilename(raw: string): string {
  const cleaned = raw.replace(/\0/g, '').replace(/\\/g, '/').split('/').pop() ?? '';
  const noTraversal = cleaned.replace(/\.\./g, '');
  let ext = '.mp3';
  let stem = noTraversal;
  for (const candidate of ['.mp3', '.flac', '.ogg', '.wav', '.m4a']) {
    if (noTraversal.toLowerCase().endsWith(candidate)) {
      ext = candidate;
      stem = noTraversal.slice(0, -candidate.length);
      break;
    }
  }
  const slug = stem
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return `${slug || 'track'}${ext}`;
}

function isForbiddenHost(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/\.+$/, '');
  if (!lower || lower === 'localhost' || lower === 'metadata.google.internal') return true;
  if (lower.endsWith('.local') || lower.endsWith('.internal')) return true;
  if (
    /^127\./.test(lower) ||
    /^10\./.test(lower) ||
    /^192\.168\./.test(lower) ||
    /^169\.254\./.test(lower) ||
    /^0\./.test(lower) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(lower) ||
    lower === '::1' ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower.startsWith('fe80:')
  ) {
    return true;
  }
  return false;
}

function purgeExpiredRegistry(): void {
  const store = getStore();
  const now = Date.now();
  for (const [k, v] of store.byUrl.entries()) {
    if (v.expiresAt <= now) store.byUrl.delete(k);
  }
  for (const [k, v] of store.byTrackId.entries()) {
    if (v.expiresAt <= now) store.byTrackId.delete(k);
  }
  for (const [k, exp] of store.registeredHosts.entries()) {
    if (exp <= now) store.registeredHosts.delete(k);
  }
}

export function registerMatchedUrl(
  trackId: string,
  downloadUrl: string,
  artist: string,
  title: string,
  source: string
): void {
  let parsed: URL;
  try {
    parsed = new URL(downloadUrl);
  } catch {
    return;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return;
  const hostname = parsed.hostname.toLowerCase();
  if (isForbiddenHost(hostname)) return;

  const store = getStore();
  const expiresAt = Date.now() + MATCH_REGISTRY_TTL_MS;
  const entry: RegisteredMatch = {
    trackId,
    downloadUrl,
    hostname,
    filename: sanitizeAudioFilename(`${artist} - ${title}`),
    source,
    expiresAt,
  };
  store.byUrl.set(downloadUrl, entry);
  store.byTrackId.set(trackId, entry);
  store.registeredHosts.set(hostname, expiresAt);
}

export function validateDownloadUrl(
  rawUrl: string
): { ok: true; registered: RegisteredMatch | null } | { ok: false; response: NextResponse } {
  purgeExpiredRegistry();
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return {
      ok: false,
      response: jsonError(400, 'INVALID_DOWNLOAD_URL', 'Download URL is invalid.'),
    };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return {
      ok: false,
      response: jsonError(400, 'INVALID_DOWNLOAD_URL', 'Only HTTP/HTTPS audio URLs are permitted.'),
    };
  }
  if (parsed.username || parsed.password) {
    return {
      ok: false,
      response: jsonError(
        400,
        'INVALID_DOWNLOAD_URL',
        'Credentials in download URLs are not allowed.'
      ),
    };
  }
  const hostname = parsed.hostname.toLowerCase();
  if (isForbiddenHost(hostname)) {
    return {
      ok: false,
      response: jsonError(400, 'SSRF_BLOCKED', 'Download host is not permitted.'),
    };
  }

  const store = getStore();
  const exact = store.byUrl.get(rawUrl.trim());
  if (exact) {
    return { ok: true, registered: exact };
  }
  if (store.registeredHosts.has(hostname) || ALLOWED_DOWNLOAD_DOMAINS.has(hostname)) {
    return { ok: true, registered: null };
  }

  return {
    ok: false,
    response: jsonError(
      400,
      'SSRF_BLOCKED',
      'Download URL is not from a verified matched track or allowed catalog domain.'
    ),
  };
}

async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  maxAttempts = 3
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        cache: 'no-store',
      });
      if (response.status >= 500 && attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 350 * 2 ** (attempt - 1)));
        continue;
      }
      return response;
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 350 * 2 ** (attempt - 1)));
      }
    }
  }
  throw lastError;
}

// --- Deezer Resolver (credential-free) ---
async function resolveDeezerPlaylist(playlistId: string): Promise<NextResponse> {
  let response: Response;
  try {
    response = await fetchWithRetry(`https://api.deezer.com/playlist/${playlistId}`);
  } catch {
    return jsonError(502, 'UPSTREAM_NETWORK_ERROR', 'Unable to reach Deezer API.');
  }

  if (response.status === 404) {
    return jsonError(404, 'PLAYLIST_NOT_FOUND', 'Deezer playlist not found or is private.');
  }
  if (!response.ok) {
    return jsonError(
      502,
      'UPSTREAM_ERROR',
      'Deezer returned an error while loading this playlist.'
    );
  }

  const payload = (await response.json()) as Record<string, unknown>;
  if (typeof payload.error === 'object' && payload.error !== null) {
    const err = payload.error as Record<string, unknown>;
    if (err.code === 4) {
      return jsonError(503, 'UPSTREAM_RATE_LIMITED', 'Deezer API rate limit reached.', {
        'Retry-After': '15',
      });
    }
    return jsonError(404, 'PLAYLIST_NOT_FOUND', 'Deezer playlist not found or is private.');
  }

  if (typeof payload.nb_tracks === 'number' && payload.nb_tracks > MAX_PLAYLIST_TRACKS) {
    return jsonError(
      422,
      'PLAYLIST_TOO_LARGE',
      `This playlist has ${payload.nb_tracks} tracks, which exceeds the maximum limit of ${MAX_PLAYLIST_TRACKS} tracks.`
    );
  }

  const tracksObj = (payload.tracks ?? {}) as Record<string, unknown>;
  const rawTracks: unknown[] = Array.isArray(tracksObj.data) ? [...tracksObj.data] : [];
  let nextUrl = typeof tracksObj.next === 'string' ? tracksObj.next : null;

  while (nextUrl) {
    const pageResp = await fetchWithRetry(nextUrl);
    if (!pageResp.ok) break;
    const pageData = (await pageResp.json()) as Record<string, unknown>;
    const pageItems = Array.isArray(pageData.data) ? pageData.data : [];
    if (rawTracks.length + pageItems.length > MAX_PLAYLIST_TRACKS) {
      return jsonError(
        422,
        'PLAYLIST_TOO_LARGE',
        `This playlist exceeds the maximum limit of ${MAX_PLAYLIST_TRACKS} tracks.`
      );
    }
    rawTracks.push(...pageItems);
    nextUrl = typeof pageData.next === 'string' ? pageData.next : null;
  }

  const tracks: Track[] = [];
  for (const item of rawTracks) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    const artistObj = (rec.artist ?? {}) as Record<string, unknown>;
    const albumObj = (rec.album ?? {}) as Record<string, unknown>;
    const id = String(rec.id ?? '').trim();
    const name = typeof rec.title === 'string' ? rec.title.trim() : '';
    const artist = typeof artistObj.name === 'string' ? artistObj.name.trim() : '';
    if (!id || !name || !artist) continue;

    const artwork =
      (typeof albumObj.cover_medium === 'string' && albumObj.cover_medium) ||
      (typeof albumObj.cover_big === 'string' && albumObj.cover_big) ||
      (typeof albumObj.cover === 'string' && albumObj.cover) ||
      null;

    tracks.push({
      id: `deezer:${id}`,
      name,
      artist,
      album: typeof albumObj.title === 'string' ? albumObj.title.trim() : '',
      durationMs:
        typeof rec.duration === 'number' && rec.duration >= 0 ? Math.floor(rec.duration * 1000) : 0,
      artworkUrl: artwork,
    });
  }

  const creator = (payload.creator ?? {}) as Record<string, unknown>;
  const artworkUrl =
    (typeof payload.picture_big === 'string' && payload.picture_big) ||
    (typeof payload.picture_medium === 'string' && payload.picture_medium) ||
    (typeof payload.picture === 'string' && payload.picture) ||
    null;

  const result: PlaylistData = {
    id: String(payload.id ?? playlistId),
    name: typeof payload.title === 'string' ? payload.title : 'Untitled Deezer Playlist',
    owner: typeof creator.name === 'string' ? creator.name : null,
    artworkUrl,
    tracks,
    source: 'deezer',
    partial: false,
  };
  return NextResponse.json(result);
}

// --- Spotify Resolver (Client Credentials OAuth + 60s expiry buffer) ---
async function getSpotifyToken(forceRefresh = false): Promise<string | NextResponse> {
  const clientId = process.env.SPOTIFY_CLIENT_ID?.trim() ?? '';
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET?.trim() ?? '';
  if (!clientId || !clientSecret) {
    return jsonError(
      500,
      'SPOTIFY_CONFIG_ERROR',
      'Spotify API credentials are not configured on the server. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in your environment.'
    );
  }

  const store = getStore();
  const now = Date.now();
  if (
    !forceRefresh &&
    store.spotifyToken &&
    now < store.spotifyToken.expiresAt - SPOTIFY_TOKEN_BUFFER_MS
  ) {
    return store.spotifyToken.token;
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64');
  let resp: Response;
  try {
    resp = await fetchWithRetry('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
  } catch {
    return jsonError(502, 'UPSTREAM_NETWORK_ERROR', 'Unable to authenticate with Spotify API.');
  }

  if (resp.status === 400 || resp.status === 401) {
    return jsonError(
      500,
      'SPOTIFY_AUTH_ERROR',
      'Spotify rejected the server client credentials. Verify SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.'
    );
  }
  if (!resp.ok) {
    return jsonError(502, 'SPOTIFY_AUTH_ERROR', 'Failed to obtain Spotify access token.');
  }

  const data = (await resp.json()) as Record<string, unknown>;
  const token = typeof data.access_token === 'string' ? data.access_token : '';
  const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600;
  if (!token) {
    return jsonError(502, 'SPOTIFY_AUTH_ERROR', 'Spotify did not return an access token.');
  }
  store.spotifyToken = { token, expiresAt: Date.now() + expiresIn * 1000 };
  return token;
}

function pickSpotifyImage(images: unknown): string | null {
  if (!Array.isArray(images) || images.length === 0) return null;
  for (const img of images) {
    if (typeof img === 'object' && img !== null) {
      const r = img as Record<string, unknown>;
      if (
        typeof r.url === 'string' &&
        typeof r.width === 'number' &&
        r.width >= 150 &&
        r.width <= 400
      ) {
        return r.url;
      }
    }
  }
  const first = images[0] as Record<string, unknown> | undefined;
  return typeof first?.url === 'string' ? first.url : null;
}

async function resolveSpotifyPlaylist(playlistId: string): Promise<NextResponse> {
  const tokenOrErr = await getSpotifyToken();
  if (tokenOrErr instanceof NextResponse) return tokenOrErr;
  let token = tokenOrErr;

  let response: Response;
  try {
    response = await fetchWithRetry(`https://api.spotify.com/v1/playlists/${playlistId}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (response.status === 401) {
      const refreshed = await getSpotifyToken(true);
      if (refreshed instanceof NextResponse) return refreshed;
      token = refreshed;
      response = await fetchWithRetry(`https://api.spotify.com/v1/playlists/${playlistId}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
    }
  } catch {
    return jsonError(502, 'UPSTREAM_NETWORK_ERROR', 'Unable to reach Spotify API.');
  }

  if (response.status === 404 || response.status === 403) {
    return jsonError(
      404,
      'PLAYLIST_NOT_FOUND',
      'Spotify playlist not found or is private. Make sure the playlist is public.'
    );
  }
  if (response.status === 429) {
    return jsonError(503, 'UPSTREAM_RATE_LIMITED', 'Spotify API rate limit reached.', {
      'Retry-After': response.headers.get('retry-after') ?? '30',
    });
  }
  if (!response.ok) {
    return jsonError(
      502,
      'UPSTREAM_ERROR',
      'Spotify returned an error while loading this playlist.'
    );
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const tracksObj = (payload.tracks ?? {}) as Record<string, unknown>;
  if (typeof tracksObj.total === 'number' && tracksObj.total > MAX_PLAYLIST_TRACKS) {
    return jsonError(
      422,
      'PLAYLIST_TOO_LARGE',
      `This playlist has ${tracksObj.total} tracks, which exceeds the maximum limit of ${MAX_PLAYLIST_TRACKS} tracks.`
    );
  }

  const rawItems: unknown[] = Array.isArray(tracksObj.items) ? [...tracksObj.items] : [];
  let nextUrl = typeof tracksObj.next === 'string' ? tracksObj.next : null;

  while (nextUrl) {
    const pageResp = await fetchWithRetry(nextUrl, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!pageResp.ok) break;
    const pageData = (await pageResp.json()) as Record<string, unknown>;
    const pageItems = Array.isArray(pageData.items) ? pageData.items : [];
    if (rawItems.length + pageItems.length > MAX_PLAYLIST_TRACKS) {
      return jsonError(
        422,
        'PLAYLIST_TOO_LARGE',
        `This playlist exceeds the maximum limit of ${MAX_PLAYLIST_TRACKS} tracks.`
      );
    }
    rawItems.push(...pageItems);
    nextUrl = typeof pageData.next === 'string' ? pageData.next : null;
  }

  const tracks: Track[] = [];
  for (const entry of rawItems) {
    if (typeof entry !== 'object' || entry === null) continue;
    const t = (entry as Record<string, unknown>).track;
    if (typeof t !== 'object' || t === null) continue;
    const rec = t as Record<string, unknown>;
    const id = typeof rec.id === 'string' ? rec.id.trim() : '';
    const name = typeof rec.name === 'string' ? rec.name.trim() : '';
    const artistsArr = Array.isArray(rec.artists) ? rec.artists : [];
    const artist = artistsArr
      .map((a) =>
        typeof a === 'object' &&
        a !== null &&
        typeof (a as Record<string, unknown>).name === 'string'
          ? ((a as Record<string, unknown>).name as string).trim()
          : ''
      )
      .filter(Boolean)
      .join(', ');
    if (!id || !name || !artist) continue;

    const albumObj = (rec.album ?? {}) as Record<string, unknown>;
    tracks.push({
      id: `spotify:${id}`,
      name,
      artist,
      album: typeof albumObj.name === 'string' ? albumObj.name.trim() : '',
      durationMs:
        typeof rec.duration_ms === 'number' && rec.duration_ms >= 0
          ? Math.floor(rec.duration_ms)
          : 0,
      artworkUrl: pickSpotifyImage(albumObj.images),
    });
  }

  const ownerObj = (payload.owner ?? {}) as Record<string, unknown>;
  const owner =
    (typeof ownerObj.display_name === 'string' && ownerObj.display_name.trim()) ||
    (typeof ownerObj.id === 'string' && ownerObj.id.trim()) ||
    null;

  const result: PlaylistData = {
    id: typeof payload.id === 'string' ? payload.id : playlistId,
    name: typeof payload.name === 'string' ? payload.name : 'Untitled Spotify Playlist',
    owner,
    artworkUrl: pickSpotifyImage(payload.images),
    tracks,
    source: 'spotify',
    partial: false,
  };
  return NextResponse.json(result);
}

// --- YouTube Resolver (Data API v3 + pagination + quotaExceeded partial + title parser) ---
function parseYouTubeTitle(
  rawTitle: string,
  channelName: string
): { artist: string; title: string } {
  const cleanedChannel =
    channelName
      .trim()
      .replace(/\s*-\s*Topic$/i, '')
      .replace(/(?:VEVO|Official)$/i, '')
      .trim() || 'Unknown Artist';

  const cleaned = rawTitle
    .trim()
    .replace(
      /\s*[(\[]\s*(?:official\s+(?:music\s+)?video|official\s+audio|official\s+lyric\s+video|lyric\s+video|lyrics?|audio|hd|4k|hq|visualizer|music\s+video|full\s+video|explicit|clean\s+version|live\s+performance|remastered(?:\s+\d{4})?)\s*[)\]]/gi,
      ''
    )
    .replace(/\s*\|\s*(?:official.*|lyrics?.*|audio.*|hd.*|4k.*)$/i, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—:]+|[\s\-–—:]+$/g, '');

  if (!cleaned) {
    return { artist: cleanedChannel, title: rawTitle.trim() || 'Untitled Track' };
  }

  const sepMatch = cleaned.match(/^(.*?)(?:\s+(?:-|–|—|\|)\s+|:\s+)(.+)$/);
  if (sepMatch) {
    const artistPart = (sepMatch[1] ?? '').trim().replace(/^["']+|["']+$/g, '');
    const titlePart = (sepMatch[2] ?? '').trim().replace(/^["']+|["']+$/g, '');
    if (artistPart && titlePart) {
      return { artist: artistPart, title: titlePart };
    }
  }

  return { artist: cleanedChannel, title: cleaned };
}

function pickYouTubeThumbnail(thumbnails: unknown): string | null {
  if (typeof thumbnails !== 'object' || thumbnails === null) return null;
  const rec = thumbnails as Record<string, unknown>;
  for (const key of ['medium', 'high', 'standard', 'default']) {
    const entry = rec[key];
    if (
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as Record<string, unknown>).url === 'string'
    ) {
      return (entry as Record<string, unknown>).url as string;
    }
  }
  return null;
}

async function resolveYouTubePlaylist(playlistId: string): Promise<NextResponse> {
  const envKey = process.env.YOUTUBE_API_KEY?.trim() ?? '';
  const firebaseRuntime = envKey ? null : await getFirebaseRuntimeConfig();
  const firebaseFallbackKey =
    firebaseRuntime && firebaseRuntime.useFirebaseYoutubeKey
      ? (firebaseConfig.apiKey?.trim() ?? '')
      : '';
  const apiKey = envKey || firebaseFallbackKey;

  if (!apiKey) {
    return jsonError(
      500,
      'YOUTUBE_CONFIG_ERROR',
      'YouTube API key is not configured on the server. Set YOUTUBE_API_KEY in your environment or enable the Google Cloud project fallback in Firebase Config.'
    );
  }

  const collected: Record<string, unknown>[] = [];
  let pageToken: string | null = null;
  let partial = false;

  while (true) {
    const params = new URLSearchParams({
      part: 'snippet',
      playlistId,
      maxResults: '50',
      key: apiKey,
    });
    if (pageToken) params.set('pageToken', pageToken);

    let resp: Response;
    try {
      resp = await fetchWithRetry(
        `https://www.googleapis.com/youtube/v3/playlistItems?${params.toString()}`
      );
    } catch {
      return jsonError(502, 'UPSTREAM_NETWORK_ERROR', 'Unable to reach YouTube Data API.');
    }

    if (resp.status === 403) {
      const errBody = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
      const errObj = (errBody.error ?? {}) as Record<string, unknown>;
      const reasons = Array.isArray(errObj.errors)
        ? errObj.errors.map((e) =>
            typeof e === 'object' && e !== null
              ? String((e as Record<string, unknown>).reason ?? '')
              : ''
          )
        : [];
      const errMsg = String(errObj.message ?? '');
      const errMsgLower = errMsg.toLowerCase();

      const isServiceDisabled =
        reasons.some(
          (r) =>
            r === 'accessNotConfigured' ||
            r === 'API_KEY_SERVICE_BLOCKED' ||
            r === 'SERVICE_DISABLED'
        ) ||
        errMsgLower.includes('has not been used in project') ||
        errMsgLower.includes('is disabled') ||
        errMsgLower.includes('api_key_service_blocked');

      if (isServiceDisabled) {
        return jsonError(
          503,
          'YOUTUBE_API_DISABLED',
          `YouTube Data API v3 is not enabled yet for Google Cloud project ${firebaseConfig.projectId}. Enable it in Google Cloud Console and retry.`
        );
      }

      const isQuota =
        reasons.some(
          (r) =>
            r === 'quotaExceeded' || r === 'dailyLimitExceeded' || r === 'userRateLimitExceeded'
        ) || errMsgLower.includes('quota');

      if (isQuota) {
        if (collected.length > 0) {
          partial = true;
          break;
        }
        return jsonError(
          503,
          'YOUTUBE_QUOTA_EXCEEDED',
          'YouTube Data API daily quota has been exceeded. Please try again later or try a Deezer or Spotify playlist.',
          { 'Retry-After': '3600' }
        );
      }
      return jsonError(404, 'PLAYLIST_NOT_FOUND', 'YouTube playlist is private or inaccessible.');
    }

    if (resp.status === 404) {
      return jsonError(404, 'PLAYLIST_NOT_FOUND', 'YouTube playlist not found or is private.');
    }
    if (resp.status === 400) {
      return jsonError(
        500,
        'YOUTUBE_CONFIG_ERROR',
        'YouTube API rejected the request. Verify YOUTUBE_API_KEY or Google Cloud API key restrictions.'
      );
    }
    if (!resp.ok) {
      return jsonError(
        502,
        'UPSTREAM_ERROR',
        'YouTube returned an error while loading this playlist.'
      );
    }

    const page = (await resp.json()) as Record<string, unknown>;
    const pageInfo = (page.pageInfo ?? {}) as Record<string, unknown>;
    if (typeof pageInfo.totalResults === 'number' && pageInfo.totalResults > MAX_PLAYLIST_TRACKS) {
      return jsonError(
        422,
        'PLAYLIST_TOO_LARGE',
        `This playlist has ${pageInfo.totalResults} tracks, which exceeds the maximum limit of ${MAX_PLAYLIST_TRACKS} tracks.`
      );
    }

    const items = Array.isArray(page.items) ? (page.items as Record<string, unknown>[]) : [];
    if (collected.length + items.length > MAX_PLAYLIST_TRACKS) {
      return jsonError(
        422,
        'PLAYLIST_TOO_LARGE',
        `This playlist exceeds the maximum limit of ${MAX_PLAYLIST_TRACKS} tracks.`
      );
    }
    collected.push(...items);

    pageToken =
      typeof page.nextPageToken === 'string' && page.nextPageToken ? page.nextPageToken : null;
    if (!pageToken) break;
  }

  let playlistName = `YouTube Playlist (${playlistId})`;
  let owner: string | null = null;
  let playlistArt: string | null = null;

  if (!partial) {
    try {
      const metaParams = new URLSearchParams({ part: 'snippet', id: playlistId, key: apiKey });
      const metaResp = await fetchWithRetry(
        `https://www.googleapis.com/youtube/v3/playlists?${metaParams.toString()}`
      );
      if (metaResp.ok) {
        const metaJson = (await metaResp.json()) as Record<string, unknown>;
        const first = Array.isArray(metaJson.items)
          ? (metaJson.items[0] as Record<string, unknown> | undefined)
          : undefined;
        const snippet = (first?.snippet ?? {}) as Record<string, unknown>;
        if (typeof snippet.title === 'string' && snippet.title.trim())
          playlistName = snippet.title.trim();
        if (typeof snippet.channelTitle === 'string' && snippet.channelTitle.trim())
          owner = snippet.channelTitle.trim();
        playlistArt = pickYouTubeThumbnail(snippet.thumbnails);
      }
    } catch {
      // Optional metadata lookup failed; keep default title
    }
  }

  const tracks: Track[] = [];
  for (const item of collected) {
    const snippet = (item.snippet ?? {}) as Record<string, unknown>;
    const rawTitle = typeof snippet.title === 'string' ? snippet.title.trim() : '';
    if (
      !rawTitle ||
      rawTitle.toLowerCase() === 'deleted video' ||
      rawTitle.toLowerCase() === 'private video'
    ) {
      continue;
    }
    const resource = (snippet.resourceId ?? {}) as Record<string, unknown>;
    const videoId =
      (typeof resource.videoId === 'string' && resource.videoId.trim()) ||
      (typeof item.id === 'string' && item.id.trim()) ||
      '';
    if (!videoId) continue;

    const channelName =
      (typeof snippet.videoOwnerChannelTitle === 'string' && snippet.videoOwnerChannelTitle) ||
      (typeof snippet.channelTitle === 'string' && snippet.channelTitle) ||
      'Unknown Artist';

    const parsed = parseYouTubeTitle(rawTitle, channelName);
    tracks.push({
      id: `youtube:${videoId}`,
      name: parsed.title,
      artist: parsed.artist,
      album: '',
      durationMs: 0,
      artworkUrl: pickYouTubeThumbnail(snippet.thumbnails),
    });
  }

  const result: PlaylistData = {
    id: playlistId,
    name: playlistName,
    owner,
    artworkUrl: playlistArt ?? tracks[0]?.artworkUrl ?? null,
    tracks,
    source: 'youtube',
    partial,
  };
  return NextResponse.json(result);
}

export async function resolveMultiPlatformPlaylist(rawUrl: string): Promise<NextResponse> {
  const detected = detectPlaylistUrl(rawUrl);
  if (!detected.valid || !detected.platform || !detected.playlistId) {
    return jsonError(
      400,
      'UNSUPPORTED_PLAYLIST_URL',
      'Unsupported or malformed playlist URL. Supported platforms: Deezer (deezer.com/playlist/{id}), Spotify (open.spotify.com/playlist/{id} or spotify:playlist:{id}), and YouTube (youtube.com/playlist?list={id}, music.youtube.com/..., youtu.be/{video}?list={id}).'
    );
  }

  if (detected.platform === 'deezer') {
    return resolveDeezerPlaylist(detected.playlistId);
  }
  if (detected.platform === 'spotify') {
    return resolveSpotifyPlaylist(detected.playlistId);
  }
  return resolveYouTubePlaylist(detected.playlistId);
}

// --- Jamendo CC Matching ---
function normalizeMusicText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(?:feat\.?|ft\.?|featuring)\b.*$/, '')
    .replace(/\s*[(\[].*?[)\]]\s*/g, ' ')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshteinSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0) return 0;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0] ?? 0;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j] ?? 0;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[j] = Math.min((dp[j] ?? 0) + 1, (dp[j - 1] ?? 0) + 1, prev + cost);
      prev = temp;
    }
  }
  const distance = dp[n] ?? Math.max(m, n);
  return 1 - distance / Math.max(m, n);
}

function scoreTrackMatch(
  queryTitle: string,
  queryArtist: string,
  candTitle: string,
  candArtist: string
): number {
  const qt = normalizeMusicText(queryTitle);
  const qa = normalizeMusicText(queryArtist);
  const ct = normalizeMusicText(candTitle);
  const ca = normalizeMusicText(candArtist);
  if (!qt || !qa || !ct || !ca) return 0;
  if (qt === ct && qa === ca) return 1.0;

  const titleRatio = levenshteinSimilarity(qt, ct);
  const artistRatio = levenshteinSimilarity(qa, ca);
  if (titleRatio < 0.6 || artistRatio < 0.6) {
    return Number(Math.min(titleRatio, artistRatio).toFixed(4));
  }
  return Number(Math.min(titleRatio * 0.55 + artistRatio * 0.45, 0.99).toFixed(4));
}

function parseCcLicense(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const match = url.match(
    /creativecommons\.org\/(?:licenses\/([a-z-]+)\/([0-9.]+)|publicdomain\/zero\/([0-9.]+))/i
  );
  if (!match) return null;
  if (match[3]) return `CC0 ${match[3]}`;
  return `CC ${(match[1] ?? '').toUpperCase()} ${match[2] ?? ''}`.trim();
}

async function fetchJamendoWithRetry(params: URLSearchParams): Promise<Record<string, unknown>[]> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetch(`https://api.jamendo.com/v3.0/tracks/?${params.toString()}`, {
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
        cache: 'no-store',
      });
      if (resp.status === 429 || resp.status >= 500) {
        throw new Error(`Transient Jamendo status ${resp.status}`);
      }
      if (!resp.ok) return [];
      const data = (await resp.json()) as Record<string, unknown>;
      return Array.isArray(data.results) ? (data.results as Record<string, unknown>[]) : [];
    } catch {
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 350 * 2 ** (attempt - 1)));
      }
    }
  }
  return [];
}

async function matchSingleTrackOnJamendo(
  track: Track,
  clientId: string
): Promise<MatchResult | null> {
  const params = new URLSearchParams({
    client_id: clientId,
    format: 'json',
    limit: '5',
    namesearch: track.name,
    artist_name: track.artist,
    audioformat: 'mp32',
    include: 'licenses',
  });
  let candidates = await fetchJamendoWithRetry(params);
  if (candidates.length === 0) {
    const fallback = new URLSearchParams({
      client_id: clientId,
      format: 'json',
      limit: '5',
      search: `${track.artist} ${track.name}`,
      audioformat: 'mp32',
      include: 'licenses',
    });
    candidates = await fetchJamendoWithRetry(fallback);
  }

  let best: MatchResult | null = null;
  for (const item of candidates) {
    if (!item.audiodownload_allowed) continue;
    const downloadUrl = typeof item.audiodownload === 'string' ? item.audiodownload.trim() : '';
    if (!downloadUrl.startsWith('http://') && !downloadUrl.startsWith('https://')) continue;
    const license = parseCcLicense(item.license_ccurl);
    if (!license) continue;

    const score = scoreTrackMatch(
      track.name,
      track.artist,
      String(item.name ?? ''),
      String(item.artist_name ?? '')
    );
    if (score < 0.8) continue;

    if (!best || score > best.score) {
      best = {
        trackId: track.id,
        source: 'jamendo',
        downloadUrl,
        license,
        bitrateKbps: 192,
        score,
      };
    }
  }

  return best;
}

export async function matchTracksCatalog(tracks: Track[]): Promise<MatchResult[]> {
  const clientId = process.env.JAMENDO_CLIENT_ID?.trim() ?? '';
  if (!clientId) {
    return [];
  }

  const results: Array<MatchResult | null> = new Array(tracks.length).fill(null);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < tracks.length) {
      const idx = cursor++;
      const track = tracks[idx];
      if (!track) continue;
      const match = await matchSingleTrackOnJamendo(track, clientId);
      if (match) {
        registerMatchedUrl(
          match.trackId,
          match.downloadUrl,
          track.artist,
          track.name,
          match.source
        );
        results[idx] = match;
      }
    }
  }

  const workerCount = Math.min(MAX_MATCH_CONCURRENCY, tracks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results.filter((m): m is MatchResult => m !== null);
}

export async function streamSingleTrackDownload(
  downloadUrl: string,
  requestedFilename?: string
): Promise<Response> {
  const validation = validateDownloadUrl(downloadUrl);
  if (!validation.ok) return validation.response;

  let upstream: Response;
  try {
    upstream = await fetch(downloadUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
      cache: 'no-store',
    });
  } catch {
    return jsonError(502, 'DOWNLOAD_UPSTREAM_ERROR', 'Could not connect to the audio source.');
  }

  const finalValidation = validateDownloadUrl(upstream.url);
  if (!finalValidation.ok) return finalValidation.response;

  if (!upstream.ok || !upstream.body) {
    return jsonError(404, 'UPSTREAM_AUDIO_UNAVAILABLE', 'Audio file could not be downloaded.');
  }

  const contentType = upstream.headers.get('content-type') ?? '';
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (mime !== 'audio/mpeg' && !mime.startsWith('audio/')) {
    return jsonError(415, 'INVALID_AUDIO_CONTENT_TYPE', 'Upstream did not return an audio file.');
  }

  const lengthHeader = upstream.headers.get('content-length');
  if (lengthHeader) {
    const parsedLength = Number.parseInt(lengthHeader, 10);
    if (Number.isFinite(parsedLength) && parsedLength > MAX_DOWNLOAD_BYTES) {
      return jsonError(413, 'FILE_TOO_LARGE', 'Audio file exceeds the 50 MB download limit.');
    }
  }

  const filename = sanitizeAudioFilename(
    requestedFilename || validation.registered?.filename || 'track.mp3'
  );

  let totalBytes = 0;
  const reader = upstream.body.getReader();
  const boundedStream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      totalBytes += value.byteLength;
      if (totalBytes > MAX_DOWNLOAD_BYTES) {
        await reader.cancel();
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    async cancel() {
      await reader.cancel();
    },
  });

  const headers = new Headers({
    'Content-Type': mime,
    'Content-Disposition': `attachment; filename="${filename}"`,
    'X-Content-Type-Options': 'nosniff',
  });
  if (lengthHeader) headers.set('Content-Length', lengthHeader);

  return new Response(boundedStream, { status: 200, headers });
}

// Pure streaming ZIP (STORE method with data descriptors) written incrementally to a temp file
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function updateCrc32(crc: number, chunk: Uint8Array): number {
  let c = crc ^ 0xffffffff;
  for (let i = 0; i < chunk.length; i++) {
    c = (CRC32_TABLE[(c ^ (chunk[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipCentralEntry {
  nameBytes: Buffer;
  crc32: number;
  size: number;
  localHeaderOffset: number;
}

async function writeChunkedZipJob(job: ZipJobRecord, matches: RegisteredMatch[]): Promise<void> {
  job.status = 'running';
  const tempPath = path.join(os.tmpdir(), `playlistdrop-${job.jobId}.zip`);
  job.tempPath = tempPath;

  const usedNames = new Map<string, number>();
  const centralEntries: ZipCentralEntry[] = [];
  let offset = 0;
  let packaged = 0;

  let fh: fsp.FileHandle | null = null;
  try {
    fh = await fsp.open(tempPath, 'w');

    for (const match of matches) {
      const count = usedNames.get(match.filename) ?? 0;
      usedNames.set(match.filename, count + 1);
      const entryName =
        count === 0 ? match.filename : match.filename.replace(/(\.[^.]+)$/, `-${count}$1`);

      try {
        const resp = await fetch(match.downloadUrl, {
          redirect: 'follow',
          signal: AbortSignal.timeout(30_000),
          cache: 'no-store',
        });
        const mime =
          (resp.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
        if (!resp.ok || !resp.body || (mime !== 'audio/mpeg' && !mime.startsWith('audio/'))) {
          job.completed += 1;
          continue;
        }

        const nameBytes = Buffer.from(entryName, 'utf8');
        const localHeaderOffset = offset;

        const localHeader = Buffer.alloc(30);
        localHeader.writeUInt32LE(0x04034b50, 0);
        localHeader.writeUInt16LE(20, 4);
        localHeader.writeUInt16LE(0x0008, 6);
        localHeader.writeUInt16LE(0, 8);
        localHeader.writeUInt16LE(0, 10);
        localHeader.writeUInt16LE(0, 12);
        localHeader.writeUInt32LE(0, 14);
        localHeader.writeUInt32LE(0, 18);
        localHeader.writeUInt32LE(0, 22);
        localHeader.writeUInt16LE(nameBytes.length, 26);
        localHeader.writeUInt16LE(0, 28);

        await fh.write(localHeader);
        await fh.write(nameBytes);
        offset += localHeader.length + nameBytes.length;

        let crc = 0;
        let size = 0;
        const reader = resp.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (size + value.byteLength > MAX_DOWNLOAD_BYTES) {
            await reader.cancel();
            break;
          }
          crc = updateCrc32(crc, value);
          size += value.byteLength;
          await fh.write(value);
          offset += value.byteLength;
        }

        const descriptor = Buffer.alloc(16);
        descriptor.writeUInt32LE(0x08074b50, 0);
        descriptor.writeUInt32LE(crc >>> 0, 4);
        descriptor.writeUInt32LE(size >>> 0, 8);
        descriptor.writeUInt32LE(size >>> 0, 12);
        await fh.write(descriptor);
        offset += descriptor.length;

        centralEntries.push({ nameBytes, crc32: crc, size, localHeaderOffset });
        packaged += 1;
      } catch {
        // Skip failed track without aborting remaining tracks
      } finally {
        job.completed += 1;
      }
    }

    if (packaged === 0) {
      await fh.close();
      fh = null;
      await fsp.unlink(tempPath).catch(() => {});
      job.status = 'failed';
      job.error = 'Unable to download any of the selected audio tracks.';
      return;
    }

    const centralDirOffset = offset;
    let centralDirSize = 0;

    for (const entry of centralEntries) {
      const cdHeader = Buffer.alloc(46);
      cdHeader.writeUInt32LE(0x02014b50, 0);
      cdHeader.writeUInt16LE(20, 4);
      cdHeader.writeUInt16LE(20, 6);
      cdHeader.writeUInt16LE(0x0008, 8);
      cdHeader.writeUInt16LE(0, 10);
      cdHeader.writeUInt16LE(0, 12);
      cdHeader.writeUInt16LE(0, 14);
      cdHeader.writeUInt32LE(entry.crc32 >>> 0, 16);
      cdHeader.writeUInt32LE(entry.size >>> 0, 20);
      cdHeader.writeUInt32LE(entry.size >>> 0, 24);
      cdHeader.writeUInt16LE(entry.nameBytes.length, 28);
      cdHeader.writeUInt16LE(0, 30);
      cdHeader.writeUInt16LE(0, 32);
      cdHeader.writeUInt16LE(0, 34);
      cdHeader.writeUInt16LE(0, 36);
      cdHeader.writeUInt32LE(0, 38);
      cdHeader.writeUInt32LE(entry.localHeaderOffset >>> 0, 42);

      await fh.write(cdHeader);
      await fh.write(entry.nameBytes);
      centralDirSize += cdHeader.length + entry.nameBytes.length;
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(centralEntries.length, 8);
    eocd.writeUInt16LE(centralEntries.length, 10);
    eocd.writeUInt32LE(centralDirSize >>> 0, 12);
    eocd.writeUInt32LE(centralDirOffset >>> 0, 16);
    eocd.writeUInt16LE(0, 20);
    await fh.write(eocd);

    await fh.close();
    fh = null;
    job.status = 'done';
  } catch {
    if (fh) await fh.close().catch(() => {});
    await fsp.unlink(tempPath).catch(() => {});
    job.status = 'failed';
    job.error = 'ZIP archive creation failed. Please try again.';
  }
}

function purgeExpiredZipJobs(): void {
  const store = getStore();
  const now = Date.now();
  for (const [jobId, job] of store.zipJobs.entries()) {
    if (
      now - job.createdAt > ZIP_JOB_TTL_MS &&
      (job.status === 'done' || job.status === 'failed')
    ) {
      store.zipJobs.delete(jobId);
      if (job.tempPath) {
        void fsp.unlink(job.tempPath).catch(() => {});
      }
    }
  }
}

export function startLocalZipJob(trackIds: string[]): NextResponse {
  purgeExpiredRegistry();
  purgeExpiredZipJobs();

  const store = getStore();
  const uniqueIds = Array.from(new Set(trackIds));
  const matches: RegisteredMatch[] = [];
  for (const id of uniqueIds) {
    const entry = store.byTrackId.get(id);
    if (entry) matches.push(entry);
  }

  if (matches.length === 0) {
    return jsonError(
      400,
      'NO_MATCHED_TRACKS_FOUND',
      'None of the requested tracks are currently in the matched download registry. Please re-load the playlist and try again.'
    );
  }

  const jobId = crypto.randomUUID().replace(/-/g, '');
  const job: ZipJobRecord = {
    jobId,
    status: 'pending',
    completed: 0,
    total: matches.length,
    createdAt: Date.now(),
    tempPath: null,
    error: null,
  };
  store.zipJobs.set(jobId, job);

  void writeChunkedZipJob(job, matches);

  return NextResponse.json({ jobId }, { status: 202 });
}

export function getLocalZipJobStatus(jobId: string): NextResponse {
  purgeExpiredZipJobs();
  const store = getStore();
  const job = store.zipJobs.get(jobId);
  if (!job) {
    return jsonError(404, 'ZIP_JOB_NOT_FOUND', 'ZIP job not found or has expired.');
  }

  const payload: ZipJobStatusResponse = {
    status: job.status,
    completed: job.completed,
    total: job.total,
    downloadUrl: job.status === 'done' ? `/api/download/zip/${job.jobId}/file` : null,
    error: job.error,
  };
  return NextResponse.json(payload);
}

export async function streamLocalZipFile(jobId: string): Promise<Response> {
  const store = getStore();
  const job = store.zipJobs.get(jobId);
  if (!job) {
    return jsonError(404, 'ZIP_JOB_NOT_FOUND', 'ZIP job not found or has expired.');
  }
  if (job.status !== 'done' || !job.tempPath) {
    return jsonError(409, 'ZIP_JOB_NOT_READY', 'ZIP archive is not ready for download yet.');
  }

  let stat: fs.Stats;
  try {
    stat = await fsp.stat(job.tempPath);
  } catch {
    return jsonError(404, 'ZIP_JOB_NOT_FOUND', 'ZIP archive file has expired.');
  }

  const nodeStream = fs.createReadStream(job.tempPath, { highWaterMark: 65536 });
  const webStream = new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on('data', (chunk: string | Buffer) => {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        controller.enqueue(new Uint8Array(buf));
      });
      nodeStream.on('end', () => controller.close());
      nodeStream.on('error', (err) => controller.error(err));
    },
    cancel() {
      nodeStream.destroy();
    },
  });

  return new Response(webStream, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="playlistdrop-${jobId.slice(0, 8)}.zip"`,
      'Content-Length': String(stat.size),
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
