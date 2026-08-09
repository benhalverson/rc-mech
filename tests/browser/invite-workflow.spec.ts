import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { getViolations, injectAxe } from 'axe-playwright';

const baseURL = 'http://127.0.0.1:4201';

const builtRouteChunk = (routeExport: string): string => {
	const index = readFileSync('public/index.html', 'utf8');
	const mainName = index.match(/<script src="(main-[^"]+\.js)"/)?.[1];
	if (!mainName) throw new Error('The browser build has no main bundle.');
	const main = readFileSync(`public/${mainName}`, 'utf8');
	const marker = `({${routeExport}:`;
	const markerIndex = main.indexOf(marker);
	const importPrefix = 'import(`./';
	const chunkStart = main.lastIndexOf(importPrefix, markerIndex);
	const chunkEnd = main.indexOf('`)', chunkStart + importPrefix.length);
	if (markerIndex < 0 || chunkStart < 0 || chunkEnd < 0)
		throw new Error(`The browser build has no ${routeExport} lazy chunk.`);
	return main.slice(chunkStart + importPrefix.length, chunkEnd);
};

const scan = async (page: Page) => {
	await injectAxe(page);
	return getViolations(page);
};

const verify = async (page: Page, returnTo: string) => {
	await page.goto(
		`/api/auth/magic-link/verify?token=local-test-token&callbackURL=${encodeURIComponent(returnTo)}`,
	);
};

const expectSingleShell = async (page: Page) => {
	await expect(page.locator('.workspace-shell')).toHaveCount(1);
	await expect(
		page.getByRole('navigation', { name: 'Primary workspace' }),
	).toHaveCount(1);
	await expect(page.locator('main')).toHaveCount(1);
};

const seedOwnerInvites = (workerIdentity: string) => {
	for (const code of ['OWNER-SHELL', 'OWNER-INVITES']) {
		execFileSync('pnpm', [
			'exec',
			'tsx',
			'scripts/invite-cli.ts',
			'--url',
			'http://127.0.0.1:8787',
			'--owner-email',
			'owner@example.com',
			'--code',
			code,
			'--reuse-existing',
			'--client-id',
			`invite-seed-${workerIdentity}-${code}`,
		]);
	}
};

test.beforeAll(({ browserName }, workerInfo) =>
	seedOwnerInvites(`${browserName}-${workerInfo.workerIndex}`),
);

let ownerAuthentication = 0;

const authenticateOwner = async (page: Page, returnTo = '/garage') => {
	ownerAuthentication += 1;
	await page.setExtraHTTPHeaders({
		'CF-Connecting-IP': `invite-owner-${ownerAuthentication}`,
	});
	await page.goto('/sign-in');
	await page.getByLabel('Email address').fill('owner@example.com');
	await page.getByRole('button', { name: 'Send magic link' }).click();
	await expect(page.getByRole('status')).toContainText('link is on its way');
	await verify(page, returnTo);
	await expectSingleShell(page);
};

const createCar = async (page: Page, name: string) => {
	const response = await page.request.post('/api/v1/cars', {
		data: { name, make: 'Team Associated', model: 'B7' },
	});
	expect(response.ok()).toBe(true);
	const body = (await response.json()) as { car: { id: string } };
	return body.car;
};

const expectAccessibleCarRoutes = async (
	page: Page,
	carId: string,
	sections: readonly string[],
) => {
	for (const section of sections) {
		await page.goto(`/garage/${carId}/${section}`);
		await expect(page).toHaveURL(new RegExp(`/garage/${carId}/${section}$`));
		await expect(page.locator('[data-route-focus]')).toBeFocused();
		await expect(page.locator('.route-announcement')).toContainText(
			'Opened Garage',
		);
		expect(await scan(page)).toEqual([]);
	}
};

const registerUser = async (page: Page, email: string, inviteCode: string) => {
	await page.goto('/sign-in');
	await page
		.getByRole('button', { name: 'Have an invite code? Register' })
		.click();
	await page.getByLabel('Email address').fill(email);
	await page.getByLabel('Invite code').fill(inviteCode);
	await page.getByRole('button', { name: 'Start registration' }).click();
	await expect(page.getByRole('status')).toContainText(
		'registration link is on its way',
	);
	await verify(page, '/garage');
	await expect(page.getByText('The garage is waiting')).toBeVisible();
	await expectSingleShell(page);
};

test('protects private routes and keeps primary owner navigation accessible', async ({
	page,
}) => {
	await page.goto('/garage/private-car/photos');
	await expect(page).toHaveURL(
		/sign-in\?returnTo=%2Fgarage%2Fprivate-car%2Fphotos/,
	);
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
	expect(await scan(page)).toEqual([]);

	await authenticateOwner(page, '/settings');
	await expect(
		page.getByRole('heading', { name: 'Your invite codes' }),
	).toBeVisible();
	for (const destination of [
		['Garage', '/garage'],
		['Maintenance', '/maintenance'],
		['Settings', '/settings'],
	] as const) {
		await page
			.getByRole('navigation', { name: 'Primary workspace' })
			.getByRole('link', { name: destination[0] })
			.click();
		await expect(page).toHaveURL(new RegExp(`${destination[1]}$`));
		await expectSingleShell(page);
		expect(await scan(page)).toEqual([]);
	}
	await expect(page.getByText('OWNER-SHELL')).toBeVisible();
});

test('shows and recovers from an explicit lazy-route load failure', async ({
	page,
}) => {
	await authenticateOwner(page);
	const maintenanceChunk = builtRouteChunk('MAINTENANCE_ROUTES');
	const chunkPattern = `**/${maintenanceChunk}`;
	let failedRequests = 0;
	await page.route(chunkPattern, async (route) => {
		if (failedRequests === 0) {
			failedRequests += 1;
			await route.fulfill({
				status: 503,
				contentType: 'text/javascript',
				body: 'Route chunk temporarily unavailable.',
			});
			return;
		}
		await route.continue();
	});

	await page
		.getByRole('navigation', { name: 'Primary workspace' })
		.getByRole('link', { name: 'Maintenance' })
		.click();
	await expect(page.getByRole('alert')).toContainText(
		'This page could not be loaded. Try again.',
	);
	await page.unroute(chunkPattern);
	await page.getByRole('button', { name: 'Try again' }).click();
	await expect(
		page.getByRole('heading', { name: 'Maintenance cockpit' }),
	).toBeFocused();
	expect(failedRequests).toBe(1);
});

test('keeps overview, build, and setup car routes accessible', async ({
	page,
}) => {
	await authenticateOwner(page);
	const car = await createCar(page, 'Accessible route buggy A');
	await expectAccessibleCarRoutes(page, car.id, [
		'overview',
		'build',
		'setups',
	]);
});

test('keeps photo, drive-session, and voice car routes accessible', async ({
	page,
}) => {
	await authenticateOwner(page);
	const car = await createCar(page, 'Accessible route buggy B');
	await expectAccessibleCarRoutes(page, car.id, [
		'photos',
		'drive-sessions',
		'voice',
	]);
});

test('preserves the legacy route and drive-session browser workflow', async ({
	page,
}) => {
	await authenticateOwner(page);
	const car = await createCar(page, 'Drive-session browser buggy');

	await page.goto(
		`/garage/${car.id}/runs?source=legacy-bookmark&filter=archived#session-2`,
	);
	await expect(page).toHaveURL(
		new RegExp(
			`/garage/${car.id}/drive-sessions\\?source=legacy-bookmark&filter=archived#session-2$`,
		),
	);
	await expect(
		page.getByRole('heading', { name: 'Drive sessions', exact: true }),
	).toBeVisible();
	expect(await scan(page)).toEqual([]);

	await page
		.getByRole('button', { name: 'Record the first drive session' })
		.click();
	await expect(
		page.getByRole('heading', { name: 'Record a drive session' }),
	).toBeVisible();
	expect(await scan(page)).toEqual([]);
	await page.getByLabel('Conditions').fill('Dry clay');
	await page.getByLabel('Notes').fill('Created through the browser workflow.');
	await page.getByRole('button', { name: 'Save session' }).click();
	await expect(page.locator('.session-log > p[role="status"]')).toContainText(
		'Drive session recorded.',
	);
	await expect(page.getByText('Dry clay')).toBeVisible();
	expect(await scan(page)).toEqual([]);

	await page.getByRole('button', { name: 'Edit' }).click();
	await page.getByLabel('Notes').fill('Updated through the browser workflow.');
	await page.getByRole('button', { name: 'Save session' }).click();
	await expect(page.locator('.session-log > p[role="status"]')).toContainText(
		'Drive session updated.',
	);
	await expect(
		page.getByText('Updated through the browser workflow.'),
	).toBeVisible();
	await page.getByRole('button', { name: 'Archive' }).click();
	await expect(page.getByRole('button', { name: 'Archive' })).toHaveCount(0);
	await expect(page.getByText('0 recorded')).toBeVisible();
	let archivedSession = page.locator('.session-row').filter({
		hasText: 'Updated through the browser workflow.',
	});
	await expect(archivedSession).toBeVisible();
	await expect(archivedSession.getByRole('button')).toHaveCount(0);
	expect(await scan(page)).toEqual([]);

	await page.reload();
	await expect(
		page.getByRole('heading', { name: 'Drive sessions', exact: true }),
	).toBeVisible();
	archivedSession = page.locator('.session-row').filter({
		hasText: 'Updated through the browser workflow.',
	});
	await expect(archivedSession).toBeVisible();
	await expect(archivedSession.getByRole('button')).toHaveCount(0);
	await expect(page.getByText('0 recorded')).toBeVisible();
});

test('registers invited users and keeps invite management isolated', async ({
	page,
	browser,
}) => {
	await authenticateOwner(page, '/settings');
	await expect(page.getByText('OWNER-INVITES')).toBeVisible();

	const userA = await browser.newContext({
		baseURL,
		permissions: ['clipboard-read', 'clipboard-write'],
	});
	const userPage = await userA.newPage();
	await registerUser(userPage, 'user-a@example.com', 'OWNER-INVITES');
	expect(await scan(userPage)).toEqual([]);

	await userPage.goto('/settings');
	await expect(
		userPage.getByRole('heading', { name: 'Your invite codes' }),
	).toBeVisible();
	await userPage.getByLabel('New invite code').fill('USER-A1');
	await userPage.getByRole('button', { name: 'Create code' }).click();
	await expect(userPage.getByText('USER-A1')).toBeVisible();
	await userPage.getByRole('button', { name: 'Copy' }).first().click();
	await expect(userPage.getByText('Copied USER-A1.')).toBeVisible();

	const userB = await browser.newContext({ baseURL });
	const userBPage = await userB.newPage();
	await registerUser(userBPage, 'user-b@example.com', 'USER-A1');
	await userBPage.goto('/settings');
	await expect(userBPage.getByText('USER-A1')).toHaveCount(0);
	await expectSingleShell(userBPage);
	expect(await scan(userBPage)).toEqual([]);

	await userA.close();
	await userB.close();
});
