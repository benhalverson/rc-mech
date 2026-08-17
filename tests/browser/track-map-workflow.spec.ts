import { expect, type Page, test } from '@playwright/test';
import { getViolations, injectAxe } from 'axe-playwright';

let authentication = 0;

const authenticateOwner = async (page: Page): Promise<void> => {
	authentication += 1;
	const clientIp = `track-map-owner-${authentication}`;
	await page.setExtraHTTPHeaders({ 'CF-Connecting-IP': clientIp });
	const request = await page.request.post('/api/auth/sign-in/magic-link', {
		headers: { 'CF-Connecting-IP': clientIp },
		data: { email: 'owner@example.com', callbackURL: '/track-maps' },
	});
	expect(request.ok()).toBe(true);
	const verification = await page.request.get(
		'/api/auth/magic-link/verify?token=local-test-token&callbackURL=%2Ftrack-maps',
		{ headers: { 'CF-Connecting-IP': clientIp }, maxRedirects: 0 },
	);
	expect([302, 303]).toContain(verification.status());
};

const scan = async (page: Page) => {
	await injectAxe(page);
	return getViolations(page);
};

test('creates, edits, reopens, renames, and retires a draft Track map accessibly', async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await authenticateOwner(page);
	await page.goto('/track-maps');
	await expect(page.getByRole('heading', { name: 'Track maps' })).toBeVisible();
	expect(await scan(page)).toEqual([]);

	await page.getByLabel('New layout').fill('Browser circuit');
	await page.getByRole('button', { name: 'Create' }).click();
	const layout = page.getByRole('button', { name: /Browser circuit/ });
	await expect(layout).toBeVisible();
	await layout.click();
	await page.getByRole('button', { name: 'New draft' }).click();
	await expect(
		page.getByText('Create draft saved.', { exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole('heading', { name: 'Draw the corners the camera can see' }),
	).toBeVisible();

	await page.getByRole('button', { name: 'Add corner' }).click();
	await page.getByLabel('Name', { exact: true }).fill('Hairpin');
	await page.getByLabel('Stable key').fill('hairpin');
	await page.getByLabel('X', { exact: true }).fill('0.24');
	await page.getByLabel('Y', { exact: true }).fill('0.66');
	await page.getByLabel('View X').fill('0.12');
	await page.getByLabel('View Y').fill('0.32');
	await page.getByLabel('Width').fill('0.42');
	await page.getByLabel('Height').fill('0.36');
	await page.getByLabel('Entry').selectOption('reverse');
	await page.getByLabel('Exit').selectOption('forward');
	await page.getByLabel('View X').fill('1.2');
	await expect(page.getByRole('alert')).toContainText(
		'Corner view must be a positive rectangle inside the Track view.',
	);
	expect(await scan(page)).toEqual([]);
	await page.getByLabel('View X').fill('0.12');
	const cornerName = page.getByLabel('Name', { exact: true });
	await expect(cornerName).toHaveValue('Hairpin');
	const canvas = page.getByRole('button', {
		name: /Track map geometry editor/,
	});
	await canvas.focus();
	await expect(cornerName).toHaveValue('Hairpin');
	await canvas.press('ArrowRight');
	await expect(cornerName).toHaveValue('Hairpin');
	await canvas.click({ position: { x: 120, y: 170 } });
	await expect(cornerName).toHaveValue('Hairpin');
	await page
		.getByLabel('Geometry target', { exact: true })
		.selectOption('viewPosition');
	await canvas.press('ArrowRight');
	await page
		.getByLabel('Geometry target', { exact: true })
		.selectOption('viewSize');
	await canvas.press('ArrowLeft');
	await page.getByRole('button', { name: 'Save draft geometry' }).click();
	await expect(
		page.getByText('Save draft saved.', { exact: true }),
	).toBeVisible();
	expect(await scan(page)).toEqual([]);

	await page.reload();
	await page.getByRole('button', { name: /Browser circuit/ }).click();
	await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Hairpin');
	await expect(page.getByLabel('Entry')).toHaveValue('reverse');
	await expect(page.getByLabel('Exit')).toHaveValue('forward');
	await expect(page.getByLabel('View X')).toHaveValue('0.1225');
	await expect(page.getByLabel('View Y')).toHaveValue('0.32');
	await expect(page.getByLabel('Width')).toHaveValue('0.4175');
	await expect(page.getByLabel('Height')).toHaveValue('0.36');
	await page.getByLabel('Layout name').fill('Browser circuit revised');
	await page.getByRole('button', { name: 'Rename' }).click();
	await expect(
		page.getByText('Rename layout saved.', { exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole('button', { name: /Browser circuit revised/ }),
	).toBeVisible();

	await page.getByRole('button', { name: 'Retire layout' }).click();
	await expect(page.getByText('Choose a layout to begin')).toBeVisible();
	await expect(
		page.getByRole('button', { name: /Browser circuit revised.*retired/i }),
	).toBeVisible();
	await page
		.getByRole('button', { name: /Browser circuit revised.*retired/i })
		.click();
	await expect(
		page.getByText('Retired Track layouts are read-only.'),
	).toBeVisible();
	await expect(page.getByRole('button', { name: 'New draft' })).toHaveCount(0);
	expect(await scan(page)).toEqual([]);
});
