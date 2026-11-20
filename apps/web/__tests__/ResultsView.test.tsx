import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResultsView } from '../components/ResultsView';
import type { EnrichedTrack, PlaylistData } from '../lib/types';

vi.mock('next/image', () => ({
  default: function MockImage(props: {
    src: string;
    alt: string;
    width?: number;
    height?: number;
    className?: string;
  }) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={props.src} alt={props.alt} className={props.className} />;
  },
}));

const SAMPLE_TRACKS: EnrichedTrack[] = [
  {
    id: 'youtube:vid-1',
    name: 'Solar Drift',
    artist: 'Lumen Echo',
    album: 'Open Horizons',
    durationMs: 204000,
    artworkUrl: null,
    match: {
      trackId: 'youtube:vid-1',
      source: 'jamendo',
      downloadUrl: 'https://mp3d.jamendo.com/download/track/101/mp32/',
      license: 'CC BY 3.0',
      bitrateKbps: 192,
      score: 1.0,
    },
  },
  {
    id: 'youtube:vid-2',
    name: 'Quiet Harbor',
    artist: 'Maren Sol',
    album: 'Tidal Notes',
    durationMs: 185000,
    artworkUrl: null,
    match: {
      trackId: 'youtube:vid-2',
      source: 'jamendo',
      downloadUrl: 'https://mp3d.jamendo.com/download/track/102/mp32/',
      license: 'CC BY-SA 4.0',
      bitrateKbps: 192,
      score: 0.92,
    },
  },
  {
    id: 'youtube:vid-3',
    name: 'Commercial Single',
    artist: 'Major Label Artist',
    album: 'Studio LP',
    durationMs: 241000,
    artworkUrl: null,
    match: null,
  },
];

const SAMPLE_PLAYLIST: PlaylistData = {
  id: 'PL1234567890abcdef',
  name: 'Late Night Creative Commons',
  owner: 'Open Audio Archive',
  artworkUrl: null,
  tracks: SAMPLE_TRACKS,
  source: 'youtube',
  partial: true,
};

describe('ResultsView', () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:mock-object-url');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });

  afterEach(() => {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    vi.restoreAllMocks();
  });

  it('renders tracks, dismissible partial quota banner, checkboxes, ZIP polling, single download, and export', async () => {
    const user = userEvent.setup();
    let statusPollCount = 0;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url.endsWith('/api/download/zip') && init?.method === 'POST') {
        return new Response(JSON.stringify({ jobId: 'job-abc123' }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.endsWith('/api/download/zip/job-abc123/status')) {
        statusPollCount += 1;
        if (statusPollCount === 1) {
          return new Response(
            JSON.stringify({
              status: 'running',
              completed: 1,
              total: 2,
              downloadUrl: null,
              error: null,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(
          JSON.stringify({
            status: 'done',
            completed: 2,
            total: 2,
            downloadUrl: '/api/download/zip/job-abc123/file',
            error: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.endsWith('/api/download') && init?.method === 'POST') {
        return new Response(new Blob(['ID3MOCK'], { type: 'audio/mpeg' }), {
          status: 200,
          headers: {
            'Content-Type': 'audio/mpeg',
            'Content-Disposition': 'attachment; filename="lumen-echo-solar-drift.mp3"',
          },
        });
      }

      return new Response(
        JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Unexpected URL' } }),
        { status: 404 }
      );
    });

    vi.stubGlobal('fetch', fetchMock);

    render(
      <ResultsView
        playlist={SAMPLE_PLAYLIST}
        tracks={SAMPLE_TRACKS}
        apiBaseUrl="http://localhost:8000"
        pollIntervalMs={25}
        onLoadAnother={vi.fn()}
      />
    );

    // Displays playlist name, partial quota warning, and track metadata
    expect(screen.getByText('Late Night Creative Commons')).toBeInTheDocument();
    expect(screen.getByText(/Some tracks were skipped due to API quota/i)).toBeInTheDocument();
    expect(screen.getByText('Solar Drift')).toBeInTheDocument();
    expect(screen.getByText('Quiet Harbor')).toBeInTheDocument();
    expect(screen.getByText('Commercial Single')).toBeInTheDocument();

    // Dismiss partial quota warning banner
    await user.click(screen.getByRole('button', { name: /Dismiss quota warning/i }));
    expect(
      screen.queryByText(/Some tracks were skipped due to API quota/i)
    ).not.toBeInTheDocument();

    // Checkboxes: matched checked by default, unmatched disabled
    const track1Checkbox = screen.getByLabelText(
      'Select Solar Drift by Lumen Echo for ZIP download'
    );
    const track2Checkbox = screen.getByLabelText(
      'Select Quiet Harbor by Maren Sol for ZIP download'
    );
    const track3Checkbox = screen.getByLabelText(
      'Commercial Single by Major Label Artist is not available for download'
    );

    expect(track1Checkbox).toBeChecked();
    expect(track2Checkbox).toBeChecked();
    expect(track3Checkbox).toBeDisabled();
    expect(screen.getByRole('button', { name: /Download Selected \(2\)/i })).toBeEnabled();

    // Trigger ZIP job and verify polling transitions to done
    await user.click(screen.getByRole('button', { name: /Download Selected \(2\)/i }));

    await waitFor(() => {
      expect(screen.getByText(/ZIP archive ready/i)).toBeInTheDocument();
    });

    // Verify individual track download still works after ZIP completes
    await user.click(screen.getByRole('button', { name: 'Download Solar Drift by Lumen Echo' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:8000/api/download',
        expect.objectContaining({ method: 'POST' })
      );
    });

    // Export CSV & JSON buttons work cleanly
    await user.click(screen.getByRole('button', { name: /Export CSV/i }));
    await user.click(screen.getByRole('button', { name: /Export JSON/i }));
    expect(URL.createObjectURL).toHaveBeenCalled();
  });
});
