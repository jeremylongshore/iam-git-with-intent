import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/__tests__/*.test.ts'],
    // RSA key generation in the report-signing suite exceeds the 5s default
    // when turbo runs every package's tests in parallel on a 2-vCPU runner.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
