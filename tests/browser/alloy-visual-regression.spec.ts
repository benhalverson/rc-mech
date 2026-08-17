import { expect, type Page, test } from '@playwright/test';
import { getViolations, injectAxe } from 'axe-playwright';

test.use({ serviceWorkers: 'allow' });

const browserClientPort = Number(
	process.env['RC_MECH_BROWSER_CLIENT_PORT'] ?? 4201,
);
const browserBaseURL = `http://127.0.0.1:${browserClientPort}`;

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

const ensureFixedCar = async (page: Page): Promise<typeof fixedCar> => {
	const collection = await page.request.get('/api/v1/cars?archived=all');
	expect(collection.ok()).toBe(true);
	const existing = (
		(await collection.json()) as { cars: (typeof fixedCar)[] }
	).cars.find((car) => car.name === fixedCar.name);
	if (existing) return existing;
	const response = await page.request.post('/api/v1/cars', {
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
	expect(response.ok()).toBe(true);
	return ((await response.json()) as { car: typeof fixedCar }).car;
};

for (const appearance of ['light', 'dark'] as const) {
	test(`keeps the ${appearance} public authentication surface visually stable`, async ({
		page,
	}) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		await setAppearance(page, appearance);
		await page.goto('/sign-in');
		await expect(
			page.getByRole('heading', { name: /Back to the workbench/ }),
		).toBeVisible();
		await expectAxeClean(page);
		const surface = page.locator('app-sign-in section');
		await expect(surface).toBeVisible();
		expect(
			await surface.evaluate((node) => {
				const style = getComputedStyle(node);
				return {
					background: style.backgroundColor,
					borderRadius: style.borderTopLeftRadius,
					font: style.fontFamily,
					topRule: style.borderTopColor,
				};
			}),
		).toEqual({
			background:
				appearance === 'light' ? 'rgb(217, 220, 221)' : 'rgb(25, 31, 33)',
			borderRadius: '8px',
			font: expect.stringContaining('Commissioner Variable'),
			topRule:
				appearance === 'light' ? 'rgb(41, 77, 88)' : 'rgb(120, 164, 173)',
		});
		await stabilizeVisuals(page);
		await expect(page).toHaveScreenshot(`sign-in-desktop-${appearance}.png`, {
			animations: 'disabled',
			caret: 'hide',
			fullPage: true,
		});
	});

	test(`keeps ${appearance} registration usable at narrow mobile width`, async ({
		page,
	}) => {
		await page.setViewportSize({ width: 320, height: 700 });
		await setAppearance(page, appearance);
		await page.goto('/sign-in');
		await page
			.getByRole('button', { name: 'Have an invite code? Register' })
			.click();
		await page.getByRole('button', { name: 'Start registration' }).click();
		await expect(page.getByRole('alert').first()).toContainText(
			'Enter your email address.',
		);
		await expect(page.getByRole('alert').nth(1)).toContainText(
			'Enter an invite code.',
		);
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth),
		).toBeLessThanOrEqual(320);
		await expectAxeClean(page);
	});

	test(`keeps the ${appearance} mobile Garage visually stable`, async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await setAppearance(page, appearance);
		await authenticateOwner(page);
		await ensureFixedCar(page);

		await page.goto('/garage');
		const routeHeading = page.getByRole('heading', {
			name: 'The garage',
			exact: true,
		});
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
		const car = await ensureFixedCar(page);
		const setupResponse = await page.request.post(
			`/api/v1/cars/${car.id}/setups`,
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

		await page.goto(`/garage/${car.id}/overview`);
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
	browser,
}) => {
	const context = await browser.newContext({
		baseURL: browserBaseURL,
		serviceWorkers: 'block',
		viewport: { width: 390, height: 844 },
	});
	const page = await context.newPage();
	await page.addInitScript(() => {
		Object.defineProperty(globalThis, 'indexedDB', {
			configurable: true,
			value: undefined,
		});
	});
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
		releaseCars();
		await expect(
			page.getByRole('link', { name: /Alloy B7 track car/ }),
		).toBeVisible();
	} finally {
		releaseCars();
		await context.close();
	}
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
