import { defineConfig } from 'vitest/config';

export default defineConfig({
	root: '.',
	test: { include: ['tools/angular-architecture-check.test.ts'] },
});
