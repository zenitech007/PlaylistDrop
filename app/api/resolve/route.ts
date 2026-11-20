import {
  checkRateLimit,
  jsonError,
  maybeProxyToFastApi,
  resolveMultiPlatformPlaylist,
} from '@/lib/server/backend';
import { NextRequest } from 'next/server';

export async function POST(request: NextRequest) {
  const rateLimited = checkRateLimit(request);
  if (rateLimited) return rateLimited;

  const proxied = await maybeProxyToFastApi(request, '/api/resolve');
  if (proxied) return proxied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonError(400, 'INVALID_JSON', 'Request body must be valid JSON.');
  }

  const url =
    typeof body === 'object' &&
    body !== null &&
    typeof (body as Record<string, unknown>).url === 'string'
      ? ((body as Record<string, unknown>).url as string)
      : '';

  return resolveMultiPlatformPlaylist(url);
}
