import { expect, test } from '@playwright/test';
import { getViolations, injectAxe } from 'axe-playwright';

const authenticateOwner = async (page: import('@playwright/test').Page) => {
	await page.goto('/sign-in');
	await page.getByLabel('Email address').fill('owner@example.com');
	await page.getByRole('button', { name: 'Send magic link' }).click();
	await page.goto(
		`/api/auth/magic-link/verify?token=local-test-token&callbackURL=${encodeURIComponent('/settings')}`,
	);
	await expect(page.locator('.workspace-shell')).toHaveCount(1);
};

const scan = async (page: import('@playwright/test').Page) => {
	await injectAxe(page);
	return getViolations(page);
};

test('appearance resolves before the workspace, persists, follows the system, and respects reduced motion', async ({
	page,
}) => {
	test.setTimeout(60_000);
	await page.emulateMedia({ colorScheme: 'dark' });
	await authenticateOwner(page);

	const root = page.locator('html');
	await expect(root).toHaveAttribute('data-appearance-preference', 'system');
	await expect(root).toHaveAttribute('data-appearance', 'dark');
	await expect(page.getByRole('radio', { name: 'System' })).toBeChecked();
	await expect(
		page.getByText('Currently using dark appearance.'),
	).toBeVisible();

	const darkFoundation = await page.evaluate(() => {
		const rootStyles = getComputedStyle(document.documentElement);
		const bodyStyles = getComputedStyle(document.body);
		return {
			canvas: rootStyles.getPropertyValue('--alloy-canvas').trim(),
			control: rootStyles.getPropertyValue('--alloy-control').trim(),
			font: bodyStyles.fontFamily,
		};
	});
	expect(darkFoundation).toEqual({
		canvas: '#111516',
		control: '#22292b',
		font: expect.stringContaining('Commissioner Variable'),
	});
	expect(await scan(page)).toEqual([]);

	await page.getByText('Light', { exact: true }).click();
	await expect(root).toHaveAttribute('data-appearance-preference', 'light');
	await expect(root).toHaveAttribute('data-appearance', 'light');
	expect(
		await page.evaluate(() => localStorage.getItem('rc-mech.appearance')),
	).toBe('light');
	await page.emulateMedia({ colorScheme: 'dark' });
	await expect(root).toHaveAttribute('data-appearance', 'light');
	expect(
		await page.evaluate(() => {
			const rootStyles = getComputedStyle(document.documentElement);
			const navigationStyles = getComputedStyle(
				document.querySelector('.workspace-nav') as HTMLElement,
			);
			return {
				legacyMuted: rootStyles.getPropertyValue('--muted').trim(),
				navigationMuted: navigationStyles.getPropertyValue('--muted').trim(),
				navigationAccent: navigationStyles.getPropertyValue('--accent').trim(),
			};
		}),
	).toEqual({
		legacyMuted: '#465251',
		navigationMuted: '#a6b0ae',
		navigationAccent: '#78a4ad',
	});
	expect(await scan(page)).toEqual([]);

	await page.addInitScript(() => {
		const instrumentedWindow = window as typeof window & {
			appearanceAtWorkspace?: string;
		};
		const observer = new MutationObserver(() => {
			if (
				document.querySelector('.workspace-shell') &&
				instrumentedWindow.appearanceAtWorkspace === undefined
			) {
				instrumentedWindow.appearanceAtWorkspace =
					document.documentElement.dataset['appearance'];
				observer.disconnect();
			}
		});
		observer.observe(document, { childList: true, subtree: true });
	});
	await page.reload();
	await expect(page.locator('.workspace-shell')).toHaveCount(1);
	await expect(root).toHaveAttribute('data-appearance', 'light');
	expect(
		await page.evaluate(
			() =>
				(window as typeof window & { appearanceAtWorkspace?: string })
					.appearanceAtWorkspace,
		),
	).toBe('light');

	await page.getByText('System', { exact: true }).click();
	await expect(root).toHaveAttribute('data-appearance-preference', 'system');
	await expect(root).toHaveAttribute('data-appearance', 'dark');
	expect(
		await page.evaluate(() => localStorage.getItem('rc-mech.appearance')),
	).toBeNull();

	await page.emulateMedia({ colorScheme: 'light' });
	await expect(root).toHaveAttribute('data-appearance', 'light');
	await expect(
		page.getByText('Currently using light appearance.'),
	).toBeVisible();

	await page.getByText('Dark', { exact: true }).click();
	await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
	await expect(root).toHaveAttribute('data-appearance', 'dark');
	expect(
		await page.evaluate(() => getComputedStyle(document.body).transition),
	).toBe('none');
	expect(await scan(page)).toEqual([]);
});
