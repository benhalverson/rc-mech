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

test('retains Voice text with a pending Drive context through restart and automatic sync', async ({
	page,
	context,
}) => {
	await authenticateOwner(page);
	const created = await page.request.post('/api/v1/cars', {
		data: { name: 'Offline voice context buggy' },
	});
	expect(created.ok()).toBe(true);
	const { car } = (await created.json()) as { car: { id: string } };
	await page.goto(`/garage/${car.id}/drive-sessions`);
	await expect(page.locator('[data-offline-status="ready"]')).toBeVisible();
	await context.setOffline(true);
	await page
		.getByRole('button', { name: 'Record the first drive session' })
		.click();
	await page.getByLabel('Started', { exact: false }).fill('2026-10-09T12:00');
	await page
		.getByLabel('Conditions', { exact: false })
		.fill('Offline voice heat');
	await page.getByRole('button', { name: 'Save session', exact: true }).click();
	await expect(
		page.getByText('Offline voice heat', { exact: true }),
	).toBeVisible();
	await page
		.getByRole('link', { name: 'Voice track log', exact: true })
		.click();
	await expect(page.getByLabel('Drive-session context')).toContainText(
		'Offline voice heat',
	);
	await page.getByRole('button', { name: 'Type instead' }).click();
	await page
		.getByLabel('Track note', { exact: true })
		.fill('Rear slides on offline entry');
	await page.getByRole('button', { name: 'Keep text note' }).click();
	await expect(
		page.getByText('Rear slides on offline entry', { exact: true }),
	).toBeVisible();
	await expect(page.getByText(/Pending sync/).first()).toBeVisible();
	const reopened = await reopenOffline(
		context,
		page,
		`/garage/${car.id}/voice`,
	);
	await expect(
		reopened.getByText('Rear slides on offline entry', { exact: true }),
	).toBeVisible();
	await expect(
		reopened.getByText(
			/transcription, draft extraction, corrections, and confirmation are waiting/,
		),
	).toBeVisible();
	await expectAxeClean(reopened);
	await context.setOffline(false);
	await expect(
		reopened.getByText('Pending on this device', { exact: true }),
	).toHaveCount(0);
	await expect(reopened.getByLabel('Transcript')).toContainText(
		'Rear slides on offline entry',
	);
	const response = await reopened.request.get(
		`/api/v1/cars/${car.id}/voice-updates`,
	);
	const { voiceUpdates } = (await response.json()) as {
		voiceUpdates: Array<{ id: string; driveSessionId: string; status: string }>;
	};
	expect(voiceUpdates).toHaveLength(1);
	expect(voiceUpdates[0].status).toBe('needs-review');
	expect(voiceUpdates[0].driveSessionId).toBeTruthy();
	const replay = await reopened.request.post(
		`/api/v1/cars/${car.id}/voice-updates`,
		{
			data: {
				captureId: voiceUpdates[0].id,
				text: 'Rear slides on offline entry',
				driveSessionId: voiceUpdates[0].driveSessionId,
			},
		},
	);
	expect(replay.ok()).toBe(true);
	expect(
		(
			await (
				await reopened.request.get(`/api/v1/cars/${car.id}/voice-updates`)
			).json()
		).voiceUpdates,
	).toHaveLength(1);
});

test('preserves original Voice audio bytes through offline restart, upload and retained playback data', async ({
	page,
	context,
}) => {
	await page.addInitScript(() => {
		navigator.mediaDevices.getUserMedia = async () => {
			const audio = new AudioContext();
			await audio.resume();
			const destination = audio.createMediaStreamDestination();
			const oscillator = audio.createOscillator();
			oscillator.frequency.value = 440;
			oscillator.connect(destination);
			oscillator.start();
			return destination.stream;
		};
	});
	await authenticateOwner(page);
	const created = await page.request.post('/api/v1/cars', {
		data: { name: 'Offline audio buggy' },
	});
	expect(created.ok()).toBe(true);
	const { car } = (await created.json()) as { car: { id: string } };
	await page.goto(`/garage/${car.id}/voice`);
	await expect(page.locator('[data-offline-status="ready"]')).toBeVisible();
	await context.setOffline(true);
	await page.getByRole('button', { name: 'Start voice note' }).click();
	await expect(page.getByText('Audio detected', { exact: true })).toBeVisible();
	await page.waitForTimeout(1000);
	await page.getByRole('button', { name: 'Stop and keep recording' }).click();
	await expect(
		page.getByText('Pending on this device', { exact: true }),
	).toBeVisible();
	const original = await page.evaluate(async (carId) => {
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open('chassis-notes-offline-v1');
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		const captures = await new Promise<
			Array<{ id: string; carId: string; blob: Blob }>
		>((resolve, reject) => {
			const request = database
				.transaction('voiceCaptures')
				.objectStore('voiceCaptures')
				.getAll();
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		database.close();
		const capture = captures.find((c) => c.carId === carId);
		if (!capture) throw new Error('No original retained');
		const bytes = await capture.blob.arrayBuffer();
		const digest = [
			...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
		];
		const audio = new AudioContext();
		const decoded = await audio.decodeAudioData(bytes);
		await audio.close();
		return {
			id: capture.id,
			digest,
			duration: decoded.duration,
			size: capture.blob.size,
		};
	}, car.id);
	expect(original.duration).toBeGreaterThan(0.8);
	expect(original.size).toBeGreaterThan(1000);
	const reopened = await reopenOffline(
		context,
		page,
		`/garage/${car.id}/voice`,
	);
	await expect(
		reopened.getByText('Pending on this device', { exact: true }),
	).toBeVisible();
	await expectAxeClean(reopened);
	await context.setOffline(false);
	await expect(
		reopened.getByText('Pending on this device', { exact: true }),
	).toHaveCount(0);
	await expect(reopened.getByLabel('Transcript')).toContainText(
		'Offline audio fixture',
	);
	const remoteDigest = await reopened.evaluate(async (id) => {
		const bytes = await (
			await fetch(`/api/v1/voice-updates/${id}/audio`)
		).arrayBuffer();
		return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))];
	}, original.id);
	expect(remoteDigest).toEqual(original.digest);
	expect(
		(
			await (
				await reopened.request.get(`/api/v1/cars/${car.id}/voice-updates`)
			).json()
		).voiceUpdates,
	).toHaveLength(1);
});

test('migrates legacy Voice intent once and retains processing rejection without blocking another capture', async ({
	page,
	context,
}) => {
	await authenticateOwner(page);
	const created = await page.request.post('/api/v1/cars', {
		data: { name: 'Legacy voice migration buggy' },
	});
	expect(created.ok()).toBe(true);
	const { car } = (await created.json()) as { car: { id: string } };
	await page.goto(`/garage/${car.id}/voice`);
	await expect(page.locator('[data-offline-status="ready"]')).toBeVisible();
	const ids = await page.evaluate(async (carId) => {
		const database = await new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDB.open('rc-mech-voice-queue');
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		const captures = [
			'Fixture processing rejection',
			'Independent migrated note',
		].map((text) => ({
			id: crypto.randomUUID(),
			ownerKey: 'owner@example.com',
			carId,
			driveSessionId: null,
			text,
			contentType: 'text/plain',
			fileName: 'legacy.txt',
			createdAt: new Date().toISOString(),
			status: 'queued',
			error: null,
		}));
		await new Promise<void>((resolve, reject) => {
			const transaction = database.transaction('captures', 'readwrite');
			for (const capture of captures)
				transaction.objectStore('captures').put(capture);
			transaction.oncomplete = () => resolve();
			transaction.onerror = () => reject(transaction.error);
		});
		database.close();
		return captures.map((capture) => capture.id);
	}, car.id);
	const reopened = await reopenOffline(
		context,
		page,
		`/garage/${car.id}/voice`,
	);
	await expect(
		reopened.getByText('Fixture processing rejection', { exact: true }),
	).toBeVisible();
	await expect(
		reopened.getByText('Independent migrated note', { exact: true }),
	).toBeVisible();
	await context.setOffline(false);
	await expect(
		reopened.getByText('Needs attention', { exact: true }),
	).toBeVisible();
	await expect(
		reopened.getByText(
			'The voice note could not be processed. Your recording is safe; try again.',
			{ exact: true },
		),
	).toBeVisible();
	await expect(reopened.getByLabel('Transcript')).toContainText(
		'Independent migrated note',
	);
	const { voiceUpdates } = (await (
		await reopened.request.get(`/api/v1/cars/${car.id}/voice-updates`)
	).json()) as { voiceUpdates: Array<{ id: string; status: string }> };
	expect(voiceUpdates.map((v) => v.id).sort()).toEqual(ids.sort());
	expect(voiceUpdates.map((v) => v.status).sort()).toEqual([
		'failed',
		'needs-review',
	]);
	await expectAxeClean(reopened);
});
