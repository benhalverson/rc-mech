import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: './tests/browser',
	testMatch: '**/*.spec.ts',
	timeout: 30_000,
	use: { baseURL: 'http://127.0.0.1:4201', trace: 'retain-on-failure' },
	webServer: [
		{
			command: 'bash scripts/browser-worker.sh',
			url: 'http://127.0.0.1:8787/api/v1/health',
			reuseExistingServer: false,
		},
		{
			command:
				'NG_PERSISTENT_BUILD_CACHE=0 pnpm --dir client exec ng serve --host 127.0.0.1 --port 4201',
			url: 'http://127.0.0.1:4201/sign-in',
			reuseExistingServer: false,
		},
	],
});
