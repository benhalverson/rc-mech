import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
		exclude: ['src/driving-analysis/gpu-lease-coordinator.test.ts'],
		coverage: {
			provider: 'v8',
			include: ['src/**/*.ts'],
			exclude: [
				'src/**/*.test.ts',
				'src/testing/**',
				'src/driving-analysis/gpu-lease-coordinator.ts',
			],
			reporter: ['text', 'json-summary'],
			thresholds: {
				statements: 100,
				branches: 100,
				functions: 100,
				lines: 100,
			},
		},
	},
	resolve: {
		alias: {
			'cloudflare:workers': path.resolve(
				'src/testing/cloudflare-workers-stub.ts',
			),
		},
	},
});
