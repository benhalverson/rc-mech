import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { getViolations, injectAxe } from 'axe-playwright';

test.use({ serviceWorkers: 'allow' });

let authentication = 0;

const authenticateOwner = async (page: Page): Promise<void> => {
	authentication += 1;
	const clientIp = `offline-garage-owner-${authentication}`;
	await page.setExtraHTTPHeaders({ 'CF-Connecting-IP': clientIp });
	const request = await page.request.post('/api/auth/sign-in/magic-link', {
		headers: { 'CF-Connecting-IP': clientIp },
		data: { email: 'owner@example.com', callbackURL: '/garage' },
	});
	expect(request.ok()).toBe(true);
	const verification = await page.request.get(
		'/api/auth/magic-link/verify?token=local-test-token&callbackURL=%2Fgarage',
		{ headers: { 'CF-Connecting-IP': clientIp }, maxRedirects: 0 },
	);
	expect([302, 303]).toContain(verification.status());
};

const expectAxeClean = async (page: Page): Promise<void> => {
	await injectAxe(page);
	expect(await getViolations(page)).toEqual([]);
};

const reopenOffline = async (
	context: BrowserContext,
	page: Page,
	path = '/garage',
): Promise<Page> => {
	await page.close();
	await context.setOffline(true);
	const reopened = await context.newPage();
	await reopened.goto(path);
	return reopened;
};

test('reopens the prepared User-scoped Garage after the page closes offline', async ({
	context,
	page,
}) => {
	await authenticateOwner(page);
	const created = await page.request.post('/api/v1/cars', {
		data: {
			name: 'Offline B7 buggy',
			make: 'Team Associated',
			model: 'B7',
		},
	});
	expect(created.ok()).toBe(true);

	await page.goto('/garage');
	await expect(page.locator('[data-offline-status="ready"]')).toContainText(
		'Offline ready',
	);
	await expect(
		page.getByRole('heading', { name: 'The garage', exact: true }),
	).toBeFocused();
	expect(
		await page.evaluate(
			() =>
				Boolean(navigator.serviceWorker.controller) && 'caches' in globalThis,
		),
	).toBe(true);

	await context.setOffline(true);
	await page.getByRole('button', { name: 'Add a car' }).click();
	await page.getByLabel('Name').fill('Offline-created short course truck');
	await page.getByLabel('Notes').fill('Saved between heats without reception');
	await page.getByRole('button', { name: 'Save car' }).click();
	await expect(page).toHaveURL(/\/garage\/[^/]+\/overview$/);
	await expect(page.locator('[data-offline-status="offline"]')).toContainText(
		'Offline—changes will be saved here and sync when connection returns.',
	);
	await expect(page.getByText('Pending sync', { exact: false })).toBeVisible();
	await page.getByRole('button', { name: 'Edit details' }).click();
	const editForm = page.locator('.car-form');
	await editForm.getByLabel('Name').fill('Offline-created SCT');
	await editForm.getByLabel('Notes').fill('Edited offline between heats');
	await editForm.getByRole('button', { name: 'Save car' }).click();
	await page.getByRole('button', { name: 'Archive car' }).click();
	await expect(page.getByRole('button', { name: 'Restore car' })).toBeVisible();
	await page.getByRole('button', { name: 'Restore car' }).click();
	await expect(page.getByRole('button', { name: 'Archive car' })).toBeVisible();

	const reopened = await reopenOffline(context, page);
	await expect(
		reopened.locator('[data-offline-status="offline"]'),
	).toContainText('Offline—changes will be saved here');
	await expect(
		reopened.getByRole('link', { name: /Offline B7 buggy/ }),
	).toBeVisible();
	await expect(
		reopened.getByRole('link', { name: /Offline-created SCT/ }),
	).toBeVisible();
	await expect(
		reopened.getByText('Pending sync', { exact: false }).first(),
	).toBeVisible();
	await expect(
		reopened.getByRole('heading', { name: 'The garage', exact: true }),
	).toBeFocused();
	await expect(reopened.getByRole('alert')).toHaveCount(0);
	await expectAxeClean(reopened);

	await context.setOffline(false);
	await expect(reopened.locator('[data-offline-status="ready"]')).toContainText(
		'Offline ready',
	);
	await expect(
		reopened.getByText('Pending sync', { exact: false }),
	).toHaveCount(0);
});

test('retains complete Setup work across an offline page restart and reconnects cleanly', async ({
	context,
	page,
}) => {
	await authenticateOwner(page);
	const carResponse = await page.request.post('/api/v1/cars', {
		data: {
			name: 'Trackside setup buggy',
			make: 'Team Associated',
			model: 'B7',
		},
	});
	expect(carResponse.ok()).toBe(true);
	const { car } = (await carResponse.json()) as { car: { id: string } };
	const baselineResponse = await page.request.post(
		`/api/v1/cars/${car.id}/setups`,
		{
			data: {
				name: 'Indoor clay baseline',
				track: 'Club track',
				condition: 'Dry',
				vehicle: { rideHeight: '12 mm' },
				makeCurrent: true,
			},
		},
	);
	expect(baselineResponse.ok()).toBe(true);
	const historicalResponse = await page.request.post(
		`/api/v1/cars/${car.id}/setups`,
		{
			data: {
				name: 'Outdoor reference',
				track: 'Outdoor track',
				makeCurrent: false,
			},
		},
	);
	expect(historicalResponse.ok()).toBe(true);

	const setupPath = `/garage/${car.id}/setups`;
	await page.goto(setupPath);
	await expect(page.locator('[data-offline-status="ready"]')).toContainText(
		'Offline ready',
	);
	await expect(
		page.getByRole('heading', { name: 'Setup snapshots' }),
	).toBeVisible();
	await expect(
		page.getByRole('button', { name: /Indoor clay baseline/ }),
	).toBeVisible();
	await expect(
		page.getByRole('button', { name: /Outdoor reference/ }),
	).toBeVisible();

	await context.setOffline(true);
	await page.getByRole('button', { name: /Indoor clay baseline/ }).click();
	await page.getByRole('button', { name: 'Copy setup' }).click();
	await expect(
		page.getByText('Setup copy saved on this device. Pending sync.'),
	).toBeVisible();
	await expect(
		page.getByRole('heading', { name: 'Repair a recording mistake' }),
	).toBeVisible();
	await page.getByLabel('Setup name').fill('Offline copied baseline');
	await page.getByLabel('Track').fill('Trackside correction');
	await page.getByRole('button', { name: 'Save snapshot' }).click();
	await expect(
		page.getByText('Setup saved on this device. Pending sync.'),
	).toBeVisible();
	await expect(
		page.getByRole('heading', { name: 'Offline copied baseline' }),
	).toBeVisible();
	await page.getByRole('button', { name: 'Select as current' }).click();
	await expect(
		page.getByText('Current setup saved on this device. Pending sync.'),
	).toBeVisible();

	await page.getByRole('button', { name: 'New setup' }).click();
	await page.getByLabel('Setup name').fill('Offline scratch baseline');
	await page.getByLabel('Track').fill('No-service pit');
	await page.getByRole('button', { name: 'Save snapshot' }).click();
	await expect(
		page.getByText('Setup saved on this device. Pending sync.'),
	).toBeVisible();

	await page
		.getByLabel('So Dialed setup URL')
		.fill('https://sodialed.com/setup/offlineSource');
	await page.getByRole('button', { name: 'Review setup' }).click();
	await expect(page.getByRole('alert')).toContainText(
		'That source could not be read',
	);

	const reopened = await reopenOffline(context, page, setupPath);
	await expect(
		reopened.locator('[data-offline-status="offline"]'),
	).toContainText('Offline—changes will be saved here');
	await expect(
		reopened.getByRole('button', { name: /Offline copied baseline/ }),
	).toBeVisible();
	await expect(
		reopened.getByRole('button', { name: /Offline scratch baseline/ }),
	).toBeVisible();
	await expect(
		reopened.getByRole('button', { name: /Indoor clay baseline/ }),
	).toBeVisible();
	await expect(
		reopened.getByRole('button', { name: /Outdoor reference/ }),
	).toBeVisible();
	await expect(
		reopened.getByText('Pending sync', { exact: false }).first(),
	).toBeVisible();
	await expectAxeClean(reopened);

	await reopened.goto(`/garage/${car.id}/overview`);
	await expect(
		reopened.getByRole('heading', { name: 'Current setup' }),
	).toBeVisible();
	await expect(reopened.locator('.current-setup-sheet')).toContainText(
		'Offline copied baseline',
	);

	await context.setOffline(false);
	await expect(reopened.locator('[data-offline-status="ready"]')).toContainText(
		'Offline ready',
		{ timeout: 10_000 },
	);
	await expect(
		reopened.getByText('Pending sync', { exact: false }),
	).toHaveCount(0, { timeout: 10_000 });
});

test('keeps a browser without required capabilities honestly online-only', async ({
	page,
}) => {
	await page.addInitScript(() => {
		Object.defineProperty(globalThis, 'indexedDB', {
			configurable: true,
			value: undefined,
		});
	});
	await authenticateOwner(page);
	await page.goto('/garage');

	const status = page.locator('[data-offline-status="online-only"]');
	await expect(status).toContainText(
		'Offline access is unavailable in this browser',
	);
	await expect(
		page.getByRole('heading', { name: 'The garage', exact: true }),
	).toBeFocused();
	await expectAxeClean(page);

	const signOutResponse = page.waitForResponse((response) =>
		response.url().endsWith('/api/auth/sign-out'),
	);
	await page.getByRole('button', { name: 'Sign out' }).click();
	expect((await signOutResponse).ok()).toBe(true);
	await expect(
		page.getByRole('heading', { name: 'Back to the workbench.' }),
	).toBeVisible();

	await authenticateOwner(page);
	await page.goto('/garage');
	await expect(status).toContainText(
		'Offline access is unavailable in this browser',
	);
	await page.context().setOffline(true);
	await page.getByRole('button', { name: 'Inspect archived cars' }).click();
	await expect(
		page.locator('[data-offline-status="offline-unavailable"]'),
	).toContainText('Offline—this browser has no prepared Garage.');
	await expect(page.getByRole('button', { name: 'Add a car' })).toHaveCount(0);
	await expect(page.getByText('Car changes are unavailable')).toBeVisible();
});

test('does not restore the prior Garage after explicit sign-out', async ({
	context,
	page,
}) => {
	await authenticateOwner(page);
	const created = await page.request.post('/api/v1/cars', {
		data: { name: 'Signed-out private buggy' },
	});
	expect(created.ok()).toBe(true);
	await page.goto('/garage');
	await expect(page.locator('[data-offline-status="ready"]')).toContainText(
		'Offline ready',
	);

	await page.getByRole('button', { name: 'Sign out' }).click();
	await expect(
		page.getByRole('heading', { name: 'Back to the workbench.' }),
	).toBeVisible();

	const reopened = await reopenOffline(context, page);
	await expect(
		reopened.getByRole('heading', { name: 'Back to the workbench.' }),
	).toBeVisible();
	await expect(reopened.getByText('Signed-out private buggy')).toHaveCount(0);
	await expectAxeClean(reopened);
});

test('explains unavailable deep links after an offline restart and keeps Garage reachable', async ({
	context,
	page,
}) => {
	await authenticateOwner(page);
	await page.goto('/garage');
	await expect(page.locator('[data-offline-status="ready"]')).toBeVisible();
	const reopened = await reopenOffline(context, page, '/settings');
	await expect(reopened).toHaveURL(/\/offline-unavailable$/);
	await expect(
		reopened.getByRole('heading', { name: 'Connection needed' }),
	).toBeVisible();
	await expect(
		reopened.getByText('Reconnect to open it.', { exact: false }),
	).toBeVisible();
	await expectAxeClean(reopened);
	await reopened
		.getByRole('link', { name: 'Return to Garage', exact: true })
		.click();
	await expect(reopened).toHaveURL(/\/garage$/);
	await expect(
		reopened.getByRole('heading', { name: 'The garage', exact: true }),
	).toBeVisible();
});

test('retains Component edits, replacements, and removals across an offline restart', async ({
	context,
	page,
}) => {
	await authenticateOwner(page);
	const created = await page.request.post('/api/v1/cars', {
		data: { name: 'Offline build buggy' },
	});
	expect(created.ok()).toBe(true);
	const { car } = (await created.json()) as { car: { id: string } };
	const installed = await page.request.post(
		`/api/v1/cars/${car.id}/components`,
		{ data: { slot: 'motor', name: 'Stock motor' } },
	);
	expect(installed.ok()).toBe(true);
	await page.goto(`/garage/${car.id}/build`);
	await expect(page.locator('[data-offline-status="ready"]')).toBeVisible();
	await expect(page.getByText('Stock motor', { exact: true })).toBeVisible();
	await context.setOffline(true);
	await page.getByRole('button', { name: 'Edit', exact: true }).click();
	await page.getByLabel('Name').fill('Tuned motor');
	await page.getByRole('button', { name: 'Save component' }).click();
	await expect(page.getByText('Tuned motor', { exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Replace', exact: true }).click();
	await page.getByLabel('Name').fill('Race motor');
	await page.getByRole('button', { name: 'Save component' }).click();
	await expect(page.getByText('Race motor', { exact: true })).toBeVisible();
	const reopened = await reopenOffline(
		context,
		page,
		`/garage/${car.id}/build`,
	);
	await expect(reopened.getByText('Race motor', { exact: true })).toBeVisible();
	await expect(
		reopened.getByText('Pending sync: Race motor', { exact: false }),
	).toBeVisible();
	await reopened.getByRole('button', { name: 'Remove', exact: true }).click();
	await expect(
		reopened.getByRole('button', { name: 'Install', exact: true }),
	).toBeVisible();
	await expectAxeClean(reopened);
	await context.setOffline(false);
	await expect(
		reopened.getByText('Pending sync:', { exact: false }),
	).toHaveCount(0);
	const history = await reopened.request.get(
		`/api/v1/cars/${car.id}/components?history=true`,
	);
	const body = (await history.json()) as {
		components: Array<{ name: string; removedAt: string | null }>;
	};
	expect(body.components.map((component) => component.name).sort()).toEqual([
		'Race motor',
		'Tuned motor',
	]);
	expect(
		body.components.every((component) => component.removedAt !== null),
	).toBe(true);
});

test('records and edits Drive sessions after an offline restart and reconciles usage once', async ({
	context,
	page,
}) => {
	await authenticateOwner(page);
	const created = await page.request.post('/api/v1/cars', {
		data: { name: 'Offline drive buggy' },
	});
	expect(created.ok()).toBe(true);
	const { car } = (await created.json()) as { car: { id: string } };
	await page.goto(`/garage/${car.id}/drive-sessions`);
	await expect(page.locator('[data-offline-status="ready"]')).toBeVisible();
	await context.setOffline(true);
	const reopened = await reopenOffline(
		context,
		page,
		`/garage/${car.id}/drive-sessions`,
	);
	await reopened
		.getByRole('button', { name: 'Record the first drive session' })
		.click();
	await reopened
		.getByLabel('Started', { exact: false })
		.fill('2026-10-09T12:00');
	await reopened.getByLabel('Duration (minutes)', { exact: false }).fill('12');
	await reopened.getByLabel('Conditions', { exact: false }).fill('Dry carpet');
	await reopened
		.getByRole('button', { name: 'Save session', exact: true })
		.click();
	await expect(
		reopened.getByText('Drive session saved on this device. Pending sync.'),
	).toBeVisible();
	await expect(reopened.getByText('Dry carpet', { exact: true })).toBeVisible();
	await reopened
		.getByRole('button', { name: 'Edit drive session 1', exact: true })
		.click();
	await reopened.getByLabel('Notes', { exact: false }).fill('More rear grip');
	await reopened
		.getByRole('button', { name: 'Save session', exact: true })
		.click();
	await expect(
		reopened.getByText('More rear grip', { exact: true }),
	).toBeVisible();
	await expectAxeClean(reopened);
	await context.setOffline(false);
	await expect(
		reopened.getByText('Drive session saved on this device. Pending sync.'),
	).toHaveCount(0);
	const response = await reopened.request.get(
		`/api/v1/cars/${car.id}/drives?history=true`,
	);
	const result = (await response.json()) as {
		driveSessions: Array<{ notes: string; durationMinutes: number }>;
		count: number;
	};
	expect(result.count).toBe(1);
	expect(result.driveSessions).toHaveLength(1);
	expect(result.driveSessions[0]).toMatchObject({
		notes: 'More rear grip',
		durationMinutes: 12,
	});
});

test('retains Settings across offline restart and requires confirmation before discarding them', async ({
	context,
	page,
}) => {
	await authenticateOwner(page);
	await page.goto('/settings');
	await expect(page.locator('[data-offline-status="ready"]')).toBeVisible();
	const offline = await reopenOffline(context, page, '/settings');
	await expect(
		offline.getByRole('heading', { name: 'Garage timezone', exact: true }),
	).toBeVisible();
	await offline.getByLabel('IANA timezone', { exact: true }).fill('Asia/Tokyo');
	await offline.getByRole('button', { name: 'Save timezone' }).click();
	await expect(
		offline.getByRole('status', { name: 'Settings synchronization' }),
	).toContainText('Pending sync');
	await expect(
		offline.getByText(
			'Passkey registration, rename, and revocation are unavailable offline.',
			{ exact: false },
		),
	).toBeVisible();
	await offline.getByRole('button', { name: 'Sign out', exact: true }).click();
	const confirmation = offline.getByRole('alertdialog');
	await expect(confirmation).toContainText('permanently discarded');
	await expectAxeClean(offline);
	await confirmation.getByRole('button', { name: 'Keep working' }).click();
	await expect(confirmation).toBeHidden();
	await context.setOffline(false);
	await expect(
		offline.getByRole('status', { name: 'Settings synchronization' }),
	).toContainText('Settings synchronized.');
	const preference = await offline.request.get('/api/v1/preferences/timezone');
	expect(await preference.json()).toEqual({ timezone: 'Asia/Tokyo' });
	await expectAxeClean(offline);
});

test('confirmed offline sign-out clears the working copy and fences the old server cookie', async ({
	context,
	page,
}) => {
	await authenticateOwner(page);
	await context.route('**/api/auth/sign-out', (route) => route.abort());
	await page.goto('/settings');
	await expect(page.locator('[data-offline-status="ready"]')).toBeVisible();
	await context.setOffline(true);
	await page
		.getByLabel('IANA timezone', { exact: true })
		.fill('Pacific/Auckland');
	await page.getByRole('button', { name: 'Save timezone' }).click();
	await expect(
		page.getByRole('status', { name: 'Settings synchronization' }),
	).toContainText('Pending sync');
	await page.getByRole('button', { name: 'Sign out', exact: true }).click();
	await page
		.getByRole('button', { name: 'Discard changes and sign out' })
		.click();
	await expect(page).toHaveURL(/\/sign-in/);
	const privateRecords = await page.evaluate(async () => {
		const request = indexedDB.open('chassis-notes-offline-v1');
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		const tables = [
			'snapshots',
			'operations',
			'setupOperations',
			'settingsOperations',
		];
		const counts = await Promise.all(
			tables.map(
				(name) =>
					new Promise<number>((resolve, reject) => {
						const count = database.transaction(name).objectStore(name).count();
						count.onsuccess = () => resolve(count.result);
						count.onerror = () => reject(count.error);
					}),
			),
		);
		database.close();
		return counts;
	});
	expect(privateRecords).toEqual([0, 0, 0, 0]);
	await context.setOffline(false);
	await page.reload();
	await page.goto('/settings');
	await expect(page).toHaveURL(/\/sign-in\?reason=signed-out/);
	await expectAxeClean(page);
});

test('retains photo originals and new captures through offline restart and idempotent reconnect', async ({
	context,
	page,
}) => {
	await authenticateOwner(page);
	const response = await page.request.post('/api/v1/cars', {
		data: { name: 'Offline photo buggy' },
	});
	expect(response.ok()).toBe(true);
	const { car } = (await response.json()) as { car: { id: string } };
	const png = Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXZkAAAAASUVORK5CYII=',
		'base64',
	);
	const existing = await page.request.post(`/api/v1/cars/${car.id}/photos`, {
		multipart: {
			file: { name: 'original.png', mimeType: 'image/png', buffer: png },
		},
	});
	expect(existing.ok()).toBe(true);
	const path = `/garage/${car.id}/photos`;
	await page.goto(path);
	await expect(page.locator('[data-offline-status="ready"]')).toBeVisible();
	await expect(page.locator('.photo-grid img')).toHaveCount(1);
	await expect(page.locator('.photo-grid img')).toHaveAttribute(
		'src',
		/^blob:/,
	);
	await context.setOffline(true);
	await page.locator('.upload-button input').setInputFiles({
		name: 'trackside.png',
		mimeType: 'image/png',
		buffer: png,
	});
	await expect(page.getByText('Pending sync', { exact: true })).toBeVisible();
	await expect(page.locator('.photo-grid img')).toHaveCount(2);
	const reopened = await reopenOffline(context, page, path);
	await expect(reopened.locator('.photo-grid img')).toHaveCount(2);
	await expect
		.poll(() =>
			reopened
				.locator('.photo-grid img')
				.evaluateAll((images) =>
					images.every((image) => (image as HTMLImageElement).naturalWidth > 0),
				),
		)
		.toBe(true);
	await expect(
		reopened.getByText('Pending sync', { exact: true }),
	).toBeVisible();
	await expectAxeClean(reopened);
	await context.setOffline(false);
	await expect(reopened.getByText('Pending sync', { exact: true })).toHaveCount(
		0,
	);
	const metadata = await reopened.request.get(`/api/v1/cars/${car.id}/photos`);
	const canonical = (await metadata.json()) as {
		photos: { id: string; fileName: string }[];
	};
	expect(canonical.photos).toHaveLength(2);
	const captured = canonical.photos.find(
		(photo) => photo.fileName === 'trackside.png',
	);
	expect(captured).toBeDefined();
	const replay = await reopened.request.put(
		`/api/v1/cars/${car.id}/photos/captures/${captured?.id}`,
		{
			multipart: {
				file: { name: 'trackside.png', mimeType: 'image/png', buffer: png },
			},
		},
	);
	expect(replay.ok()).toBe(true);
	const afterReplay = await reopened.request.get(
		`/api/v1/cars/${car.id}/photos`,
	);
	expect(
		((await afterReplay.json()) as { photos: unknown[] }).photos,
	).toHaveLength(2);
	await expect(reopened.locator('.photo-grid img')).toHaveCount(2);
	await expectAxeClean(reopened);
});

test('describes uncached photo originals honestly and clears retained bytes on sign-out', async ({
	context,
	page,
}) => {
	await authenticateOwner(page);
	const created = await page.request.post('/api/v1/cars', {
		data: { name: 'Photo metadata only' },
	});
	const { car } = (await created.json()) as { car: { id: string } };
	const png = Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXZkAAAAASUVORK5CYII=',
		'base64',
	);
	expect(
		(
			await page.request.post(`/api/v1/cars/${car.id}/photos`, {
				multipart: {
					file: { name: 'original.png', mimeType: 'image/png', buffer: png },
				},
			})
		).ok(),
	).toBe(true);
	await page.goto('/garage');
	await expect(page.locator('[data-offline-status="ready"]')).toBeVisible();
	const reopened = await reopenOffline(
		context,
		page,
		`/garage/${car.id}/photos`,
	);
	await expect(
		reopened.getByText('Original unavailable on this device.', {
			exact: false,
		}),
	).toBeVisible();
	await expect(reopened.locator('.photo-grid img')).toHaveCount(0);
	await expectAxeClean(reopened);
	await context.setOffline(false);
	await reopened.reload();
	await expect(reopened.locator('.photo-grid img')).toHaveAttribute(
		'src',
		/^blob:/,
	);
	await reopened.getByRole('button', { name: 'Sign out', exact: true }).click();
	await expect(reopened).toHaveURL(/sign-in/);
	const counts = await reopened.evaluate(async () => {
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open('chassis-notes-offline-v1');
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		try {
			return await Promise.all(
				['photoCaptures', 'photoMedia'].map(
					(name) =>
						new Promise<number>((resolve, reject) => {
							const request = database
								.transaction(name)
								.objectStore(name)
								.count();
							request.onsuccess = () => resolve(request.result);
							request.onerror = () => reject(request.error);
						}),
				),
			);
		} finally {
			database.close();
		}
	});
	expect(counts).toEqual([0, 0]);
});

test('retains Maintenance plans and Service records across an offline restart and replays once', async ({
	context,
	page,
}) => {
	await authenticateOwner(page);
	const response = await page.request.post('/api/v1/cars', {
		data: { name: 'Offline maintenance buggy' },
	});
	expect(response.ok()).toBe(true);
	const { car } = (await response.json()) as { car: { id: string } };
	await page.goto('/maintenance');
	await expect(page.locator('[data-offline-status="ready"]')).toBeVisible();
	await context.setOffline(true);
	await page
		.getByRole('button', { name: /^(Create a plan|New plan)$/ })
		.click();
	await page
		.getByRole('combobox', { name: 'Car', exact: true })
		.selectOption(car.id);
	await page.getByLabel('Plan name').fill('Trackside bearing care');
	await page.locator('input[name$=".calendarValue"]').fill('7');
	await page.getByRole('button', { name: 'Save plan', exact: true }).click();
	let row = page
		.locator('article.plan-row')
		.filter({ hasText: 'Trackside bearing care' });
	await expect(row).toBeVisible();
	await row.getByRole('button', { name: 'Edit', exact: true }).click();
	await page.getByLabel('Plan name').fill('Trackside bearing inspection');
	await page.getByRole('button', { name: 'Save plan', exact: true }).click();
	row = page
		.locator('article.plan-row')
		.filter({ hasText: 'Trackside bearing inspection' });
	await row.getByRole('button', { name: 'Pause', exact: true }).click();
	await page.getByRole('button', { name: 'Everything', exact: true }).click();
	await row.getByRole('button', { name: 'Resume', exact: true }).click();
	await row.getByRole('button', { name: 'Archive', exact: true }).click();
	await row.getByRole('button', { name: 'Restore plan', exact: true }).click();
	await row.getByRole('button', { name: 'Complete', exact: true }).click();
	await page.getByLabel('Completed work').fill('Cleaned trackside bearings');
	await page.getByRole('button', { name: 'Save service', exact: true }).click();
	await expect(
		page.getByText('Cleaned trackside bearings', { exact: true }).first(),
	).toBeVisible();
	await expect(page.getByText(/Pending sync/).first()).toBeVisible();
	const reopened = await reopenOffline(context, page, '/maintenance');
	await expect(
		reopened.getByText('Trackside bearing inspection', { exact: true }),
	).toBeVisible();
	await expect(
		reopened.getByText('Cleaned trackside bearings', { exact: true }).first(),
	).toBeVisible();
	await expectAxeClean(reopened);
	await context.setOffline(false);
	await expect(reopened.getByText(/Pending sync/)).toHaveCount(0);
	const snapshotResponse = await reopened.request.get(
		'/api/v1/maintenance/sync/snapshot',
	);
	expect(snapshotResponse.ok()).toBe(true);
	const snapshot = (await snapshotResponse.json()) as {
		collections: Array<{
			carId: string;
			plans: Array<{ name: string; status: string }>;
			records: Array<{ description: string; deletedAt: string | null }>;
		}>;
	};
	const saved = snapshot.collections.find((item) => item.carId === car.id);
	expect(saved?.plans).toEqual([
		expect.objectContaining({
			name: 'Trackside bearing inspection',
			status: 'active',
		}),
	]);
	expect(saved?.records).toEqual([
		expect.objectContaining({
			description: 'Cleaned trackside bearings',
			deletedAt: null,
		}),
	]);
	await reopened.reload();
	await expect(
		reopened.getByText('Cleaned trackside bearings', { exact: true }).first(),
	).toBeVisible();
});

test('retains Maintenance conflicts and rejection feedback while independent service synchronizes', async ({
	context,
	page,
}) => {
	await authenticateOwner(page);
	const create = async (name: string) => {
		const response = await page.request.post('/api/v1/cars', {
			data: { name },
		});
		expect(response.ok()).toBe(true);
		return ((await response.json()) as { car: { id: string } }).car;
	};
	const car = await create('Maintenance conflict buggy');
	const archived = await create('Maintenance rejected buggy');
	const response = await page.request.post('/api/v1/maintenance-plans', {
		data: {
			carId: car.id,
			name: 'Conflict baseline',
			intervalDays: 7,
			baselineAt: '2026-10-01T12:00:00.000Z',
		},
	});
	expect(response.ok()).toBe(true);
	const { maintenancePlan: plan } = (await response.json()) as {
		maintenancePlan: { id: string };
	};
	await page.goto('/maintenance');
	await expect(page.locator('[data-offline-status="ready"]')).toBeVisible();
	await context.setOffline(true);
	await page
		.locator('article.plan-row')
		.filter({ hasText: 'Conflict baseline' })
		.getByRole('button', { name: 'Edit', exact: true })
		.click();
	await page.getByLabel('Plan name').fill('Local conflict intent');
	await page.getByRole('button', { name: 'Save plan', exact: true }).click();
	for (const [carId, description] of [
		[archived.id, 'Rejected service retained'],
		[car.id, 'Independent service retained'],
	]) {
		await page.getByRole('button', { name: 'Log ad hoc service' }).click();
		await page
			.getByRole('combobox', { name: 'Car', exact: true })
			.selectOption(carId);
		await page.getByLabel('Completed work').fill(description);
		await page
			.getByRole('button', { name: 'Save service', exact: true })
			.click();
		await expect(
			page.getByText(description, { exact: true }).first(),
		).toBeVisible();
	}
	expect(
		(
			await page.request.patch(`/api/v1/maintenance-plans/${plan.id}`, {
				data: { name: 'Remote conflict decision' },
			})
		).ok(),
	).toBe(true);
	expect(
		(await page.request.post(`/api/v1/cars/${archived.id}/archive`)).ok(),
	).toBe(true);
	await context.setOffline(false);
	await expect(
		page.getByText(/Sync conflict: This maintenance record changed/),
	).toBeVisible();
	await expect(
		page.getByText(/Needs attention: Restore this Car/),
	).toBeVisible();
	await expect(page.getByText(/Pending sync/)).toHaveCount(0);
	await expect(
		page.getByText('Local conflict intent', { exact: true }),
	).toBeVisible();
	await expect(
		page.getByText('Rejected service retained', { exact: true }).first(),
	).toBeVisible();
	const snapshot = (await (
		await page.request.get('/api/v1/maintenance/sync/snapshot')
	).json()) as {
		collections: Array<{
			carId: string;
			plans: Array<{ name: string }>;
			records: Array<{ description: string }>;
		}>;
	};
	expect(
		snapshot.collections.find((item) => item.carId === car.id)?.plans,
	).toEqual([expect.objectContaining({ name: 'Remote conflict decision' })]);
	expect(
		snapshot.collections.find((item) => item.carId === car.id)?.records,
	).toEqual([
		expect.objectContaining({ description: 'Independent service retained' }),
	]);
	expect(
		snapshot.collections.find((item) => item.carId === archived.id)?.records,
	).toEqual([]);
	await expectAxeClean(page);
});
