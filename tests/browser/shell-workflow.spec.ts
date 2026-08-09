import { expect, test } from '@playwright/test';
import { getViolations, injectAxe } from 'axe-playwright';

let ownerAuthentication = 0;

const scan = async (page: import('@playwright/test').Page) => {
	await injectAxe(page);
	return getViolations(page);
};

const authenticateOwner = async (
	page: import('@playwright/test').Page,
	returnTo = '/garage',
) => {
	ownerAuthentication += 1;
	await page.setExtraHTTPHeaders({
		'CF-Connecting-IP': `shell-owner-${ownerAuthentication}`,
	});
	await page.goto('/sign-in');
	await page.getByLabel('Email address').fill('owner@example.com');
	await page.getByRole('button', { name: 'Send magic link' }).click();
	await expect(page.getByRole('status')).toContainText('link is on its way');
	await page.goto(
		`/api/auth/magic-link/verify?token=local-test-token&callbackURL=${encodeURIComponent(returnTo)}`,
	);
	await expect(page.locator('.workspace-shell')).toHaveCount(1);
};

test('responsive shell navigation, route transitions, sign-out, and AXE', async ({
	page,
}) => {
	await authenticateOwner(page);

	await expect(page.locator('.workspace-shell')).toHaveCount(1);
	await expect(
		page.getByRole('navigation', { name: 'Primary workspace' }),
	).toHaveCount(1);
	await expect(page.locator('main')).toHaveCount(1);
	await expect(page.locator('[data-route-focus]')).toBeFocused();
	await expect(page.locator('.route-announcement')).toContainText(
		'Opened Garage',
	);

	await page.setViewportSize({ width: 390, height: 844 });
	const navigation = page.locator('.workspace-nav');
	const toggle = page.getByRole('button', {
		name: 'Open workspace navigation',
	});
	await expect(navigation).toHaveAttribute('aria-hidden', 'true');
	await expect(navigation).toHaveAttribute('inert', '');

	await toggle.click();
	await expect(navigation).not.toHaveAttribute('aria-hidden', 'true');
	await expect(page.locator('.nav-close')).toBeFocused();
	await expect(page.locator('.workspace-shell')).toHaveAttribute('inert', '');
	await page.locator('.nav-close').click();
	await expect(toggle).toBeFocused();

	await toggle.click();
	await page.locator('.workspace-backdrop').click({
		position: { x: 370, y: 400 },
	});
	await expect(toggle).toBeFocused();

	await toggle.click();
	await navigation.getByRole('link', { name: 'Maintenance' }).click();
	await expect(page).toHaveURL(/\/maintenance$/);
	await expect(page.locator('[data-route-focus]')).toBeFocused();
	await expect(page.locator('.route-announcement')).toContainText(
		'Opened Maintenance',
	);
	expect(await scan(page)).toEqual([]);

	await toggle.click();
	await page.getByRole('button', { name: 'Sign out' }).click();
	await expect(page).toHaveURL(/\/sign-in$/);
	await expect(page.locator('.workspace-shell')).toHaveCount(0);
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
	expect(await scan(page)).toEqual([]);
});

test('car context switches at 1024px and the mobile picker handles long, numerous Cars', async ({
	page,
}) => {
	await authenticateOwner(page);
	const longName =
		'B7D club-race buggy with the exceptionally long trackside identifier';
	const names = [
		longName,
		...Array.from(
			{ length: 15 },
			(_, index) => `Picker car ${String(index + 1).padStart(2, '0')}`,
		),
	];
	const responses = await Promise.all(
		names.map((name) =>
			page.request.post('/api/v1/cars', {
				data: { name, make: 'Shell fixture', model: 'Responsive' },
			}),
		),
	);
	for (const response of responses) expect(response.ok()).toBe(true);
	const cars = await Promise.all(
		responses.map(
			(response) =>
				response.json() as Promise<{ car: { id: string; name: string } }>,
		),
	);
	const current = cars[0]?.car;
	const next = cars[1]?.car;
	if (!current || !next)
		throw new Error('The shell fixtures were not created.');

	await page.setViewportSize({ width: 1024, height: 768 });
	await page.goto(`/garage/${current.id}/build`);
	await expect(page.locator('.desktop-command-bar')).toBeVisible();
	await expect(page.locator('.context-rail')).toBeVisible();
	await expect(page.locator('.context-rail')).toContainText(longName);
	await expect(
		page
			.getByRole('navigation', { name: 'Car detail sections' })
			.getByRole('link', { name: 'Build' }),
	).toHaveAttribute('aria-current', 'page');
	expect(
		await page
			.locator('.desktop-command-bar')
			.evaluate((element) =>
				Math.round(element.getBoundingClientRect().height),
			),
	).toBe(64);
	expect(await scan(page)).toEqual([]);

	await page.setViewportSize({ width: 1023, height: 700 });
	await expect(page.locator('.context-rail')).toHaveCount(0);
	const mobileBar = page.locator('.mobile-command-bar');
	await expect(mobileBar).toBeVisible();
	expect(
		await mobileBar.evaluate((element) =>
			Math.round(element.getBoundingClientRect().height),
		),
	).toBe(56);
	const currentCarControl = page.getByRole('button', { name: /Current car/ });
	await expect(currentCarControl).toContainText(longName);
	expect(
		await currentCarControl.evaluate((element) =>
			Math.round(element.getBoundingClientRect().height),
		),
	).toBeGreaterThanOrEqual(48);

	await page.setViewportSize({ width: 390, height: 600 });
	await currentCarControl.click();
	const picker = page.getByRole('dialog', { name: 'Choose current car' });
	await expect(picker).toBeVisible();
	await expect(
		picker.getByRole('button', { name: 'Close current car picker' }),
	).toBeFocused();
	const pickerBox = await picker.boundingBox();
	expect(pickerBox?.x).toBe(0);
	expect(pickerBox?.width).toBe(390);
	const pickerLabels = await picker.locator('.picker-car').allTextContents();
	expect(pickerLabels.length).toBeGreaterThanOrEqual(names.length);
	for (const name of names)
		expect(pickerLabels.some((label) => label.includes(name))).toBe(true);
	expect(
		await picker
			.locator('.car-picker-list')
			.evaluate((element) => element.scrollHeight > element.clientHeight),
	).toBe(true);
	expect(await scan(page)).toEqual([]);

	await picker.getByRole('link', { name: new RegExp(next.name) }).click();
	await expect(page).toHaveURL(new RegExp(`/garage/${next.id}/build$`));
	await expect(currentCarControl).toContainText(next.name);
	await expect(picker).toHaveCount(0);

	await page.setViewportSize({ width: 320, height: 640 });
	const controlBox = await currentCarControl.boundingBox();
	expect(controlBox?.x).toBeGreaterThanOrEqual(0);
	expect((controlBox?.x ?? 0) + (controlBox?.width ?? 0)).toBeLessThanOrEqual(
		320,
	);
	await page.setViewportSize({ width: 430, height: 932 });
	await expect(page.locator('.context-rail')).toHaveCount(0);
	await expect(page.locator('.mobile-command-bar')).toBeVisible();
	const largePhoneControlBox = await currentCarControl.boundingBox();
	expect(
		(largePhoneControlBox?.x ?? 0) + (largePhoneControlBox?.width ?? 0),
	).toBeLessThanOrEqual(430);
	await page.setViewportSize({ width: 900, height: 700 });
	await expect(page.locator('.context-rail')).toHaveCount(0);
	await page.setViewportSize({ width: 1024, height: 768 });
	await expect(page.locator('.context-rail')).toBeVisible();
	expect(await scan(page)).toEqual([]);
});
