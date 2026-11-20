import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typescript: {
    ignoreBuildErrors: false,
  },
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '**.dzcdn.net', port: '', pathname: '/**' },
      { protocol: 'https', hostname: '**.scdn.co', port: '', pathname: '/**' },
      { protocol: 'https', hostname: '**.spotifycdn.com', port: '', pathname: '/**' },
      { protocol: 'https', hostname: '**.ytimg.com', port: '', pathname: '/**' },
      { protocol: 'https', hostname: '**.ggpht.com', port: '', pathname: '/**' },
      { protocol: 'https', hostname: '**.jamendo.com', port: '', pathname: '/**' },
    ],
  },
  output: 'standalone',
  transpilePackages: ['motion'],
};

export default nextConfig;
