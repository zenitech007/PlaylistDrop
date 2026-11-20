import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: [
      'apps/web/__tests__/**/*.test.tsx',
      'apps/web/__tests__/**/*.test.ts',
      'firestore.rules.test.ts',
    ],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
      '@web': path.resolve(__dirname, './apps/web'),
    },
  },
});
