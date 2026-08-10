import { expect, type Page } from '@playwright/test';

let authentication = 0;

export type ChassisNotesDemo = {
	readonly carId: string;
	readonly setupId: string;
};

export type ChassisNotesSetupHistoryDemo = ChassisNotesDemo & {
	readonly currentSetupId: string;
};

export const authenticateDemoOwner = async (page: Page): Promise<void> => {
	authentication += 1;
	const clientIp = `chassis-notes-demo-${authentication}`;
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

export const createChassisNotesDemo = async (
	page: Page,
): Promise<ChassisNotesDemo> => {
	const carResponse = await page.request.post('/api/v1/cars', {
		data: {
			name: 'B7 carpet car',
			make: 'Team Associated',
			model: 'B7',
			scale: '1/10',
			vehicleType: '2WD buggy',
			powerType: 'Electric',
			notes: 'Dedicated Chassis Notes demo garage.',
		},
	});
	expect(carResponse.ok()).toBe(true);
	const { car } = (await carResponse.json()) as { car: { id: string } };

	const setupResponse = await page.request.post(
		`/api/v1/cars/${car.id}/setups`,
		{
			data: {
				name: 'Club carpet baseline',
				setupDate: '2026-08-09T19:00:00.000Z',
				track: 'Club carpet',
				condition: 'Clean, high grip',
				vehicle: { rideHeight: '13 mm' },
				drivetrain: { driveType: '2WD', gearDiffOil: '30k' },
				shocks: { frontOil: '35 wt', rearOil: '30 wt' },
				frontSuspension: { camber: '-1°' },
				rearSuspension: { camber: '-1°' },
				makeCurrent: true,
			},
		},
	);
	expect(setupResponse.ok()).toBe(true);
	const { setup } = (await setupResponse.json()) as { setup: { id: string } };

	return { carId: car.id, setupId: setup.id };
};

export const createChassisNotesSetupHistoryDemo = async (
	page: Page,
): Promise<ChassisNotesSetupHistoryDemo> => {
	const demo = await createChassisNotesDemo(page);
	const setupResponse = await page.request.post(
		`/api/v1/cars/${demo.carId}/setups/${demo.setupId}/copy`,
		{
			data: {
				name: 'Rear shock oil · 35 wt',
				setupDate: '2026-08-09T20:00:00.000Z',
				shocks: { frontOil: '35 wt', rearOil: '35 wt' },
				makeCurrent: true,
			},
		},
	);
	expect(setupResponse.ok()).toBe(true);
	const { setup } = (await setupResponse.json()) as {
		setup: { id: string };
	};

	return { ...demo, currentSetupId: setup.id };
};

export const installChassisNotesVoiceReview = async (
	page: Page,
	carId: string,
): Promise<void> => {
	const createdAt = '2026-08-09T20:10:00.000Z';
	const voiceUpdate = {
		id: 'chassis-notes-demo-voice',
		carId,
		driveSessionId: null,
		status: 'needs-review',
		contentType: 'audio/webm',
		fileName: 'club-night-note.webm',
		byteSize: 24_812,
		audioUrl: null,
		transcript:
			'The rear stepped out on corner entry. I changed rear shock oil from 30 wt to 35 wt.',
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
			problems: [
				{
					text: 'Rear stepped out on corner entry.',
					confidence: 'high',
					needsReview: false,
					sourceText: 'The rear stepped out on corner entry',
				},
			],
			conditions: [],
			driveSessionNotes: [],
			consumables: [],
			unmappedNotes: [],
			unresolvedNotes: [],
		},
		corrections: [],
		clarificationPrompt: null,
		error: null,
		confirmedAt: null,
		artifactDeletedAt: null,
		createdAt,
		updatedAt: createdAt,
		results: [],
	};

	await page.route(`**/api/v1/cars/${carId}/voice-updates`, async (route) => {
		if (route.request().method() !== 'GET') return route.continue();
		await route.fulfill({ json: { voiceUpdates: [voiceUpdate] } });
	});
};

export const createChassisNotesTrackToBenchHistory = async (
	page: Page,
	carId: string,
): Promise<void> => {
	const driveSession = await page.request.post(`/api/v1/cars/${carId}/drives`, {
		data: {
			startedAt: '2026-08-09T20:20:00.000Z',
			durationMinutes: 5,
			conditions: 'Club carpet · clean, high grip',
			notes: 'Entry felt more settled during this later Drive session.',
		},
	});
	expect(driveSession.ok()).toBe(true);

	const service = await page.request.post(
		`/api/v1/cars/${carId}/service-records`,
		{
			data: {
				performedAt: '2026-08-09T21:00:00.000Z',
				description: 'Cleaned the drivetrain and checked the rear hubs.',
				notes: 'Bench check after the club-night Drive sessions.',
			},
		},
	);
	expect(service.ok()).toBe(true);

	const tires = await page.request.post(
		`/api/v1/cars/${carId}/consumable-maintenance`,
		{
			data: {
				kind: 'tires',
				performedAt: '2026-08-09T21:10:00.000Z',
				axle: 'rear',
				rearDetails: 'Fresh rear carpet tire set',
				rearCost: 28,
				currency: 'USD',
			},
		},
	);
	expect(tires.ok()).toBe(true);
};

export const installAppearance = async (
	page: Page,
	appearance: 'light' | 'dark',
): Promise<void> => {
	await page.addInitScript((preference) => {
		localStorage.setItem('rc-mech.appearance', preference);
	}, appearance);
};
