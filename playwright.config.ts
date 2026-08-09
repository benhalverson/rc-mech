import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: './tests/browser',
	testMatch: '**/*.spec.ts',
	timeout: 20_000,
	workers: 1,
	use: {
		actionTimeout: 5_000,
		baseURL: 'http://127.0.0.1:4201',
		trace: 'retain-on-failure',
	},
	webServer: [
		{
			command: 'bash scripts/browser-worker.sh',
			url: 'http://127.0.0.1:8787/api/v1/health',
			reuseExistingServer: false,
		},
		{
			command: 'bash scripts/browser-client.sh',
			url: 'http://127.0.0.1:4201/api/v1/health',
			reuseExistingServer: false,
		},
	],
});
