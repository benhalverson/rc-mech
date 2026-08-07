import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { getViolations, injectAxe } from 'axe-playwright';

const scan = async (page: import('@playwright/test').Page) => {
	await injectAxe(page);
	const violations = await getViolations(page);
	return violations;
};

const verify = async (
	page: import('@playwright/test').Page,
	returnTo: string,
) => {
	await page.goto(
		`/api/auth/magic-link/verify?token=local-test-token&callbackURL=${encodeURIComponent(returnTo)}`,
	);
};

const expectSingleShell = async (page: import('@playwright/test').Page) => {
	await expect(page.locator('.workspace-shell')).toHaveCount(1);
	await expect(
		page.getByRole('navigation', { name: 'Primary workspace' }),
	).toHaveCount(1);
	await expect(page.locator('main')).toHaveCount(1);
};

test('invite registration, management, isolation, and accessible states', async ({
	page,
	browser,
}) => {
	execFileSync('pnpm', [
		'exec',
		'tsx',
		'scripts/invite-cli.ts',
		'--url',
		'http://127.0.0.1:8787',
		'--owner-email',
		'owner@example.com',
		'--code',
		'OWNER-01',
	]);

	await page.goto('/garage/private-car/photos');
	await expect(page).toHaveURL(
		/sign-in\?returnTo=%2Fgarage%2Fprivate-car%2Fphotos/,
	);
	await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
	let violations = await scan(page);
	expect(violations).toEqual([]);
	await page.getByLabel('Email address').fill('owner@example.com');
	await page.getByRole('button', { name: 'Send magic link' }).click();
	await expect(page.getByRole('status')).toContainText('link is on its way');
	await verify(page, '/settings');
	await expect(
		page.getByRole('heading', { name: 'Your invite codes' }),
	).toBeVisible();
	await expectSingleShell(page);
	const carResponse = await page.request.post('/api/v1/cars', {
		data: {
			name: 'Accessibility buggy',
			make: 'Team Associated',
			model: 'B7',
		},
	});
	expect(carResponse.ok()).toBe(true);
	const created = (await carResponse.json()) as { car: { id: string } };
	for (const section of ['overview', 'build', 'setups', 'photos', 'runs']) {
		await page.goto(`/garage/${created.car.id}/${section}`);
		await expect(page).toHaveURL(
			new RegExp(`/garage/${created.car.id}/${section}$`),
		);
		await expect(page.locator('[data-route-focus]')).toBeFocused();
		await expect(page.locator('.route-announcement')).toContainText(
			'Opened Garage',
		);
		violations = await scan(page);
		expect(violations).toEqual([]);
	}
	for (const destination of [
		['Garage', '/garage'],
		['Maintenance', '/maintenance'],
		['Settings', '/settings'],
	] as const) {
		await page
			.getByRole('navigation', { name: 'Primary workspace' })
			.getByRole('link', { name: destination[0] })
			.click();
		await expect(page).toHaveURL(new RegExp(`${destination[1]}$`));
		await expectSingleShell(page);
		violations = await scan(page);
		expect(violations).toEqual([]);
	}
	await expect(page.getByText('OWNER-01')).toBeVisible();
	violations = await scan(page);
	expect(violations).toEqual([]);

	const userA = await browser.newContext({
		permissions: ['clipboard-read', 'clipboard-write'],
	});
	const userPage = await userA.newPage();
	await userPage.goto('/sign-in');
	await userPage
		.getByRole('button', { name: 'Have an invite code? Register' })
		.click();
	await userPage.getByLabel('Email address').fill('user-a@example.com');
	await userPage.getByLabel('Invite code').fill('OWNER-01');
	await userPage.getByRole('button', { name: 'Start registration' }).click();
	await expect(userPage.getByRole('status')).toContainText(
		'registration link is on its way',
	);
	await verify(userPage, '/garage');
	await expect(userPage.getByText('The garage is waiting')).toBeVisible();
	await expectSingleShell(userPage);
	violations = await scan(userPage);
	expect(violations).toEqual([]);

	await userPage.goto('/settings');
	await expect(
		userPage.getByRole('heading', { name: 'Your invite codes' }),
	).toBeVisible();
	await userPage.getByLabel('New invite code').fill('USER-A1');
	await userPage.getByRole('button', { name: 'Create code' }).click();
	await expect(userPage.getByText('USER-A1')).toBeVisible();
	await userPage.getByRole('button', { name: 'Copy' }).first().click();
	await expect(userPage.getByText('Copied USER-A1.')).toBeVisible();

	const userB = await browser.newContext();
	const userBPage = await userB.newPage();
	await userBPage.goto('/sign-in');
	await userBPage
		.getByRole('button', { name: 'Have an invite code? Register' })
		.click();
	await userBPage.getByLabel('Email address').fill('user-b@example.com');
	await userBPage.getByLabel('Invite code').fill('USER-A1');
	await userBPage.getByRole('button', { name: 'Start registration' }).click();
	await verify(userBPage, '/garage');
	await expect(userBPage.getByText('The garage is waiting')).toBeVisible();
	await userBPage.goto('/settings');
	await expect(userBPage.getByText('USER-A1')).toHaveCount(0);
	await expectSingleShell(userBPage);
	await expect(userBPage.getByText('USER-A1')).toHaveCount(0);
	violations = await scan(userBPage);
	expect(violations).toEqual([]);

	await userA.close();
	await userB.close();
});
