import { expect, test } from '@playwright/test';
import {
	authenticateDemoOwner,
	createChassisNotesDemo,
	installAppearance,
} from './support/chassis-notes-demo';

test.skip(
	process.env['UPDATE_LANDING_EVIDENCE'] !== '1',
	'Run explicitly to refresh committed landing evidence.',
);

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
}
