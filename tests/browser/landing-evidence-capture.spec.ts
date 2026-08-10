import { expect, test } from '@playwright/test';
import {
	authenticateDemoOwner,
	createChassisNotesDemo,
	createChassisNotesSetupHistoryDemo,
	installAppearance,
} from './support/chassis-notes-demo';

test.skip(
	process.env['UPDATE_LANDING_EVIDENCE'] !== '1',
	'Run explicitly to refresh committed landing evidence.',
);
test.use({ timezoneId: 'UTC' });

for (const appearance of ['light', 'dark'] as const) {
	test(`captures the real ${appearance} B7 Current setup`, async ({ page }) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await installAppearance(page, appearance);
		await authenticateDemoOwner(page);
		const demo = await createChassisNotesDemo(page);
		await page.goto(`/garage/${demo.carId}/overview`);
		await expect(
			page.getByRole('heading', { name: 'Current setup' }),
		).toBeVisible();
		await expect(page.getByText('Club carpet baseline')).toBeVisible();
		await expect(
			page.getByRole('button', { name: 'Change setup', exact: true }),
		).toBeVisible();
		await expect(page.locator('.animate-spin')).toHaveCount(0);
		await page.evaluate(() => document.fonts.ready);
		await page.evaluate(() => window.scrollTo(0, 0));

		await page.screenshot({
			path: `client/public/landing/current-setup-mobile-${appearance}.png`,
			animations: 'disabled',
			caret: 'hide',
		});
	});

	test(`captures the real ${appearance} B7 Setup history`, async ({ page }) => {
		await page.setViewportSize({ width: 1366, height: 960 });
		await installAppearance(page, appearance);
		await authenticateDemoOwner(page);
		const demo = await createChassisNotesSetupHistoryDemo(page);
		await page.goto(`/garage/${demo.carId}/setups`);
		await expect(
			page.getByRole('heading', { name: 'Setup snapshots' }),
		).toBeVisible();
		await expect(page.getByText('Club carpet baseline')).toBeVisible();
		await expect(
			page.getByRole('heading', { name: 'Rear shock oil · 35 wt' }),
		).toBeVisible();
		await expect(
			page.getByRole('button', {
				name: /Rear shock oil · 35 wt.*Current/,
			}),
		).toBeVisible();
		await expect(page.getByText('13 mm', { exact: true })).toBeVisible();
		await expect(page.getByText('30k', { exact: true })).toBeVisible();
		await expect(page.getByText('-1°', { exact: true })).toHaveCount(2);
		await expect(page.locator('.animate-spin')).toHaveCount(0);
		await page.evaluate(() => document.fonts.ready);
		await page.evaluate(() => window.scrollTo(0, 0));
		await page.locator('.workspace-frame').screenshot({
			path: `client/public/landing/setup-history-desktop-${appearance}.png`,
			animations: 'disabled',
			caret: 'hide',
			style: '.command-bar { visibility: hidden !important; }',
		});
	});
}
