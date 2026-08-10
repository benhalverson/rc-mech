import { expect, test } from '@playwright/test';
import {
	authenticateDemoOwner,
	createChassisNotesDemo,
	createChassisNotesSetupHistoryDemo,
	createChassisNotesTrackToBenchHistory,
	installAppearance,
	installChassisNotesVoiceReview,
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

test('captures the real light and dark B7 track-to-bench history', async ({
	page,
}) => {
	await authenticateDemoOwner(page);
	const demo = await createChassisNotesSetupHistoryDemo(page);
	await installChassisNotesVoiceReview(page, demo.carId);
	await createChassisNotesTrackToBenchHistory(page, demo.carId);

	for (const appearance of ['light', 'dark'] as const) {
		await page.goto('/');
		await page.evaluate((preference) => {
			localStorage.setItem('rc-mech.appearance', preference);
		}, appearance);

		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto(`/garage/${demo.carId}/overview`);
		await expect(page.locator('html')).toHaveAttribute(
			'data-appearance',
			appearance,
		);
		const voiceReview = page.locator(
			'section[aria-labelledby="voice-review-title"]',
		);
		await expect(
			voiceReview.getByRole('heading', { name: 'Review this voice note' }),
		).toBeVisible();
		await expect(voiceReview.getByLabel('Transcript')).toContainText(
			'The rear stepped out on corner entry.',
		);
		await expect(
			voiceReview.getByLabel('Proposed garage records'),
		).toContainText('Proposed Trackside observation');
		await expect(
			voiceReview.getByRole('button', { name: 'Confirm and save' }),
		).toBeVisible();
		await page.evaluate(() => document.fonts.ready);
		await voiceReview.screenshot({
			path: `client/public/landing/voice-review-mobile-${appearance}.png`,
			animations: 'disabled',
			caret: 'hide',
			style: '.command-bar { visibility: hidden !important; }',
		});

		await page.setViewportSize({ width: 1366, height: 960 });
		await page.goto(`/garage/${demo.carId}/drive-sessions`);
		const driveHistory = page.locator('.session-log');
		await expect(
			driveHistory.getByText(
				'Entry felt more settled during this later Drive session.',
			),
		).toBeVisible();
		await driveHistory.screenshot({
			path: `client/public/landing/drive-session-desktop-${appearance}.png`,
			animations: 'disabled',
			caret: 'hide',
			style: '.command-bar { visibility: hidden !important; }',
		});

		await page.goto('/maintenance');
		const tireHistory = page.locator('.consumable-ledger');
		await expect(
			tireHistory.getByText('Fresh rear carpet tire set', { exact: true }),
		).toBeVisible();
		await tireHistory.screenshot({
			path: `client/public/landing/tire-service-desktop-${appearance}.png`,
			animations: 'disabled',
			caret: 'hide',
			style: '.command-bar { visibility: hidden !important; }',
		});
	}
});
