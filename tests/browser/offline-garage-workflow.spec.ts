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

test('retains Consumable tire and fluid history with stable reports across restart and replay', async ({
	context,
	page,
}) => {
	await authenticateOwner(page);
	const created = await page.request.post('/api/v1/cars', {
		data: { name: 'Consumable trackside buggy' },
	});
	const { car } = (await created.json()) as { car: { id: string } };
	await page.goto('/maintenance');
	await expect(page.locator('[data-offline-status="ready"]')).toBeVisible();
	let replay: { url: string; body: unknown } | undefined;
	page.on('request', (request) => {
		if (
			request.method() === 'PUT' &&
			request.url().includes('/api/v1/sync/operations/')
		) {
			const body = request.postDataJSON() as { command?: { entity?: string } };
			if (body.command?.entity === 'consumable')
				replay = { url: request.url(), body };
		}
	});
	const ledger = page.locator('.consumable-ledger');
	const initialCount = Number.parseInt(
		await ledger.locator('.history-total').innerText(),
		10,
	);
	const initialSpend = Number(
		(await ledger.locator('.spend-strip strong').last().innerText()).replace(
			/[^0-9.]/g,
			'',
		),
	);
	const expectedSpend = new Intl.NumberFormat('en-US', {
		style: 'currency',
		currency: 'USD',
	}).format(initialSpend + 30);
	const expectedCount = `${initialCount + 3} entries`;
	await context.setOffline(true);
	await ledger
		.getByRole('button', { name: 'Record change', exact: true })
		.click();
	await ledger
		.getByRole('combobox', { name: 'Car', exact: true })
		.selectOption(car.id);
	await ledger
		.getByRole('combobox', { name: 'What changed', exact: true })
		.selectOption('tires');
	await ledger.getByText('both axles', { exact: true }).click();
	await ledger.getByLabel('Front tire details').fill('Trackside front pins');
	await ledger.getByLabel('Rear tire details').fill('Trackside rear pins');
	await ledger.getByLabel('Front cost (USD)').fill('12');
	await ledger.getByLabel('Rear cost (USD)').fill('18');
	await ledger
		.getByRole('button', { name: 'Save change', exact: true })
		.click();
	await expect(ledger.getByText('Pending sync', { exact: true })).toBeVisible();
	await expect(
		ledger.locator('.spend-strip').getByText(expectedSpend, { exact: true }),
	).toBeVisible();
	for (const kind of ['shock-fluid', 'differential-fluid']) {
		await ledger
			.getByRole('button', { name: 'Record change', exact: true })
			.click();
		await ledger
			.getByRole('combobox', { name: 'Car', exact: true })
			.selectOption(car.id);
		await ledger
			.getByRole('combobox', { name: 'What changed', exact: true })
			.selectOption(kind);
		await ledger
			.getByRole('button', { name: 'Save change', exact: true })
			.click();
	}
	await expect(ledger.locator('.history-total')).toHaveText(expectedCount);
	const restarted = await reopenOffline(context, page, '/maintenance');
	const history = restarted.locator('.consumable-ledger');
	await expect(history.locator('.history-total')).toHaveText(expectedCount);
	await expect(
		history.locator('.spend-strip').getByText(expectedSpend, { exact: true }),
	).toBeVisible();
	await expectAxeClean(restarted);
	await context.setOffline(false);
	await expect(history.getByText(/Pending sync/)).toHaveCount(0);
	expect(replay).toBeDefined();
	if (!replay) throw new Error('Missing Consumable sync request');
	expect(
		(await restarted.request.put(replay.url, { data: replay.body })).ok(),
	).toBe(true);
	const response = await restarted.request.get(
		'/api/v1/maintenance/sync/snapshot',
	);
	expect(response.ok()).toBe(true);
	const snapshot = (await response.json()) as {
		collections: Array<{ carId: string; consumables: Array<{ id: string }> }>;
	};
	expect(
		snapshot.collections.find((value) => value.carId === car.id)?.consumables,
	).toHaveLength(3);
	await restarted.reload();
	await expect(history.locator('.history-total')).toHaveText(expectedCount);
	await expect(
		history.locator('.spend-strip').getByText(expectedSpend, { exact: true }),
	).toBeVisible();
});

test('preserves conflicting and rejected Consumable work while independent fluid entries synchronize', async ({
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
	const car = await create('Consumable conflict buggy');
	const archived = await create('Consumable rejection buggy');
	const created = await page.request.post(
		`/api/v1/cars/${car.id}/consumable-maintenance`,
		{
			data: {
				kind: 'tires',
				performedAt: '2026-10-01T12:00:00.000Z',
				axle: 'front',
				frontDetails: 'Original pins',
				frontCost: 10,
			},
		},
	);
	expect(created.ok()).toBe(true);
	const { consumableMaintenance: entry } = (await created.json()) as {
		consumableMaintenance: { id: string };
	};
	await page.goto('/maintenance');
	await expect(page.locator('[data-offline-status="ready"]')).toBeVisible();
	await context.setOffline(true);
	const ledger = page.locator('.consumable-ledger');
	await ledger
		.locator('article.consumable-row')
		.filter({ hasText: 'Original pins' })
		.getByRole('button', { name: 'Edit', exact: true })
		.click();
	await ledger.getByLabel('Front tire details').fill('Local pending pins');
	await ledger
		.getByRole('button', { name: 'Save change', exact: true })
		.click();
	for (const [carId, note] of [
		[archived.id, 'Rejected fluid retained'],
		[car.id, 'Independent fluid retained'],
	]) {
		await ledger
			.getByRole('button', { name: 'Record change', exact: true })
			.click();
		await ledger
			.getByRole('combobox', { name: 'Car', exact: true })
			.selectOption(carId);
		await ledger.getByLabel('Notes', { exact: true }).fill(note);
		await ledger
			.getByRole('button', { name: 'Save change', exact: true })
			.click();
	}
	expect(
		(
			await page.request.patch(
				`/api/v1/cars/${car.id}/consumable-maintenance/${entry.id}`,
				{ data: { frontDetails: 'Remote newer pins', frontCost: 40 } },
			)
		).ok(),
	).toBe(true);
	expect(
		(await page.request.post(`/api/v1/cars/${archived.id}/archive`)).ok(),
	).toBe(true);
	await context.setOffline(false);
	await expect(
		ledger.getByText(/Sync conflict: This Consumable entry/),
	).toBeVisible();
	await expect(
		ledger.getByText(/Needs attention: Restore this Car/),
	).toBeVisible();
	await expect(ledger.getByText(/Pending sync/)).toHaveCount(0);
	await expect(
		ledger
			.locator('article.consumable-row')
			.filter({ hasText: 'Local pending pins' }),
	).toBeVisible();
	await expect(
		ledger.getByText('Rejected fluid retained', { exact: true }),
	).toBeVisible();
	await expectAxeClean(page);
	const snapshot = (await (
		await page.request.get('/api/v1/maintenance/sync/snapshot')
	).json()) as {
		collections: Array<{
			carId: string;
			consumables: Array<{
				id: string;
				notes: string | null;
				frontCost: number | null;
			}>;
		}>;
	};
	const saved = snapshot.collections.find(
		(value) => value.carId === car.id,
	)?.consumables;
	expect(saved).toHaveLength(2);
	expect(saved?.find((value) => value.id === entry.id)?.frontCost).toBe(40);
	expect(
		saved?.filter((value) => value.notes === 'Independent fluid retained'),
	).toHaveLength(1);
	expect(
		snapshot.collections.find((value) => value.carId === archived.id)
			?.consumables,
	).toEqual([]);
});
