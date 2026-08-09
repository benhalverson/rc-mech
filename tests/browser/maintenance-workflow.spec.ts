import { expect, test, type Page } from '@playwright/test';
import { getViolations, injectAxe } from 'axe-playwright';

let authentication = 0;

const authenticateOwner = async (page: Page): Promise<void> => {
	authentication += 1;
	await page.setExtraHTTPHeaders({
		'CF-Connecting-IP': `maintenance-owner-${authentication}`,
	});
	const request = await page.request.post('/api/auth/sign-in/magic-link', {
		data: { email: 'owner@example.com', callbackURL: '/maintenance' },
	});
	expect(request.ok()).toBe(true);
	const verification = await page.request.get(
		'/api/auth/magic-link/verify?token=local-test-token&callbackURL=%2Fmaintenance',
		{ maxRedirects: 0 },
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

test('keeps light maintenance plan entry usable with large text on a narrow phone', async ({
	page,
}) => {
	await page.setViewportSize({ width: 320, height: 720 });
	await page.addInitScript(() => {
		localStorage.setItem('rc-mech.appearance', 'light');
	});
	await authenticateOwner(page);
	await createCar(page, 'Maintenance plan browser fixture');

	await page.goto('/maintenance');
	await expect(page.locator('html')).toHaveAttribute(
		'data-appearance',
		'light',
	);
	await expect(
		page.getByRole('heading', { name: 'Maintenance cockpit' }),
	).toBeVisible();
	await page.addStyleTag({ content: ':root { font-size: 200%; }' });
	const create = page.getByRole('button', {
		name: /^(Create a plan|New plan)$/,
	});
	await expect(create).toHaveCount(1);
	expect(
		await create.evaluate((button) => button.getBoundingClientRect().height),
	).toBeGreaterThanOrEqual(48);
	await create.click();
	await expect(
		page.getByRole('heading', { name: 'Set the care rule' }),
	).toBeFocused();

	const planName = page.getByLabel('Plan name');
	await planName.fill('');
	await page.getByRole('button', { name: 'Save plan' }).click();
	await expect(planName).toBeFocused();
	await expect(planName).toHaveAttribute('aria-describedby', 'plan-name-error');
	await expect(page.locator('#plan-name-error')).toHaveText(
		'Name the care rule.',
	);
	const formSize = await page
		.locator('form.maintenance-form')
		.evaluate((form) => ({
			clientWidth: form.clientWidth,
			scrollWidth: form.scrollWidth,
		}));
	expect(formSize.scrollWidth).toBe(formSize.clientWidth);
	expect(await scan(page)).toEqual([]);

	await planName.fill('Clean browser fixture bearings');
	await page.getByRole('button', { name: 'Save plan' }).click();
	const calendarInterval = page.locator('input[name$=".calendarValue"]');
	await expect(calendarInterval).toBeFocused();
	await expect(calendarInterval).toHaveAttribute(
		'aria-describedby',
		'plan-calendar-error',
	);
	await expect(page.locator('#plan-calendar-error')).toContainText(
		'Add a calendar interval',
	);
	await calendarInterval.fill('2');
	await page.getByRole('button', { name: 'Save plan' }).click();
	await expect(page.getByText('Clean browser fixture bearings')).toBeVisible();
	await expect(
		page.getByRole('heading', { name: 'Maintenance cockpit' }),
	).toBeFocused();
	const workspaceSize = await page
		.locator('.maintenance-cockpit')
		.evaluate((workspace) => ({
			clientWidth: workspace.clientWidth,
			scrollWidth: workspace.scrollWidth,
		}));
	expect(workspaceSize.scrollWidth).toBe(workspaceSize.clientWidth);
	expect(await scan(page)).toEqual([]);
});

test('keeps dark maintenance history, attention, and consumable states accessible', async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.addInitScript(() => {
		localStorage.setItem('rc-mech.appearance', 'dark');
	});
	await authenticateOwner(page);
	const created = await createCar(page, 'Maintenance history browser fixture');
	const plan = await page.request.post('/api/v1/maintenance-plans', {
		data: {
			baselineAt: '2020-01-01T00:00:00.000Z',
			carId: created.car.id,
			intervalDays: 1,
			name: 'Overdue browser fixture plan',
		},
	});
	expect(plan.ok()).toBe(true);
	const service = await page.request.post(
		`/api/v1/cars/${created.car.id}/service-records`,
		{
			data: {
				performedAt: '2026-08-08T18:00:00.000Z',
				description: 'Inspected browser fixture bearings',
				notes: 'Long-lived history remains readable in both appearances.',
				cost: 12.5,
				currency: 'USD',
			},
		},
	);
	expect(service.ok()).toBe(true);
	const consumable = await page.request.post(
		`/api/v1/cars/${created.car.id}/consumable-maintenance`,
		{
			data: {
				kind: 'tires',
				performedAt: '2026-08-08T19:00:00.000Z',
				axle: 'front',
				frontDetails: 'Browser fixture front tire set',
				frontCost: 24,
			},
		},
	);
	expect(consumable.ok()).toBe(true);

	await page.goto('/maintenance');
	await expect(page.locator('html')).toHaveAttribute('data-appearance', 'dark');
	await expect(page.getByText('Overdue browser fixture plan')).toBeVisible();
	const overdue = page.locator('.plan-overdue').filter({
		hasText: 'Overdue browser fixture plan',
	});
	await expect(overdue.getByText(/Attention · Overdue/)).toBeVisible();
	await expect(
		page
			.getByRole('region', { name: 'The work, kept honest' })
			.getByText('Inspected browser fixture bearings'),
	).toBeVisible();
	await expect(
		page.getByText('Browser fixture front tire set', { exact: true }),
	).toBeVisible();
	await page.addStyleTag({ content: ':root { font-size: 200%; }' });
	const ledgerSize = await page
		.locator('.consumable-ledger')
		.evaluate((ledger) => ({
			clientWidth: ledger.clientWidth,
			scrollWidth: ledger.scrollWidth,
		}));
	expect(ledgerSize.scrollWidth).toBe(ledgerSize.clientWidth);
	expect(await scan(page)).toEqual([]);

	const entryActions = page.getByRole('group', {
		name: 'Consumable entry actions',
	});
	await entryActions.getByRole('button', { name: 'Edit' }).click();
	await expect(
		page.getByRole('heading', { name: 'Keep the snapshot honest' }),
	).toBeFocused();
	const frontDetails = page.locator('textarea[name$=".frontDetails"]');
	await frontDetails.fill('');
	await page.getByLabel('Front cost (USD)').fill('');
	await page.getByRole('button', { name: 'Save change' }).click();
	await expect(frontDetails).toBeFocused();
	await expect(frontDetails).toHaveAttribute(
		'aria-describedby',
		'entry-front-details-error',
	);
	await expect(page.locator('#entry-front-details-error')).toHaveText(
		'Add front tire details or cost.',
	);
	await page.getByRole('button', { name: 'Cancel' }).click();
	await expect(
		entryActions.getByRole('button', { name: 'Edit' }),
	).toBeFocused();
	expect(await scan(page)).toEqual([]);
});
