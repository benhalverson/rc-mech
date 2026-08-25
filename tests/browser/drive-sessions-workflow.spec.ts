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

const createApprovedTrackMap = async (
	page: Page,
	name: string,
	raceVideoId: string,
) => {
	const layoutResponse = await page.request.post('/api/v1/track-layouts', {
		data: { name },
	});
	expect(layoutResponse.status()).toBe(201);
	const layout = (await layoutResponse.json()) as {
		trackLayout: { id: string };
	};
	const draftResponse = await page.request.post(
		`/api/v1/track-layouts/${layout.trackLayout.id}/map-versions`,
		{ data: {} },
	);
	expect(draftResponse.status()).toBe(201);
	const draft = (await draftResponse.json()) as {
		trackMapVersion: { id: string; stateVersion: number };
	};
	const frameResponse = await page.request.post(
		`/api/v1/track-map-versions/${draft.trackMapVersion.id}/reference-frame`,
		{ data: { raceVideoId, timestampMs: 250 } },
	);
	expect(frameResponse.status()).toBe(201);
	const geometryResponse = await page.request.patch(
		`/api/v1/track-map-versions/${draft.trackMapVersion.id}`,
		{
			data: {
				expectedStateVersion: draft.trackMapVersion.stateVersion,
				corners: [
					{
						key: 'browser-turn',
						name: 'Browser turn',
						order: 1,
						entryGate: {
							start: { x: 0.2, y: 0.7 },
							end: { x: 0.35, y: 0.6 },
							direction: 'forward',
						},
						exitGate: {
							start: { x: 0.5, y: 0.4 },
							end: { x: 0.6, y: 0.5 },
							direction: 'forward',
						},
						cornerView: { x: 0.15, y: 0.3, width: 0.5, height: 0.4 },
					},
				],
			},
		},
	);
	expect(geometryResponse.ok()).toBe(true);
	const geometry = (await geometryResponse.json()) as {
		trackMapVersion: { stateVersion: number };
	};
	const approvalResponse = await page.request.post(
		`/api/v1/track-map-versions/${draft.trackMapVersion.id}/approve`,
		{ data: { expectedStateVersion: geometry.trackMapVersion.stateVersion } },
	);
	expect(approvalResponse.ok()).toBe(true);
	return { id: draft.trackMapVersion.id, name };
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

test('creates a queued Driving analysis from a ready private Race recording', async ({
	page,
}) => {
	await authenticateOwner(page);
	const created = await createCar(page, 'Driving analysis browser fixture');
	const driveResponse = await page.request.post(
		`/api/v1/cars/${created.car.id}/drives`,
		{
			data: {
				startedAt: '2026-08-17T18:00:00.000Z',
				durationMinutes: 10,
				conditions: 'Dry',
			},
		},
	);
	expect(driveResponse.ok()).toBe(true);
	const drive = (await driveResponse.json()) as {
		driveSession: { id: string };
	};
	const collectionUrl = `/api/v1/cars/${created.car.id}/drives/${drive.driveSession.id}/race-videos`;
	const createResponse = await page.request.post(collectionUrl, {
		data: {
			fileName: 'Analysis.mp4',
			contentType: 'video/mp4',
			sizeBytes: playableRaceVideo.length,
			requestId: '00000000-0000-4000-8000-000000000236',
		},
	});
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
				'x-transfer-request-id': 'analysis-browser-part-1',
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
	const trackMap = await createApprovedTrackMap(
		page,
		'Analysis browser circuit',
		recording.raceVideo.id,
	);

	await page.goto(`/garage/${created.car.id}/drive-sessions`);
	const section = page.locator(
		`section[aria-labelledby="race-recording-title-${drive.driveSession.id}"]`,
	);
	await expect(section.getByText('Ready for analysis')).toBeVisible();
	const creator = section.locator('app-driving-analysis-creator');
	const mapSelector = creator.getByLabel('Approved Track map');
	await mapSelector.selectOption(trackMap.id);
	await expect(mapSelector).toHaveValue(trackMap.id);
	await expect(
		creator.getByText(`Immutable approved version 1 for ${trackMap.name}`, {
			exact: false,
		}),
	).toBeVisible();
	await creator
		.locator('summary', { hasText: 'Inspect immutable Track-map geometry' })
		.click();
	await expect(
		creator.getByRole('img', {
			name: `Approved geometry for ${trackMap.name} version 1`,
		}),
	).toBeVisible();
	const playback = creator.getByRole('button', {
		name: 'Play private Race recording',
	});
	await playback.click();
	await expect(
		creator.getByRole('button', { name: 'Pause private Race recording' }),
	).toBeVisible();
	await creator
		.getByRole('button', { name: 'Pause private Race recording' })
		.click();
	await creator.getByLabel('Race start').fill('100');
	await creator.getByLabel('Race end').fill('900');
	await creator.getByLabel('Subject timestamp (ms)').fill('500');
	await creator.getByLabel('Source frame index').fill('5');
	await creator.getByLabel('Subject identity').fill('car-44');
	const subjectBox = creator.locator('[data-subject-box]');
	const surface = creator.locator('[data-box-surface]');
	const surfaceBounds = await surface.boundingBox();
	if (!surfaceBounds) throw new Error('Subject-box surface bounds missing');
	const pointerStart = {
		x: surfaceBounds.x + surfaceBounds.width * 0.237,
		y: surfaceBounds.y + surfaceBounds.height * 0.183,
	};
	const pointerEnd = {
		x: surfaceBounds.x + surfaceBounds.width * 0.688,
		y: surfaceBounds.y + surfaceBounds.height * 0.516,
	};
	await page.mouse.move(pointerStart.x, pointerStart.y);
	await page.mouse.down();
	await page.mouse.move(pointerEnd.x, pointerEnd.y);
	await page.mouse.up();
	await creator.getByLabel('Width').fill('');
	await expect(
		creator.getByText('Enter all four normalized Subject-box coordinates.'),
	).toBeVisible();
	await creator.getByLabel('Width').fill('0.12');
	const normalizedBox = {
		x: Number(await creator.locator('[data-box-x]').inputValue()),
		y: Number(await creator.locator('[data-box-y]').inputValue()),
		width: Number(await creator.locator('[data-box-width]').inputValue()),
		height: Number(await creator.locator('[data-box-height]').inputValue()),
	};
	await expect(subjectBox).toHaveAttribute(
		'aria-label',
		new RegExp(`${normalizedBox.x * 100}% from the left`),
	);
	const invalidControls = await creator.locator('form').evaluate((form) =>
		Array.from((form as HTMLFormElement).elements)
			.filter((control) => !(control as HTMLInputElement).checkValidity())
			.map((control) => ({
				name: (control as HTMLInputElement).name,
				message: (control as HTMLInputElement).validationMessage,
			})),
	);
	expect(invalidControls).toEqual([]);

	const requestPromise = page.waitForRequest(
		(request) =>
			request.method() === 'POST' &&
			request
				.url()
				.endsWith(
					`/api/v1/cars/${created.car.id}/drives/${drive.driveSession.id}/driving-analyses`,
				),
	);
	const responsePromise = page.waitForResponse(
		(response) =>
			response.request().method() === 'POST' &&
			response
				.url()
				.endsWith(
					`/api/v1/cars/${created.car.id}/drives/${drive.driveSession.id}/driving-analyses`,
				),
	);
	await creator.getByRole('button', { name: 'Start analysis' }).click();
	const analysisRequest = await requestPromise;
	expect(analysisRequest.postDataJSON()).toMatchObject({
		raceVideoId: recording.raceVideo.id,
		approvedTrackMapVersionId: trackMap.id,
		raceWindow: { startTimestampMs: 100, endTimestampMs: 900 },
		subjectSeed: {
			timestampMs: 500,
			frameIndex: 5,
			identity: 'car-44',
			box: normalizedBox,
		},
	});
	expect((await responsePromise).status()).toBe(202);
	await expect(creator.getByText('Analysis queued')).toBeVisible();
	await expect(creator.getByText('Preparation · 0%')).toBeVisible();
	await creator.getByRole('button', { name: 'Check status' }).click();
	await expect(creator.getByText('Preparation · 0%')).toBeVisible();
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
	await expect(page.getByText('Ready for analysis')).toBeVisible();
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
	await expect(
		completedSection.getByRole('button', {
			name: 'Play private Race recording',
		}),
	).toBeVisible();
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
