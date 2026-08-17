import { readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { getViolations, injectAxe } from 'axe-playwright';

let authentication = 0;
const playableRaceVideo = readFileSync(
	new URL('./support/race-video.mp4', import.meta.url),
);

const authenticateOwner = async (page: Page): Promise<void> => {
	authentication += 1;
	const clientIp = `drive-sessions-owner-${authentication}`;
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

const createCar = async (page: Page, name: string) => {
	const response = await page.request.post('/api/v1/cars', {
		data: { name, make: 'Test make', model: 'Test model' },
	});
	expect(response.ok()).toBe(true);
	return (await response.json()) as { car: { id: string } };
};

const scan = async (page: Page) => {
	await injectAxe(page);
	return getViolations(page);
};

test('keeps light Drive session entry usable with large text on a narrow phone', async ({
	page,
}) => {
	await page.setViewportSize({ width: 320, height: 720 });
	await page.addInitScript(() => {
		localStorage.setItem('rc-mech.appearance', 'light');
	});
	await authenticateOwner(page);
	const created = await createCar(page, 'Drive session browser fixture');

	await page.goto(`/garage/${created.car.id}/drive-sessions`);
	await expect(page.locator('html')).toHaveAttribute(
		'data-appearance',
		'light',
	);
	await expect(
		page.getByRole('heading', { name: 'Drive sessions', exact: true }),
	).toBeVisible();
	await page.addStyleTag({ content: ':root { font-size: 200%; }' });
	await page
		.getByRole('button', { name: 'Record the first drive session' })
		.click();
	await expect(
		page.getByRole('heading', { name: 'Record a drive session' }),
	).toBeFocused();
	const formSize = await page.locator('form').evaluate((form) => ({
		clientWidth: form.clientWidth,
		scrollWidth: form.scrollWidth,
	}));
	expect(formSize.scrollWidth).toBe(formSize.clientWidth);

	const started = page.getByLabel('Started');
	const duration = page.getByLabel('Duration (minutes)');
	await expect(started).toHaveAttribute(
		'aria-describedby',
		'drive-session-started-help',
	);
	await expect(duration).toHaveAttribute(
		'aria-describedby',
		'drive-session-duration-help',
	);
	await started.fill('');
	await duration.fill('2000');
	await page.getByRole('button', { name: 'Save session' }).click();
	await expect(started).toBeFocused();
	await expect(started).toHaveAttribute(
		'aria-describedby',
		'drive-session-started-error',
	);
	await expect(page.locator('#drive-session-started-error')).toHaveText(
		'Add when this drive session started.',
	);
	await expect(page.locator('#drive-session-form-error')).toContainText(
		'Review the highlighted drive session fields.',
	);
	expect(
		await page
			.getByRole('button', { name: 'Save session' })
			.evaluate((button) => button.getBoundingClientRect().height),
	).toBeGreaterThanOrEqual(48);
	expect(await scan(page)).toEqual([]);

	const longConditions = 'UnbrokenDriveSessionCondition'.repeat(4);
	await started.fill('2026-08-08T10:15');
	await duration.fill('45');
	await page.getByLabel('Conditions').fill(longConditions);
	await page
		.getByLabel('Notes')
		.fill('Recorded through the focused Drive session browser workflow.');
	await page.getByRole('button', { name: 'Save session' }).click();
	await expect(
		page.getByRole('status').filter({ hasText: 'Drive session recorded.' }),
	).toBeVisible();
	await expect(
		page.getByRole('heading', { name: 'Drive sessions', exact: true }),
	).toBeFocused();
	await expect(page.getByText(longConditions)).toBeVisible();
	await expect(page.getByText('45 min')).toBeVisible();

	const workspaceSize = await page
		.locator('.session-log')
		.evaluate((workspace) => ({
			clientWidth: workspace.clientWidth,
			scrollWidth: workspace.scrollWidth,
		}));
	expect(workspaceSize.scrollWidth).toBe(workspaceSize.clientWidth);
	expect(await scan(page)).toEqual([]);
});

test('keeps dark Drive session editing, history, and archive states accessible', async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.addInitScript(() => {
		localStorage.setItem('rc-mech.appearance', 'dark');
	});
	await authenticateOwner(page);
	const created = await createCar(page, 'Drive session archive fixture');
	const longConditions = 'DarkUnbrokenDriveSessionCondition'.repeat(4);
	const driveSession = await page.request.post(
		`/api/v1/cars/${created.car.id}/drives`,
		{
			data: {
				startedAt: '2026-08-08T18:00:00.000Z',
				durationMinutes: 20,
				conditions: longConditions,
				notes: 'Original dark Drive session note with large-text coverage.',
			},
		},
	);
	expect(driveSession.ok()).toBe(true);

	await page.goto(`/garage/${created.car.id}/drive-sessions`);
	await expect(page.locator('html')).toHaveAttribute('data-appearance', 'dark');
	await page.addStyleTag({ content: ':root { font-size: 200%; }' });
	await expect(page.getByText(longConditions)).toBeVisible();
	const workspaceSize = await page
		.locator('.session-log')
		.evaluate((workspace) => ({
			clientWidth: workspace.clientWidth,
			scrollWidth: workspace.scrollWidth,
		}));
	expect(workspaceSize.scrollWidth).toBe(workspaceSize.clientWidth);
	await expect(
		page.getByRole('group', { name: 'Drive session 1 actions' }),
	).toBeVisible();
	await page.getByRole('button', { name: 'Edit drive session 1' }).click();
	await expect(
		page.getByRole('heading', { name: 'Edit drive session' }),
	).toBeFocused();
	await page
		.getByLabel('Notes')
		.fill('Updated through the Alloy Drive session workflow.');
	await page.getByRole('button', { name: 'Save session' }).click();
	await expect(
		page.getByRole('status').filter({ hasText: 'Drive session updated.' }),
	).toBeVisible();
	await expect(
		page.getByRole('heading', { name: 'Drive sessions', exact: true }),
	).toBeFocused();
	await expect(
		page.getByText('Updated through the Alloy Drive session workflow.'),
	).toBeVisible();
	await page.getByRole('button', { name: 'Archive drive session 1' }).click();
	await expect(page.getByText('0 recorded')).toBeVisible();
	await expect(page.getByText('Archived drive session')).toBeVisible();
	await expect(
		page.getByRole('group', { name: /Drive session .* actions/ }),
	).toHaveCount(0);
	expect(await scan(page)).toEqual([]);

	const archiveCar = await page.request.post(
		`/api/v1/cars/${created.car.id}/archive`,
	);
	expect(archiveCar.ok()).toBe(true);
	await page.reload();
	await expect(
		page.getByText(
			'This car is archived. Its history is available, but changes are disabled until it is restored.',
		),
	).toBeVisible();
	await expect(
		page.getByRole('button', { name: 'Record a drive session' }),
	).toHaveCount(0);
	await expect(
		page.getByRole('group', { name: /Drive session .* actions/ }),
	).toHaveCount(0);
	expect(await scan(page)).toEqual([]);
});

test('resumes a Race recording from authoritative multipart progress without retransmitting completed parts', async ({
	page,
}) => {
	await authenticateOwner(page);
	const created = await createCar(page, 'Race recording recovery fixture');
	const driveResponse = await page.request.post(
		`/api/v1/cars/${created.car.id}/drives`,
		{
			data: {
				startedAt: '2026-08-16T18:00:00.000Z',
				durationMinutes: 20,
				conditions: 'Dry',
			},
		},
	);
	expect(driveResponse.ok()).toBe(true);
	const driveBody = (await driveResponse.json()) as {
		driveSession: { id: string };
	};
	const uploadUrl = `/api/v1/cars/${created.car.id}/drives/${driveBody.driveSession.id}/race-videos`;
	const displaySize = playableRaceVideo.length.toLocaleString();
	const createResponse = await page.request.post(uploadUrl, {
		data: {
			fileName: 'Final.mp4',
			contentType: 'video/mp4',
			sizeBytes: playableRaceVideo.length,
			requestId: '00000000-0000-4000-8000-000000000234',
		},
	});
	expect(createResponse.status()).toBe(201);
	const createdRecording = (await createResponse.json()) as {
		raceVideo: { id: string };
	};
	const recordingId = createdRecording.raceVideo.id;
	const seededPart = await page.request.put(
		`/api/v1/race-videos/${recordingId}/upload-parts/1`,
		{
			headers: {
				'content-length': String(playableRaceVideo.length),
				'content-type': 'application/octet-stream',
				'x-transfer-request-id': 'browser-seeded-part-1',
			},
			data: playableRaceVideo,
		},
	);
	expect(seededPart.ok()).toBe(true);
	let browserPartRequests = 0;
	page.on('request', (request) => {
		if (
			request.method() === 'PUT' &&
			request.url().includes(`/api/v1/race-videos/${recordingId}/upload-parts/`)
		)
			browserPartRequests += 1;
	});
	await page.goto(`/garage/${created.car.id}/drive-sessions`);
	await expect(
		page.getByText(`Final.mp4 · ${displaySize} bytes`),
	).toBeVisible();
	await expect(page.getByText('Upload paused')).toBeVisible();
	await expect(page.getByRole('progressbar')).toHaveAttribute('value', '100');
	await page.locator('input[type="file"]').setInputFiles({
		name: 'Final.mp4',
		mimeType: 'video/mp4',
		buffer: playableRaceVideo,
	});
	await expect(page.getByText('Validating recording…')).toBeVisible();
	expect(browserPartRequests).toBe(0);
	expect(await scan(page)).toEqual([]);

	const validationResponse = await page.request.get(
		`/api/v1/race-videos/${recordingId}`,
	);
	const validationBody = (await validationResponse.json()) as {
		raceVideo: Record<string, unknown>;
	};
	const collectionUrl = `**/api/v1/cars/${created.car.id}/race-videos`;
	await page.route(collectionUrl, (route) =>
		route.fulfill({
			status: 200,
			json: {
				raceVideos: [
					{
						...validationBody.raceVideo,
						status: 'ready',
						validationStateVersion: 2,
						media: {
							byteCount: playableRaceVideo.length,
							durationMs: 1000,
							width: 160,
							height: 90,
							videoCodec: 'h264',
							audioCodecs: [],
							containerFormats: ['mp4'],
							decodedFrameCount: 10,
							averageFrameRate: { numerator: 10, denominator: 1 },
							timeBase: { numerator: 1, denominator: 10240 },
							sampleAspectRatio: { numerator: 1, denominator: 1 },
							displayAspectRatio: { numerator: 16, denominator: 9 },
							startTimeMs: 0,
							checksumSha256: 'a'.repeat(64),
						},
						validationError: null,
						validatedAt: '2026-08-16T18:01:00.000Z',
						playbackUrl: `/api/v1/race-videos/${recordingId}/content`,
					},
				],
			},
		}),
	);
	const mediaRangeRequests: string[] = [];
	await page.route(`**/api/v1/race-videos/${recordingId}/content`, (route) => {
		const range = route.request().headers()['range'];
		const match = range ? /^bytes=(\d+)-(\d*)$/.exec(range) : null;
		const start = match ? Number(match[1]) : 0;
		const requestedEnd = match?.[2] ? Number(match[2]) : null;
		const end = Math.min(
			requestedEnd ?? playableRaceVideo.length - 1,
			playableRaceVideo.length - 1,
		);
		if (range) mediaRangeRequests.push(range);
		return route.fulfill({
			status: match ? 206 : 200,
			headers: {
				'accept-ranges': 'bytes',
				'content-length': String(end - start + 1),
				'content-type': 'video/mp4',
				...(match
					? {
							'content-range': `bytes ${start}-${end}/${playableRaceVideo.length}`,
						}
					: {}),
			},
			body: playableRaceVideo.subarray(start, end + 1),
		});
	});
	await page.reload();
	const completedSection = page.locator(
		`section[aria-labelledby="race-recording-title-${driveBody.driveSession.id}"]`,
	);
	await expect(
		completedSection.getByText(`Final.mp4 · ${displaySize} bytes`),
	).toBeVisible();
	await expect(completedSection.getByText('Ready for analysis')).toBeVisible();
	const player = completedSection.locator('video');
	await expect(player).toHaveAttribute(
		'src',
		`/api/v1/race-videos/${recordingId}/content`,
	);
	await expect(player).toHaveAttribute('controls', '');
	await expect(player).toHaveAttribute('preload', 'metadata');
	const playback = await player.evaluate(async (video: HTMLVideoElement) => {
		if (video.readyState < HTMLMediaElement.HAVE_METADATA)
			await new Promise<void>((resolve, reject) => {
				const timeout = window.setTimeout(
					() => reject(new Error('Video metadata timed out')),
					5_000,
				);
				video.addEventListener(
					'loadedmetadata',
					() => {
						window.clearTimeout(timeout);
						resolve();
					},
					{ once: true },
				);
			});
		video.muted = true;
		await video.play();
		const played = !video.paused;
		video.pause();
		const target = Math.min(0.5, video.duration / 2);
		await new Promise<void>((resolve, reject) => {
			const timeout = window.setTimeout(
				() => reject(new Error('Video seek timed out')),
				5_000,
			);
			video.addEventListener(
				'seeked',
				() => {
					window.clearTimeout(timeout);
					resolve();
				},
				{ once: true },
			);
			video.currentTime = target;
		});
		return {
			played,
			paused: video.paused,
			currentTime: video.currentTime,
			duration: video.duration,
		};
	});
	expect(playback.played).toBe(true);
	expect(playback.paused).toBe(true);
	expect(playback.currentTime).toBeGreaterThan(0);
	expect(playback.currentTime).toBeLessThanOrEqual(playback.duration);
	expect(mediaRangeRequests.some((range) => range.startsWith('bytes='))).toBe(
		true,
	);
	expect(await scan(page)).toEqual([]);
	await page.unroute(collectionUrl);
	await completedSection
		.getByRole('button', { name: 'Delete recording permanently' })
		.click();
	await expect(
		completedSection.getByText(`Final.mp4 · ${displaySize} bytes`),
	).toHaveCount(0);
	await expect(completedSection.locator('input[type="file"]')).toBeFocused();

	const cancellableDrive = await page.request.post(
		`/api/v1/cars/${created.car.id}/drives`,
		{
			data: {
				startedAt: '2026-08-16T18:30:00.000Z',
				durationMinutes: 20,
				conditions: 'Dry',
			},
		},
	);
	const cancellableDriveBody = (await cancellableDrive.json()) as {
		driveSession: { id: string };
	};
	const cancellableUrl = `/api/v1/cars/${created.car.id}/drives/${cancellableDriveBody.driveSession.id}/race-videos`;
	const cancellable = await page.request.post(cancellableUrl, {
		data: {
			fileName: 'Cancel.mp4',
			contentType: 'video/mp4',
			sizeBytes: 3,
			requestId: '00000000-0000-4000-8000-000000000235',
		},
	});
	expect(cancellable.status()).toBe(201);
	await page.reload();
	const cancellableSection = page.locator(
		`section[aria-labelledby="race-recording-title-${cancellableDriveBody.driveSession.id}"]`,
	);
	await expect(
		cancellableSection.getByText('Cancel.mp4 · 3 bytes'),
	).toBeVisible();
	await cancellableSection
		.getByRole('button', { name: 'Cancel upload' })
		.click();
	await expect(
		cancellableSection.getByText('Cancel.mp4 · 3 bytes'),
	).toHaveCount(0);
	await expect(cancellableSection.locator('input[type="file"]')).toBeFocused();

	await page.route(`**${cancellableUrl}`, (route) =>
		route.fulfill({
			status: 503,
			json: { error: 'Private media storage is unavailable' },
		}),
	);
	await cancellableSection.locator('input[type="file"]').setInputFiles({
		name: 'Retry.mp4',
		mimeType: 'video/mp4',
		buffer: Buffer.from('abc'),
	});
	await expect(page.getByText('Upload stopped')).toBeVisible();
	await expect(
		page.getByText('Private media storage is unavailable'),
	).toBeVisible();
	expect(await scan(page)).toEqual([]);
});
