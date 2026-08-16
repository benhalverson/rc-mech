import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [
		cloudflareTest({
			remoteBindings: false,
			wrangler: { configPath: './wrangler.jsonc', environment: 'local' },
		}),
	],
	test: {
		include: ['src/driving-analysis/gpu-lease-coordinator.test.ts'],
		coverage: {
			provider: 'v8',
			include: ['src/driving-analysis/gpu-lease-coordinator.ts'],
			thresholds: {
				statements: 100,
				branches: 100,
				functions: 100,
				lines: 100,
			},
		},
	},
});
