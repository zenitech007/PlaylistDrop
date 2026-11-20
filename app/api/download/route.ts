import {
  checkRateLimit,
  jsonError,
  maybeProxyToFastApi,
  streamSingleTrackDownload,
} from '@/lib/server/backend';
import { NextRequest } from 'next/server';

export async function POST(request: NextRequest) {
  const rateLimited = checkRateLimit(request);
  if (rateLimited) return rateLimited;

  const proxied = await maybeProxyToFastApi(request, '/api/download');
  if (proxied) return proxied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(422, 'VALIDATION_ERROR', 'Request body must be valid JSON.');
  }

  const rec = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const downloadUrl = typeof rec.downloadUrl === 'string' ? rec.downloadUrl : '';
  const filename = typeof rec.filename === 'string' ? rec.filename : undefined;

  if (!downloadUrl) {
    return jsonError(422, 'VALIDATION_ERROR', 'downloadUrl is required.');
  }

  return streamSingleTrackDownload(downloadUrl, filename);
}
