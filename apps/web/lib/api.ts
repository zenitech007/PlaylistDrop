import { triggerBlobDownload } from './export';
import { slugifyFilename } from './format';
import type {
  ApiErrorEnvelope,
  MatchResponse,
  PlaylistData,
  Track,
  ZipJobCreatedResponse,
  ZipJobStatusResponse,
} from './types';

export class PlaylistDropApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly retryAfterSeconds: number | null;

  constructor(
    status: number,
    code: string,
    message: string,
    retryAfterSeconds: number | null = null
  ) {
    super(message);
    this.name = 'PlaylistDropApiError';
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function normalizeBaseUrl(apiBaseUrl: string): string {
  return apiBaseUrl.replace(/\/+$/, '');
}

function parseRetryAfter(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const parsed = Number.parseInt(headerValue, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isErrorEnvelope(value: unknown): value is ApiErrorEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.error !== 'object' || candidate.error === null) return false;
  const err = candidate.error as Record<string, unknown>;
  return typeof err.code === 'string' && typeof err.message === 'string';
}

async function parseApiError(response: Response): Promise<PlaylistDropApiError> {
  const retryAfter = parseRetryAfter(response.headers.get('Retry-After'));
  try {
    const data: unknown = await response.json();
    if (isErrorEnvelope(data)) {
      return new PlaylistDropApiError(
        response.status,
        data.error.code,
        data.error.message,
        retryAfter
      );
    }
  } catch {
    // Non-JSON error body; fall back to HTTP status text
  }

  const fallbackMessage =
    response.status === 429 || response.status === 503
      ? 'Too many requests right now. Please wait a moment and try again.'
      : response.status === 404
        ? 'The requested resource could not be found.'
        : 'Request failed. Please try again.';

  return new PlaylistDropApiError(
    response.status,
    `HTTP_${response.status}`,
    fallbackMessage,
    retryAfter
  );
}

async function requestJson<T>(url: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new PlaylistDropApiError(
      0,
      'NETWORK_ERROR',
      'Unable to reach the PlaylistDrop server. Check your connection and try again.'
    );
  }

  if (!response.ok) {
    throw await parseApiError(response);
  }

  return (await response.json()) as T;
}

export async function resolvePlaylist(url: string, apiBaseUrl: string): Promise<PlaylistData> {
  const endpoint = `${normalizeBaseUrl(apiBaseUrl)}/api/resolve`;
  return requestJson<PlaylistData>(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
}

export async function matchTracks(tracks: Track[], apiBaseUrl: string): Promise<MatchResponse> {
  const endpoint = `${normalizeBaseUrl(apiBaseUrl)}/api/match`;
  return requestJson<MatchResponse>(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tracks }),
  });
}

export async function downloadSingleTrack(
  downloadUrl: string,
  artist: string,
  title: string,
  apiBaseUrl: string
): Promise<void> {
  const endpoint = `${normalizeBaseUrl(apiBaseUrl)}/api/download`;
  const desiredFilename = slugifyFilename(`${artist}-${title}`, 'mp3');

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ downloadUrl, filename: desiredFilename }),
    });
  } catch {
    throw new PlaylistDropApiError(0, 'NETWORK_ERROR', 'Network error while downloading track.');
  }

  if (!response.ok) {
    throw await parseApiError(response);
  }

  const blob = await response.blob();
  const disposition = response.headers.get('Content-Disposition');
  const filenameMatch = disposition?.match(/filename="([^"]+)"/i);
  const resolvedName = filenameMatch?.[1] ?? desiredFilename;
  triggerBlobDownload(blob, resolvedName);
}

export async function startZipJob(
  trackIds: string[],
  apiBaseUrl: string
): Promise<ZipJobCreatedResponse> {
  const endpoint = `${normalizeBaseUrl(apiBaseUrl)}/api/download/zip`;
  return requestJson<ZipJobCreatedResponse>(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trackIds }),
  });
}

export async function getZipJobStatus(
  jobId: string,
  apiBaseUrl: string
): Promise<ZipJobStatusResponse> {
  const endpoint = `${normalizeBaseUrl(apiBaseUrl)}/api/download/zip/${encodeURIComponent(jobId)}/status`;
  return requestJson<ZipJobStatusResponse>(endpoint, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
}

export function resolveAbsoluteDownloadUrl(
  relativeOrAbsoluteUrl: string,
  apiBaseUrl: string
): string {
  if (/^https?:\/\//i.test(relativeOrAbsoluteUrl)) {
    return relativeOrAbsoluteUrl;
  }
  const base = normalizeBaseUrl(apiBaseUrl);
  const path = relativeOrAbsoluteUrl.startsWith('/')
    ? relativeOrAbsoluteUrl
    : `/${relativeOrAbsoluteUrl}`;
  return `${base}${path}`;
}

export function triggerFileUrlDownload(url: string, filename: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener noreferrer';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
}
