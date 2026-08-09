import { expect, test } from '@playwright/test';
import { getViolations, injectAxe } from 'axe-playwright';

const scan = async (page: import('@playwright/test').Page) => {
	await injectAxe(page);
	return getViolations(page);
};

test('responsive shell navigation, route transitions, sign-out, and AXE', async ({
	page,
}) => {
	await page.goto('/sign-in');
	await page.getByLabel('Email address').fill('owner@example.com');
	await page.getByRole('button', { name: 'Send magic link' }).click();
	await expect(page.getByRole('status')).toContainText('link is on its way');
	await page.goto(
		`/api/auth/magic-link/verify?token=local-test-token&callbackURL=${encodeURIComponent('/garage')}`,
	);

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

	await page.getByRole('button', { name: 'Sign out' }).click();
	await expect(page).toHaveURL(/\/sign-in$/);
	await expect(page.locator('.workspace-shell')).toHaveCount(0);
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
	expect(await scan(page)).toEqual([]);
});
