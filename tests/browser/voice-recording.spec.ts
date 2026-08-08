import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';

test('uploads one finalized recording containing audio through the end', async ({
	page,
}) => {
	execFileSync('pnpm', [
		'exec',
		'tsx',
		'scripts/invite-cli.ts',
		'--url',
		'http://127.0.0.1:8787',
		'--owner-email',
		'owner@example.com',
		'--code',
		'OWNER-VOICE',
	]);

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

		const send = XMLHttpRequest.prototype.send;
		XMLHttpRequest.prototype.send = function (body) {
			if (body instanceof FormData) {
				const file = body.get('file');
				if (file instanceof File) {
					void file.arrayBuffer().then((buffer) => {
						const bytes = new Uint8Array(buffer);
						let binary = '';
						for (const byte of bytes) binary += String.fromCharCode(byte);
						(window as Window & { voiceBytes?: string }).voiceBytes =
							btoa(binary);
					});
				}
			}
			return send.call(this, body);
		};
	});

	await page.goto('/garage/private-car/voice');
	await expect(page).toHaveURL(/sign-in/);
	await page.getByLabel('Email address').fill('owner@example.com');
	await page.getByRole('button', { name: 'Send magic link' }).click();
	await page.goto(
		'/api/auth/magic-link/verify?token=local-test-token&callbackURL=%2Fgarage',
	);
	await expect(page.getByText('The garage is waiting')).toBeVisible();

	const carResponse = await page.request.post('/api/v1/cars', {
		data: { name: 'Voice regression buggy', make: 'Test', model: '1' },
	});
	expect(carResponse.ok()).toBe(true);
	const created = (await carResponse.json()) as { car: { id: string } };

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
	await page.route('**/api/v1/cars/*/voice-updates', async (route) => {
		if (route.request().method() !== 'POST') return route.continue();
		await route.fulfill({ json: { voiceUpdate: update } });
	});
	await page.route('**/api/v1/voice-updates/*/process', async (route) => {
		await route.fulfill({
			json: { voiceUpdate: { ...update, status: 'needs-review' } },
		});
	});

	await page.goto(`/garage/${created.car.id}/voice`);
	await page.getByRole('button', { name: 'Start voice note' }).click();
	await expect(page.getByText('Speak to test the microphone')).toBeVisible();
	await expect(page.getByText('Audio detected')).toBeVisible({
		timeout: 5_000,
	});
	await page.waitForTimeout(1_000);
	await page.getByRole('button', { name: 'Stop and keep recording' }).click();

	await expect
		.poll(() =>
			page.evaluate(() =>
				Boolean((window as Window & { voiceBytes?: string }).voiceBytes),
			),
		)
		.toBe(true);
	const decoded = await page.evaluate(async () => {
		const encoded = (window as Window & { voiceBytes?: string }).voiceBytes;
		if (!encoded) throw new Error('No captured upload');
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
	});
	expect(decoded.duration).toBeGreaterThan(0.8);
	expect(decoded.peak).toBeGreaterThan(0.01);
});
