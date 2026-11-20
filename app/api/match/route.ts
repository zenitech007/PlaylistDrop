import type { Track } from '@/apps/web/lib/types';
import {
  checkRateLimit,
  jsonError,
  matchTracksCatalog,
  maybeProxyToFastApi,
} from '@/lib/server/backend';
import { NextRequest, NextResponse } from 'next/server';

function isValidTrack(value: unknown): value is Track {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.name === 'string' &&
    typeof r.artist === 'string' &&
    typeof r.album === 'string' &&
    typeof r.durationMs === 'number'
  );
}

export async function POST(request: NextRequest) {
  const rateLimited = checkRateLimit(request);
  if (rateLimited) return rateLimited;

  const proxied = await maybeProxyToFastApi(request, '/api/match');
  if (proxied) return proxied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(422, 'VALIDATION_ERROR', 'Request body must be valid JSON.');
  }

  const rawTracks =
    typeof body === 'object' &&
    body !== null &&
    Array.isArray((body as Record<string, unknown>).tracks)
      ? ((body as Record<string, unknown>).tracks as unknown[])
      : null;

  if (!rawTracks || rawTracks.length === 0 || rawTracks.length > 200) {
    return jsonError(422, 'VALIDATION_ERROR', 'Provide between 1 and 200 tracks to match.');
  }

  const tracks = rawTracks.filter(isValidTrack);
  if (tracks.length === 0) {
    return jsonError(422, 'VALIDATION_ERROR', 'Invalid track entries provided.');
  }

  const matches = await matchTracksCatalog(tracks);
  return NextResponse.json({ matches });
}
