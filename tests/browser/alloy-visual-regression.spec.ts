import { expect, type Page, test } from '@playwright/test';
import { getViolations, injectAxe } from 'axe-playwright';

let authentication = 0;

const authenticateOwner = async (page: Page): Promise<void> => {
	authentication += 1;
	const clientIp = `alloy-visual-owner-${authentication}`;
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

const setAppearance = async (
	page: Page,
	appearance: 'light' | 'dark',
): Promise<void> => {
	await page.addInitScript((preference) => {
		localStorage.setItem('rc-mech.appearance', preference);
	}, appearance);
};

const stabilizeVisuals = async (page: Page): Promise<void> => {
	await page.evaluate(() => document.fonts.ready);
	await expect(page.locator('.animate-spin')).toHaveCount(0);
	await page.evaluate(() => window.scrollTo(0, 0));
	await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
};

const expectAxeClean = async (page: Page): Promise<void> => {
	await injectAxe(page);
	expect(await getViolations(page)).toEqual([]);
};

const fixedCar = {
	id: 'alloy-visual-car',
	name: 'Alloy B7 track car',
	make: 'Team Associated',
	model: 'B7',
	scale: '1/10',
	vehicleType: '2WD buggy',
	powerType: 'Electric',
	notes: 'Prepared for the evening club program.',
	archivedAt: null,
};

const routeFixedCarCollection = async (
	page: Page,
	car: typeof fixedCar = fixedCar,
): Promise<void> => {
	await page.route('**/api/v1/cars*', async (route) => {
		const request = route.request();
		if (
			request.method() === 'GET' &&
			new URL(request.url()).pathname === '/api/v1/cars'
		) {
			await route.fulfill({ json: { cars: [car] } });
			return;
		}
		await route.continue();
	});
};

for (const appearance of ['light', 'dark'] as const) {
	test(`keeps the ${appearance} mobile Garage visually stable`, async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await setAppearance(page, appearance);
		await authenticateOwner(page);
		await routeFixedCarCollection(page);

		await page.goto('/garage');
		const routeHeading = page.getByRole('heading', { name: 'The garage' });
		await expect(routeHeading).toBeVisible();
		await expect(routeHeading).toBeFocused();
		const routeFocus = await routeHeading.evaluate((heading) => {
			const style = getComputedStyle(heading);
			return {
				color: style.outlineColor,
				offset: style.outlineOffset,
				width: style.outlineWidth,
			};
		});
		expect(routeFocus).toEqual({
			color: appearance === 'light' ? 'rgb(41, 77, 88)' : 'rgb(120, 164, 173)',
			offset: '2px',
			width: '2px',
		});
		await expect(
			page.getByRole('link', { name: /Alloy B7 track car/ }),
		).toBeVisible();
		await stabilizeVisuals(page);
		await expect(page).toHaveScreenshot(`garage-mobile-${appearance}.png`, {
			animations: 'disabled',
			caret: 'hide',
			fullPage: true,
		});
	});

	test(`keeps the ${appearance} desktop selected-car console visually stable`, async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		await setAppearance(page, appearance);
		await authenticateOwner(page);
		const carResponse = await page.request.post('/api/v1/cars', {
			data: {
				name: fixedCar.name,
				make: fixedCar.make,
				model: fixedCar.model,
				scale: fixedCar.scale,
				vehicleType: fixedCar.vehicleType,
				powerType: fixedCar.powerType,
				notes: fixedCar.notes,
			},
		});
		expect(carResponse.ok()).toBe(true);
		const created = (await carResponse.json()) as {
			car: typeof fixedCar;
		};
		const setupResponse = await page.request.post(
			`/api/v1/cars/${created.car.id}/setups`,
			{
				data: {
					name: 'Indoor clay baseline',
					track: 'Club track',
					condition: 'Dry, medium grip',
					vehicle: { rideHeight: '13 mm', weight: '1,510 g' },
					drivetrain: {
						driveType: '2WD',
						gearDiffOil: '7k',
						gearDiffHeight: '3 mm',
					},
					shocks: {
						frontSpring: 'Blue',
						frontOil: '35 wt',
						rearSpring: 'Green',
						rearOil: '450 cSt',
					},
					frontSuspension: { camber: '-1°', toe: '1 mm out' },
					rearSuspension: {
						camber: '-2°',
						cBlockPill: 'up / in',
						dBlockPill: 'center / in',
					},
					makeCurrent: true,
				},
			},
		);
		expect(setupResponse.ok()).toBe(true);
		await routeFixedCarCollection(page, created.car);

		await page.goto(`/garage/${created.car.id}/overview`);
		await expect(
			page.getByRole('heading', { name: 'Current setup' }),
		).toBeVisible();
		await expect(
			page.getByRole('heading', { name: 'Voice note', exact: true }),
		).toBeVisible();
		await expect(
			page.getByRole('heading', { name: 'Car overview' }),
		).toBeVisible();
		await expect(page.locator('.desktop-command-bar')).toBeVisible();
		await expect(
			page.getByRole('button', { name: 'Change setup', exact: true }),
		).toBeVisible();
		await stabilizeVisuals(page);
		await expect(page).toHaveScreenshot(
			`selected-car-desktop-${appearance}.png`,
			{ animations: 'disabled', caret: 'hide', fullPage: true },
		);
	});
}

test('keeps the authenticated Garage loading composition explicit and accessible', async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await setAppearance(page, 'light');
	await authenticateOwner(page);

	let releaseCars = (): void => undefined;
	const carsReady = new Promise<void>((resolve) => {
		releaseCars = resolve;
	});
	await page.route('**/api/v1/cars*', async (route) => {
		const request = route.request();
		if (
			request.method() === 'GET' &&
			new URL(request.url()).pathname === '/api/v1/cars'
		) {
			await carsReady;
			await route.fulfill({ json: { cars: [fixedCar] } });
			return;
		}
		await route.continue();
	});

	try {
		await page.goto('/garage');
		const loading = page.getByRole('status').filter({
			hasText: 'Loading cars',
		});
		await expect(loading).toBeVisible();
		await expect(loading).toContainText('Opening the garage ledger');
		await expectAxeClean(page);
	} finally {
		releaseCars();
	}

	await expect(
		page.getByRole('link', { name: /Alloy B7 track car/ }),
	).toBeVisible();
});

test('keeps setup context typography and review controls within the Alloy contract', async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await setAppearance(page, 'light');
	await authenticateOwner(page);
	const carResponse = await page.request.post('/api/v1/cars', {
		data: {
			name: fixedCar.name,
			make: fixedCar.make,
			model: fixedCar.model,
		},
	});
	expect(carResponse.ok()).toBe(true);
	const created = (await carResponse.json()) as { car: typeof fixedCar };
	const setupResponse = await page.request.post(
		`/api/v1/cars/${created.car.id}/setups`,
		{
			data: {
				name: 'Imported indoor baseline',
				setupDate: '2026-08-01T12:00:00.000Z',
				track: 'Club track',
				condition: 'Dry, medium grip',
				vehicle: { rideHeight: '13 mm' },
				sourceUrl: 'https://example.com/setup',
				rawValues: { sourceRideHeight: '13mm' },
				unmappedValues: { casterDiagram: 'review' },
				makeCurrent: true,
			},
		},
	);
	expect(setupResponse.ok()).toBe(true);
	await routeFixedCarCollection(page, created.car);

	await page.goto(`/garage/${created.car.id}/setups`);
	await expect(
		page.getByRole('heading', { name: 'Imported indoor baseline' }),
	).toBeVisible();
	const context = page.locator('.setup-context');
	await expect(context).toBeVisible();
	expect(
		await context.evaluate((node) => getComputedStyle(node).fontFamily),
	).toContain('Commissioner Variable');
	expect(
		await context
			.locator('time')
			.evaluate((node) => getComputedStyle(node).fontFamily),
	).toContain('Fragment Mono');

	const sourceLink = page.getByRole('link', { name: 'Open source link' });
	const reviewSummary = page.getByText('Unmapped / raw values', {
		exact: true,
	});
	for (const control of [sourceLink, reviewSummary]) {
		await expect(control).toBeVisible();
		const box = await control.boundingBox();
		expect(box).not.toBeNull();
		expect(box?.height).toBeGreaterThanOrEqual(48);
	}
	await expectAxeClean(page);
});
