import { expect, type Page, test } from '@playwright/test';
import { getViolations, injectAxe } from 'axe-playwright';

let authentication = 0;

const authenticateOwner = async (page: Page): Promise<void> => {
	authentication += 1;
	const clientIp = `build-photos-owner-${authentication}`;
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
		data: { name, make: 'Test make', model: 'Test model' },
	});
	expect(response.ok()).toBe(true);
	return (await response.json()) as { car: { id: string } };
};

const scan = async (page: Page) => {
	await injectAxe(page);
	return getViolations(page);
};

test('keeps the light Build editor and installation sheet usable on a narrow phone', async ({
	page,
}) => {
	await page.setViewportSize({ width: 320, height: 720 });
	await page.addInitScript(() => {
		localStorage.setItem('rc-mech.appearance', 'light');
	});
	await authenticateOwner(page);
	const created = await createCar(page, 'Build browser fixture');

	await page.goto(`/garage/${created.car.id}/build`);
	await expect(page.locator('html')).toHaveAttribute(
		'data-appearance',
		'light',
	);
	await expect(
		page.getByRole('heading', { name: 'Build sheet' }),
	).toBeVisible();
	await page.getByRole('button', { name: 'Add component' }).click();
	const name = page.getByLabel('Name');
	await expect(name).toHaveAttribute('aria-describedby', 'component-name-help');
	await page.getByRole('button', { name: 'Save component' }).click();
	await expect(name).toBeFocused();
	await expect(name).toHaveAttribute(
		'aria-describedby',
		'component-name-error',
	);
	await expect(page.locator('#component-name-error')).toHaveText(
		'Name the component.',
	);
	await expect(page.locator('#component-form-error')).toContainText(
		'Review the highlighted component fields.',
	);
	await expect(
		page.locator('.alloy-error-state .alloy-state-heading'),
	).toHaveCSS('color', 'rgb(230, 233, 232)');
	expect(
		await page
			.getByRole('button', { name: 'Save component' })
			.evaluate((button) => button.getBoundingClientRect().height),
	).toBeGreaterThanOrEqual(48);
	expect(await scan(page)).toEqual([]);

	const componentName = 'UnbrokenBuildComponentName'.repeat(4);
	await name.fill(componentName);
	await page.getByRole('button', { name: 'Save component' }).click();
	await expect(
		page.getByRole('status').filter({ hasText: 'Build sheet saved' }),
	).toBeVisible();
	await expect(page.getByText(componentName)).toBeVisible();
	const buildSize = await page.locator('.build-sheet').evaluate((build) => ({
		clientWidth: build.clientWidth,
		scrollWidth: build.scrollWidth,
	}));
	expect(buildSize.scrollWidth).toBe(buildSize.clientWidth);
});

test('renders the private photo list and archived state accessibly in dark mode', async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.addInitScript(() => {
		localStorage.setItem('rc-mech.appearance', 'dark');
	});
	await authenticateOwner(page);
	const created = await createCar(page, 'Photo browser fixture');
	const upload = await page.request.post(
		`/api/v1/cars/${created.car.id}/photos`,
		{
			multipart: {
				file: {
					name: 'bench.png',
					mimeType: 'image/png',
					buffer: Buffer.from(
						'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
						'base64',
					),
				},
			},
		},
	);
	expect(upload.ok()).toBe(true);

	await page.goto(`/garage/${created.car.id}/photos`);
	await expect(page.locator('html')).toHaveAttribute('data-appearance', 'dark');
	await expect(page.getByRole('heading', { name: 'Car photos' })).toBeVisible();
	await expect(
		page.getByRole('list', { name: 'Car photo gallery' }),
	).toBeVisible();
	await expect(page.getByText('Primary photo')).toBeVisible();
	await expect(
		page.getByRole('button', { name: 'Move photo earlier' }),
	).toBeDisabled();
	expect(await scan(page)).toEqual([]);

	const archive = await page.request.post(
		`/api/v1/cars/${created.car.id}/archive`,
	);
	expect(archive.ok()).toBe(true);
	await page.reload();
	await expect(
		page.getByText(
			'This car is archived. Its photos remain visible, but photo changes are disabled until the car is restored.',
		),
	).toBeVisible();
	await expect(page.locator('.photo-actions')).toHaveCount(0);
	expect(await scan(page)).toEqual([]);
});
