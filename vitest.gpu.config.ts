import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: './wrangler.jsonc', environment: 'local' },
		}),
	],
	test: {
		include: ['src/driving-analysis/gpu-lease-coordinator.test.ts'],
		coverage: {
			provider: 'istanbul',
			include: ['src/driving-analysis/gpu-lease-coordinator.ts'],
			thresholds: {
				statements: 80,
				branches: 55,
				functions: 90,
				lines: 80,
			},
		},
	},
});
