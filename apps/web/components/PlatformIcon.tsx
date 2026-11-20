import { AudioWaveform, Disc3, PlaySquare } from 'lucide-react';
import type { PlaylistSource } from '../lib/types';

interface PlatformIconProps {
  source: PlaylistSource;
  className?: string;
}

export function PlatformIcon({ source, className = 'h-4 w-4' }: PlatformIconProps) {
  if (source === 'spotify') {
    return (
      <AudioWaveform aria-hidden="true" className={`${className} text-emerald-400 shrink-0`} />
    );
  }
  if (source === 'deezer') {
    return <Disc3 aria-hidden="true" className={`${className} text-violet-400 shrink-0`} />;
  }
  return <PlaySquare aria-hidden="true" className={`${className} text-rose-400 shrink-0`} />;
}
