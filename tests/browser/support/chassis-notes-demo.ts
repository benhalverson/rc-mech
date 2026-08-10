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

export const installAppearance = async (
	page: Page,
	appearance: 'light' | 'dark',
): Promise<void> => {
	await page.addInitScript((preference) => {
		localStorage.setItem('rc-mech.appearance', preference);
	}, appearance);
};
