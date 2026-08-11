import { expect, type Page, test } from '@playwright/test';
import { getViolations, injectAxe } from 'axe-playwright';

let authentication = 0;

const authenticateOwner = async (page: Page): Promise<void> => {
	authentication += 1;
	const clientIp = `voice-recording-owner-${authentication}`;
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
		data: { name, make: 'Test', model: '1' },
	});
	expect(response.ok()).toBe(true);
	return (await response.json()) as { car: { id: string } };
};

test('places voice capture after the empty current setup on the selected car', async ({
	page,
}) => {
	await authenticateOwner(page);
	const created = await createCar(page, 'Voice surface regression buggy');
	await page.goto(`/garage/${created.car.id}/overview`);
	await expect(
		page.getByRole('heading', { name: 'No current setup' }),
	).toBeVisible();
	await expect(
		page.getByRole('heading', { name: 'Voice note', exact: true }),
	).toBeVisible();
	expect(
		await page.locator('app-current-setup').evaluate((setup) => {
			const voice = document.querySelector('app-voice-note-workspace');
			return Boolean(
				voice &&
					setup.compareDocumentPosition(voice) &
						Node.DOCUMENT_POSITION_FOLLOWING,
			);
		}),
	).toBe(true);
});

test('captures and reviews one finalized voice note on the selected-car screen', async ({
	page,
}) => {
	let voiceBytes: Buffer | undefined;

	await page.addInitScript(() => {
		const mediaDevices = navigator.mediaDevices;
		mediaDevices.getUserMedia = async () => {
			const context = new AudioContext();
			await context.resume();
			const destination = context.createMediaStreamDestination();
			const oscillator = context.createOscillator();
			oscillator.frequency.value = 440;
			oscillator.connect(destination);
			oscillator.start();
			return destination.stream;
		};
	});

	await authenticateOwner(page);
	const created = await createCar(page, 'Voice regression buggy');

	const update = {
		id: 'voice-browser-regression',
		carId: created.car.id,
		driveSessionId: null,
		status: 'pending',
		contentType: 'audio/webm',
		fileName: 'voice.webm',
		byteSize: 1,
		audioUrl: null,
		transcript: null,
		draft: null,
		corrections: [],
		clarificationPrompt: null,
		error: null,
		confirmedAt: null,
		artifactDeletedAt: null,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		results: [],
	};
	const reviewedUpdate = {
		...update,
		status: 'needs-review',
		transcript: 'I changed rear shock oil from 30 wt to 35 wt.',
		draft: {
			setupChanges: [
				{
					section: 'shocks',
					field: 'rearOil',
					value: '35 wt',
					confidence: 'high',
					needsReview: false,
					sourceText: 'changed rear shock oil from 30 wt to 35 wt',
				},
			],
			problems: [],
			conditions: [],
			driveSessionNotes: [],
			consumables: [],
			unmappedNotes: [],
			unresolvedNotes: [],
		},
	};
	await page.route('**/api/v1/cars/*/voice-updates', async (route) => {
		if (route.request().method() !== 'POST') return route.continue();
		const request = route.request();
		const contentType = request.headers()['content-type'] ?? '';
		const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
		const body = request.postDataBuffer();
		const fileHeader = body?.indexOf(Buffer.from('name="file"')) ?? -1;
		const dataStart = body?.indexOf(Buffer.from('\r\n\r\n'), fileHeader) ?? -1;
		const boundaryValue = boundary?.[1] ?? boundary?.[2];
		const dataEnd =
			body && boundaryValue
				? body.indexOf(Buffer.from(`\r\n--${boundaryValue}`), dataStart + 4)
				: -1;
		if (body && fileHeader >= 0 && dataStart >= 0 && dataEnd > dataStart)
			voiceBytes = body.subarray(dataStart + 4, dataEnd);
		await route.fulfill({ json: { voiceUpdate: update } });
	});
	await page.route('**/api/v1/voice-updates/*/process', async (route) => {
		await route.fulfill({ json: { voiceUpdate: reviewedUpdate } });
	});
	await page.route('**/api/v1/voice-updates/*/confirm', async (route) => {
		await route.fulfill({
			json: { voiceUpdate: { ...reviewedUpdate, status: 'saved' } },
		});
	});

	await page.goto(`/garage/${created.car.id}/overview`);
	await expect(
		page.getByRole('heading', { name: 'Voice note', exact: true }),
	).toBeVisible();
	await page.getByRole('button', { name: 'Start voice note' }).click();
	await expect(page.getByText('Speak to test the microphone')).toBeVisible();
	await expect(page.getByText('Audio detected')).toBeVisible({
		timeout: 5_000,
	});
	await page.waitForTimeout(1_000);
	await page.getByRole('button', { name: 'Stop and keep recording' }).click();
	await expect(
		page.getByRole('heading', { name: 'Review this voice note' }),
	).toBeVisible();
	await expect(page.getByLabel('Transcript')).toContainText(
		'I changed rear shock oil from 30 wt to 35 wt.',
	);
	await expect(page.getByLabel('Proposed garage records')).toContainText(
		'Proposed Setup change',
	);
	await expect(
		page.getByRole('button', { name: 'Confirm and save' }),
	).toBeVisible();
	await injectAxe(page);
	expect(await getViolations(page)).toEqual([]);

	await expect.poll(() => Boolean(voiceBytes)).toBe(true);
	if (!voiceBytes) throw new Error('No captured upload');
	const decoded = await page.evaluate(async (encoded) => {
		const binary = atob(encoded);
		const bytes = Uint8Array.from(binary, (value) => value.charCodeAt(0));
		const context = new AudioContext();
		const audio = await context.decodeAudioData(bytes.buffer);
		const start = Math.max(
			0,
			audio.length - Math.floor(audio.sampleRate * 0.2),
		);
		let peak = 0;
		for (let index = start; index < audio.length; index += 1)
			peak = Math.max(peak, Math.abs(audio.getChannelData(0)[index] ?? 0));
		return { duration: audio.duration, peak };
	}, voiceBytes.toString('base64'));
	expect(decoded.duration).toBeGreaterThan(0.8);
	expect(decoded.peak).toBeGreaterThan(0.01);
	await page.getByRole('button', { name: 'Confirm and save' }).click();
	await expect(
		page.getByText('Voice update saved to garage history.', { exact: true }),
	).toBeVisible();
	await expect(page).toHaveURL(
		new RegExp(`/garage/${created.car.id}/overview`),
	);
});
