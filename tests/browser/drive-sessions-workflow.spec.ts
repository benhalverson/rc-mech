import { expect, test, type Page } from '@playwright/test';
import { getViolations, injectAxe } from 'axe-playwright';

let authentication = 0;

const authenticateOwner = async (page: Page): Promise<void> => {
	authentication += 1;
	await page.setExtraHTTPHeaders({
		'CF-Connecting-IP': `drive-sessions-owner-${authentication}`,
	});
	const request = await page.request.post('/api/auth/sign-in/magic-link', {
		data: { email: 'owner@example.com', callbackURL: '/garage' },
	});
	expect(request.ok()).toBe(true);
	const verification = await page.request.get(
		'/api/auth/magic-link/verify?token=local-test-token&callbackURL=%2Fgarage',
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
