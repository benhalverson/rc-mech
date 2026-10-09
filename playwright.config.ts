import { defineConfig } from '@playwright/test';

const workerPort = Number(process.env['RC_MECH_BROWSER_WORKER_PORT'] ?? 8787);
const clientPort = Number(process.env['RC_MECH_BROWSER_CLIENT_PORT'] ?? 4201);

export default defineConfig({
	testDir: './tests/browser',
	testMatch: '**/*.spec.ts',
	timeout: 20_000,
	workers: 1,
	use: {
		actionTimeout: 5_000,
		baseURL: `http://127.0.0.1:${clientPort}`,
		serviceWorkers: 'block',
		trace: 'retain-on-failure',
	},
	webServer: [
		{
			command: 'bash scripts/browser-worker.sh',
			url: `http://127.0.0.1:${workerPort}/api/v1/health`,
			reuseExistingServer: false,
		},
		{
			command: 'bash scripts/browser-client.sh',
			url: `http://127.0.0.1:${clientPort}/api/v1/health`,
			reuseExistingServer: false,
		},
	],
});
