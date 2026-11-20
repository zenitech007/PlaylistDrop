export type PlaylistSource = 'deezer' | 'spotify' | 'youtube';

export interface Track {
  id: string;
  name: string;
  artist: string;
  album: string;
  durationMs: number;
  artworkUrl: string | null;
}

export interface PlaylistData {
  id: string;
  name: string;
  owner: string | null;
  artworkUrl: string | null;
  tracks: Track[];
  source: PlaylistSource;
  partial?: boolean;
}

export interface MatchResult {
  trackId: string;
  source: string;
  downloadUrl: string;
  license: string;
  bitrateKbps: number;
  score: number;
}

export interface MatchResponse {
  matches: MatchResult[];
}

export interface EnrichedTrack extends Track {
  match: MatchResult | null;
}

export interface ZipJobCreatedResponse {
  jobId: string;
}

export type ZipJobStatus = 'pending' | 'running' | 'done' | 'failed';

export interface ZipJobStatusResponse {
  status: ZipJobStatus;
  completed: number;
  total: number;
  downloadUrl: string | null;
  error: string | null;
}

export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
  };
}

export type LoadingPhase = 'idle' | 'resolving' | 'matching' | 'ready' | 'error';

export type TrackFilter = 'all' | 'matched' | 'unmatched';
