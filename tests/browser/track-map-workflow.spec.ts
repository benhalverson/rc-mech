import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { getViolations, injectAxe } from 'axe-playwright';

let authentication = 0;
const playableRaceVideo = readFileSync(
	new URL('./support/race-video.mp4', import.meta.url),
);
const browserClientPort = Number(
	process.env['RC_MECH_BROWSER_CLIENT_PORT'] ?? 4201,
);
const baseURL = `http://127.0.0.1:${browserClientPort}`;

const authenticateOwner = async (page: Page): Promise<void> => {
	authentication += 1;
	const clientIp = `track-map-owner-${authentication}`;
	await page.setExtraHTTPHeaders({ 'CF-Connecting-IP': clientIp });
	const request = await page.request.post('/api/auth/sign-in/magic-link', {
		headers: { 'CF-Connecting-IP': clientIp },
		data: { email: 'owner@example.com', callbackURL: '/track-maps' },
	});
	expect(request.ok()).toBe(true);
	const verification = await page.request.get(
		'/api/auth/magic-link/verify?token=local-test-token&callbackURL=%2Ftrack-maps',
		{ headers: { 'CF-Connecting-IP': clientIp }, maxRedirects: 0 },
	);
	expect([302, 303]).toContain(verification.status());
};

const scan = async (page: Page) => {
	await injectAxe(page);
	return getViolations(page);
};

const createReadyRaceRecording = async (page: Page): Promise<string> => {
	const carResponse = await page.request.post('/api/v1/cars', {
		data: {
			name: 'Track map reference recording fixture',
			make: 'Test make',
			model: 'Test model',
		},
	});
	expect(carResponse.status()).toBe(201);
	const car = (await carResponse.json()) as { car: { id: string } };
	const driveResponse = await page.request.post(
		`/api/v1/cars/${car.car.id}/drives`,
		{
			data: {
				startedAt: '2026-08-17T18:00:00.000Z',
				durationMinutes: 10,
				conditions: 'Dry',
			},
		},
	);
	expect(driveResponse.status()).toBe(201);
	const drive = (await driveResponse.json()) as {
		driveSession: { id: string };
	};
	const createResponse = await page.request.post(
		`/api/v1/cars/${car.car.id}/drives/${drive.driveSession.id}/race-videos`,
		{
			data: {
				fileName: 'Track-map-reference.mp4',
				contentType: 'video/mp4',
				sizeBytes: playableRaceVideo.length,
				requestId: '00000000-0000-4000-8000-000000000237',
			},
		},
	);
	expect(createResponse.status()).toBe(201);
	const recording = (await createResponse.json()) as {
		raceVideo: { id: string };
	};
	const partResponse = await page.request.put(
		`/api/v1/race-videos/${recording.raceVideo.id}/upload-parts/1`,
		{
			headers: {
				'content-length': String(playableRaceVideo.length),
				'content-type': 'application/octet-stream',
				'x-transfer-request-id': 'track-map-browser-part-1',
			},
			data: playableRaceVideo,
		},
	);
	expect(partResponse.ok()).toBe(true);
	const completionResponse = await page.request.post(
		`/api/v1/race-videos/${recording.raceVideo.id}/complete`,
	);
	expect(completionResponse.ok()).toBe(true);
	expect(await completionResponse.json()).toMatchObject({
		raceVideo: { status: 'ready' },
	});
	return recording.raceVideo.id;
};

const registerUser = async (
	page: Page,
	email: string,
	inviteCode: string,
): Promise<void> => {
	await page.setExtraHTTPHeaders({
		'CF-Connecting-IP': `track-map-user-${authentication}`,
	});
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
	await page.goto(
		'/api/auth/magic-link/verify?token=local-test-token&callbackURL=%2Ftrack-maps',
	);
	await expect(page.getByRole('heading', { name: 'Track maps' })).toBeVisible();
};

test('approves, reuses, and retires immutable Track maps with private draft controls', async ({
	page,
	browser,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await authenticateOwner(page);
	const recordingId = await createReadyRaceRecording(page);
	await page.goto('/track-maps');
	await expect(page.getByRole('heading', { name: 'Track maps' })).toBeVisible();
	expect(await scan(page)).toEqual([]);

	await page.getByLabel('New layout').fill('Browser circuit');
	await page.getByRole('button', { name: 'Create' }).click();
	const layout = page.getByRole('button', { name: /Browser circuit/ });
	await expect(layout).toBeVisible();
	await layout.click();
	await page.getByRole('button', { name: 'Blank draft' }).click();
	await expect(
		page.getByText('Create draft saved.', { exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole('heading', {
			name: 'Anchor the geometry to one race frame',
		}),
	).toBeVisible();
	await page.getByLabel('Validated Race recording').selectOption(recordingId);
	await page.getByLabel('Timestamp in milliseconds').fill('250');
	await page.getByRole('button', { name: 'Use this frame' }).click();
	await expect(
		page.getByText('Select frame saved.', { exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole('img', {
			name: 'Selected private Race recording reference frame',
		}),
	).toBeVisible();

	await page.getByRole('button', { name: 'Add corner' }).click();
	await page.getByLabel('Name', { exact: true }).fill('Hairpin');
	await page.getByLabel('Stable key').fill('hairpin');
	await page.getByLabel('X', { exact: true }).fill('0.24');
	await page.getByLabel('Y', { exact: true }).fill('0.66');
	await page.getByLabel('View X').fill('0.12');
	await page.getByLabel('View Y').fill('0.32');
	await page.getByLabel('Width').fill('0.42');
	await page.getByLabel('Height').fill('0.36');
	await page.getByLabel('Entry').selectOption('reverse');
	await page.getByLabel('Exit').selectOption('forward');
	await page.getByLabel('View X').fill('1.2');
	await expect(page.getByRole('alert')).toContainText(
		'Corner view must be a positive rectangle inside the Track view.',
	);
	expect(await scan(page)).toEqual([]);
	await page.getByLabel('View X').fill('0.12');
	const cornerName = page.getByLabel('Name', { exact: true });
	await expect(cornerName).toHaveValue('Hairpin');
	const canvas = page.getByRole('button', {
		name: /Track-view geometry editor/,
	});
	await canvas.focus();
	await expect(cornerName).toHaveValue('Hairpin');
	await canvas.press('ArrowRight');
	await expect(cornerName).toHaveValue('Hairpin');
	await canvas.click({ position: { x: 120, y: 60 } });
	await expect(cornerName).toHaveValue('Hairpin');
	await page
		.getByLabel('Geometry target', { exact: true })
		.selectOption('viewPosition');
	await canvas.press('ArrowRight');
	await page
		.getByLabel('Geometry target', { exact: true })
		.selectOption('viewSize');
	await canvas.press('ArrowLeft');
	await page.getByRole('button', { name: 'Save draft', exact: true }).click();
	await expect(
		page.getByText('Save draft saved.', { exact: true }),
	).toBeVisible();
	expect(await scan(page)).toEqual([]);

	await page.reload();
	await page.getByRole('button', { name: /Browser circuit/ }).click();
	await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Hairpin');
	await expect(page.getByLabel('Entry')).toHaveValue('reverse');
	await expect(page.getByLabel('Exit')).toHaveValue('forward');
	await expect(page.getByLabel('View X')).toHaveValue('0.1225');
	await expect(page.getByLabel('View Y')).toHaveValue('0.32');
	await expect(page.getByLabel('Width')).toHaveValue('0.4175');
	await expect(page.getByLabel('Height')).toHaveValue('0.36');
	await page.getByRole('button', { name: 'Approve version 1' }).click();
	await expect(
		page.getByText('Approve map saved.', { exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole('heading', { name: 'Version 1 review' }),
	).toBeVisible();
	await expect(page.getByText('Entry · reverse')).toBeVisible();
	await expect(
		page.getByText(/x 0\.1225, y 0\.32, w 0\.4175, h 0\.36/),
	).toBeVisible();
	expect(await scan(page)).toEqual([]);

	await page.getByRole('button', { name: 'Edit as new draft' }).click();
	await expect(
		page.getByText('Create draft saved.', { exact: true }),
	).toBeVisible();
	await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Hairpin');
	await expect(page.getByLabel('Entry')).toHaveValue('reverse');
	await expect(page.getByLabel('View X')).toHaveValue('0.1225');

	const inviteCode = `MAPUSER-${Date.now().toString(36).toUpperCase()}`;
	const invite = await page.request.post('/api/v1/invite-codes', {
		data: { code: inviteCode },
	});
	expect(invite.status()).toBe(201);
	const userContext = await browser.newContext({ baseURL });
	const userPage = await userContext.newPage();
	await registerUser(
		userPage,
		`map-user-${Date.now()}@example.com`,
		inviteCode,
	);
	const userLayout = userPage.getByRole('button', { name: /Browser circuit/ });
	await expect(userLayout).toBeVisible();
	await userLayout.click();
	await expect(
		userPage.getByRole('heading', { name: 'Version 1 review' }),
	).toBeVisible();
	await expect(userPage.getByText('Entry · reverse')).toBeVisible();
	await expect(
		userPage.getByRole('button', { name: 'Blank draft' }),
	).toHaveCount(0);
	await expect(
		userPage.getByRole('button', { name: 'Edit as new draft' }),
	).toHaveCount(0);
	expect(await scan(userPage)).toEqual([]);

	await page.getByRole('button', { name: /Version 1.*approved/i }).click();
	await page.getByRole('button', { name: 'Retire version 1' }).click();
	await expect(
		page.getByText('Retire map saved.', { exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole('heading', { name: 'Version 1 review' }),
	).toBeVisible();
	await userPage.reload();
	await expect(userLayout).toHaveCount(0);
	await expect(userPage.getByText('Choose a layout to begin')).toBeVisible();
	await userContext.close();

	await page.getByLabel('Layout name').fill('Browser circuit revised');
	await page.getByRole('button', { name: 'Rename' }).click();
	await expect(
		page.getByText('Rename layout saved.', { exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole('button', { name: /Browser circuit revised/ }),
	).toBeVisible();

	await page.getByRole('button', { name: 'Retire layout' }).click();
	await expect(page.getByText('Choose a layout to begin')).toBeVisible();
	await expect(
		page.getByRole('button', { name: /Browser circuit revised.*retired/i }),
	).toBeVisible();
	await page
		.getByRole('button', { name: /Browser circuit revised.*retired/i })
		.click();
	await expect(
		page.getByText('Retired Track layouts are read-only.'),
	).toBeVisible();
	await expect(page.getByRole('button', { name: 'Blank draft' })).toHaveCount(
		0,
	);
	expect(await scan(page)).toEqual([]);
});
