import { expect, type Page, test } from '@playwright/test';
import { getViolations, injectAxe } from 'axe-playwright';

let authentication = 0;

const authenticateOwner = async (page: Page): Promise<void> => {
	authentication += 1;
	const clientIp = `garage-owner-${authentication}`;
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

const createCar = async (
	page: Page,
	input: {
		name: string;
		make?: string;
		model?: string;
		scale?: string;
		vehicleType?: string;
		powerType?: string;
	},
) => {
	const response = await page.request.post('/api/v1/cars', { data: input });
	expect(response.ok()).toBe(true);
	return (await response.json()) as { car: { id: string } };
};

const scan = async (page: Page) => {
	await injectAxe(page);
	return getViolations(page);
};

test('keeps the light Garage collection and creation flow usable on a narrow phone', async ({
	page,
}) => {
	await page.setViewportSize({ width: 320, height: 720 });
	await page.addInitScript(() => {
		localStorage.setItem('rc-mech.appearance', 'light');
	});
	await authenticateOwner(page);
	const longName = 'GarageCarWithAnUnbrokenWorkshopName'.repeat(3);
	await createCar(page, { name: longName });

	await page.goto('/garage');
	await page.addStyleTag({ content: ':root { font-size: 200%; }' });
	await expect(page.locator('html')).toHaveAttribute(
		'data-appearance',
		'light',
	);
	await expect(page.getByRole('heading', { name: 'The garage' })).toBeVisible();
	const carRow = page.getByRole('link', { name: new RegExp(longName) });
	await expect(carRow).toContainText('Make not recorded · Model not recorded');
	await expect(carRow).toContainText('Active');
	const rowBox = await carRow.boundingBox();
	expect(rowBox).not.toBeNull();
	expect(rowBox?.height).toBeGreaterThanOrEqual(48);
	expect((rowBox?.x ?? 0) + (rowBox?.width ?? 0)).toBeLessThanOrEqual(320);
	const collectionSize = await page
		.locator('.garage-collection')
		.evaluate((collection) => ({
			clientWidth: collection.clientWidth,
			scrollWidth: collection.scrollWidth,
		}));
	expect(collectionSize.scrollWidth).toBe(collectionSize.clientWidth);

	await page.getByRole('button', { name: 'Add a car' }).click();
	const name = page.getByLabel('Name');
	await expect(name).toHaveAttribute('aria-describedby', 'car-name-help');
	await expect(page.getByText('The familiar name you use')).toBeVisible();
	await page.getByRole('button', { name: 'Save car' }).click();
	await expect(name).toBeFocused();
	await expect(name).toHaveAttribute('aria-describedby', 'car-name-error');
	await expect(page.locator('#car-name-error')).toHaveText(
		'Give this car a name before saving.',
	);
	expect(await scan(page)).toEqual([]);

	await name.fill('Browser-created buggy');
	await page.getByRole('button', { name: 'Save car' }).click();
	await expect(page).toHaveURL(/\/garage\/[^/]+\/overview$/);
});

test('renders active and archived Garage rows accessibly in the dark appearance', async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.addInitScript(() => {
		localStorage.setItem('rc-mech.appearance', 'dark');
	});
	await authenticateOwner(page);
	await createCar(page, {
		name: 'Active indoor buggy',
		make: 'Team Associated',
		model: 'B7',
		scale: '1/10',
		vehicleType: 'Buggy',
		powerType: 'Electric',
	});
	const archived = await createCar(page, {
		name: 'Archived outdoor truck',
		make: 'Tekno',
		model: 'ET48',
	});
	const archiveResponse = await page.request.post(
		`/api/v1/cars/${archived.car.id}/archive`,
	);
	expect(archiveResponse.ok()).toBe(true);

	await page.goto('/garage');
	await expect(page.locator('html')).toHaveAttribute('data-appearance', 'dark');
	await page.getByRole('button', { name: 'Inspect archived cars' }).click();
	const cars = page.getByRole('navigation', { name: 'Cars' });
	await expect(
		cars.getByRole('link', { name: /Active indoor buggy/ }),
	).toContainText('Active');
	await expect(
		cars.getByRole('link', { name: /Archived outdoor truck/ }),
	).toContainText('Archived');
	await expect(page.getByText('active and archived cars')).toBeVisible();
	expect(
		await page
			.getByRole('button', { name: 'Show active cars' })
			.evaluate((button) => button.getBoundingClientRect().height),
	).toBeGreaterThanOrEqual(48);
	expect(await scan(page)).toEqual([]);
});
