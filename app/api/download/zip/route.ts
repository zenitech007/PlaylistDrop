import {
  checkRateLimit,
  jsonError,
  maybeProxyToFastApi,
  startLocalZipJob,
} from '@/lib/server/backend';
import { NextRequest } from 'next/server';

export async function POST(request: NextRequest) {
  const rateLimited = checkRateLimit(request);
  if (rateLimited) return rateLimited;

  const proxied = await maybeProxyToFastApi(request, '/api/download/zip');
  if (proxied) return proxied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(422, 'VALIDATION_ERROR', 'Request body must be valid JSON.');
  }

  const rawIds =
    typeof body === 'object' &&
    body !== null &&
    Array.isArray((body as Record<string, unknown>).trackIds)
      ? ((body as Record<string, unknown>).trackIds as unknown[])
      : null;

  const trackIds =
    rawIds?.filter((id): id is string => typeof id === 'string' && id.trim().length > 0) ?? [];
  if (trackIds.length === 0 || trackIds.length > 200) {
    return jsonError(422, 'VALIDATION_ERROR', 'Provide between 1 and 200 trackIds.');
  }

  return startLocalZipJob(trackIds);
}
