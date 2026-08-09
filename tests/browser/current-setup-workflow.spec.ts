import { expect, test, type Page } from '@playwright/test';
import { getViolations, injectAxe } from 'axe-playwright';

let authentication = 0;

const authenticateOwner = async (page: Page) => {
	authentication += 1;
	await page.setExtraHTTPHeaders({
		'CF-Connecting-IP': `203.0.113.${120 + authentication}`,
	});
	await page.goto('/sign-in');
	await page.getByLabel('Email address').fill('owner@example.com');
	await page.getByRole('button', { name: 'Send magic link' }).click();
	await expect(page.getByRole('status')).toContainText('link is on its way');
	await page.goto(
		'/api/auth/magic-link/verify?token=local-test-token&callbackURL=%2Fgarage',
	);
	await expect(page.locator('.workspace-shell')).toHaveCount(1);
};

const createCar = async (page: Page, name: string) => {
	const response = await page.request.post('/api/v1/cars', {
		data: { name, make: 'Associated', model: 'B7' },
	});
	expect(response.ok()).toBe(true);
	return (await response.json()) as { car: { id: string } };
};

const expectAxeClean = async (page: Page) => {
	await injectAxe(page);
	expect(await getViolations(page)).toEqual([]);
};

test('presents the copied Current setup as the first compact instrument sheet', async ({
	page,
}) => {
	await authenticateOwner(page);
	const { car } = await createCar(page, 'Instrument-sheet buggy');
	const baselineResponse = await page.request.post(
		`/api/v1/cars/${car.id}/setups`,
		{
			data: {
				name: 'Clay baseline',
				track: 'Club track',
				condition: 'Dry',
				vehicle: { rideHeight: '12 mm', weight: '1,510 g' },
				drivetrain: {
					driveType: '4WD',
					frontDiffOil: '7k',
					centerDiffOil: '10k',
					rearDiffOil: '5k',
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
					cBlockPill: 'up/in',
					dBlockPill: 'center/in',
				},
				electronics: { esc: 'Stock profile' },
				makeCurrent: true,
			},
		},
	);
	expect(baselineResponse.ok()).toBe(true);
	const baseline = (await baselineResponse.json()) as {
		setup: { id: string };
	};
	const currentResponse = await page.request.post(
		`/api/v1/cars/${car.id}/setups/${baseline.setup.id}/copy`,
		{
			data: {
				name: 'Finals setup',
				vehicle: { rideHeight: '14 mm', weight: '1,510 g' },
				makeCurrent: true,
			},
		},
	);
	expect(currentResponse.ok()).toBe(true);

	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`/garage/${car.id}/overview`);
	const sheet = page.locator('.current-setup-sheet');
	await expect(sheet).toBeVisible();
	await expect(
		sheet.getByRole('heading', { name: 'Current setup' }),
	).toBeVisible();
	await expect(sheet).toContainText('Finals setup');
	await expect(sheet).toContainText('14 mm');
	await expect(sheet).toContainText('-1°');
	await expect(sheet).toContainText('-2°');
	await expect(sheet).toContainText('up/in');
	await expect(sheet).toContainText('center/in');
	await expect(sheet).toContainText('35 wt');
	await expect(sheet).toContainText('450 cSt');
	await expect(sheet).toContainText('7k');
	await expect(sheet).toContainText('10k');
	await expect(sheet).toContainText('5k');

	const orderedLabels = await sheet
		.locator('[aria-label="Priority setup values"] dt')
		.allTextContents();
	expect(orderedLabels).toEqual([
		'Ride height',
		'Camber · Front / Rear',
		'Front toe',
		'Rear toe · C / D Pill',
		'Front shock spring',
		'Front shock oil',
		'Rear shock spring',
		'Rear shock oil',
		'Drivetrain configuration',
		'Front differential oil',
		'Center differential oil',
		'Rear differential oil',
	]);
	await expect(
		sheet.getByRole('heading', { name: 'Changes from previous' }),
	).toBeVisible();
	await expect(sheet.locator('.setup-changes')).toContainText('12 mm → 14 mm');
	expect(await sheet.locator('.setup-changes').textContent()).not.toMatch(
		/\bdiff\b/i,
	);
	await expect(
		sheet.getByRole('heading', { name: 'Remaining setup' }),
	).toBeVisible();
	await expect(sheet).toContainText('1,510 g');
	await expect(sheet).toContainText('Stock profile');

	expect(
		await page
			.locator('app-current-setup, section.overview')
			.evaluateAll((elements) => elements.map((element) => element.tagName)),
	).toEqual(['APP-CURRENT-SETUP', 'SECTION']);
	const rowHeights = await sheet
		.locator('.instrument-row')
		.evaluateAll((rows) =>
			rows.map((row) => Math.round(row.getBoundingClientRect().height)),
		);
	for (const height of rowHeights) expect(height).toBeGreaterThanOrEqual(48);
	for (const height of rowHeights) expect(height).toBeLessThanOrEqual(52);
	await expectAxeClean(page);
});

test('shows one accessible no-current-setup action state', async ({ page }) => {
	await authenticateOwner(page);
	const { car } = await createCar(page, 'No-setup buggy');
	await page.setViewportSize({ width: 320, height: 640 });
	await page.goto(`/garage/${car.id}/overview`);
	const sheet = page.locator('.current-setup-sheet');
	await expect(
		sheet.getByRole('heading', { name: 'No current setup' }),
	).toBeVisible();
	await expect(sheet.getByRole('link', { name: 'Record setup' })).toBeVisible();
	await expect(sheet.getByRole('link', { name: 'Import setup' })).toBeVisible();
	await expect(sheet.locator('.instrument-table')).toHaveCount(0);
	await expectAxeClean(page);
});
