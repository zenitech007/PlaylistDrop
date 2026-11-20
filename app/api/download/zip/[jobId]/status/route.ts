import { checkRateLimit, getLocalZipJobStatus, maybeProxyToFastApi } from '@/lib/server/backend';
import { NextRequest } from 'next/server';

export async function GET(request: NextRequest, context: { params: Promise<{ jobId: string }> }) {
  const rateLimited = checkRateLimit(request);
  if (rateLimited) return rateLimited;

  const { jobId } = await context.params;
  const proxied = await maybeProxyToFastApi(
    request,
    `/api/download/zip/${encodeURIComponent(jobId)}/status`
  );
  if (proxied) return proxied;

  return getLocalZipJobStatus(jobId);
}
