import { expect, test, type Page } from '@playwright/test';
import { getViolations, injectAxe } from 'axe-playwright';

let ownerAuthentication = 0;

const authenticateOwner = async (page: Page): Promise<void> => {
	ownerAuthentication += 1;
	await page.setExtraHTTPHeaders({
		'CF-Connecting-IP': `settings-owner-${ownerAuthentication}`,
	});
	await page.goto('/sign-in');
	await page.getByLabel('Email address').fill('owner@example.com');
	await page.getByRole('button', { name: 'Send magic link' }).click();
	await expect(page.getByRole('status')).toContainText('link is on its way');
	await page.goto(
		`/api/auth/magic-link/verify?token=local-test-token&callbackURL=${encodeURIComponent('/settings')}`,
	);
	await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible();
};

const scan = async (page: Page) => {
	await injectAxe(page);
	return getViolations(page);
};

const mockPopulatedSettings = async (page: Page): Promise<void> => {
	await page.route('**/api/v1/preferences/timezone', async (route) => {
		await route.fulfill({ json: { timezone: 'America/Los_Angeles' } });
	});
	await page.route('**/api/v1/invite-codes', async (route) => {
		await route.fulfill({
			json: {
				allowance: 5,
				used: 2,
				remaining: 3,
				codes: [
					{
						id: 'invite-long',
						code: 'TRACK-DAY-OWNER-CREDENTIAL-12345',
						status: 'available',
						createdAt: '2026-08-09T00:00:00.000Z',
					},
				],
			},
		});
	});
	await page.route('**/api/auth/passkey/list-user-passkeys', async (route) => {
		await route.fulfill({
			json: [
				{
					id: 'passkey-long',
					name: 'Workshop laptop with an intentionally long credential name that must wrap safely',
					createdAt: '2026-08-09T00:00:00.000Z',
				},
			],
		});
	});
};

test('keeps populated Settings usable on a narrow phone at 200% text in light appearance', async ({
	page,
}) => {
	await page.setViewportSize({ width: 320, height: 800 });
	await mockPopulatedSettings(page);
	await authenticateOwner(page);
	await page.getByText('Light', { exact: true }).click();
	const helpText = page.locator('#invite-help');
	const helpFontSize = await helpText.evaluate((element) =>
		Number.parseFloat(getComputedStyle(element).fontSize),
	);
	await page.locator('app-settings').evaluate((root) => {
		const elements = [root, ...root.querySelectorAll('*')];
		const sizes = elements.map((element) => {
			const style = getComputedStyle(element);
			return {
				fontSize: Number.parseFloat(style.fontSize),
				lineHeight: Number.parseFloat(style.lineHeight),
			};
		});
		for (const [index, element] of elements.entries()) {
			const size = sizes[index];
			if (!size || !(element instanceof HTMLElement)) continue;
			element.style.fontSize = `${size.fontSize * 2}px`;
			if (Number.isFinite(size.lineHeight))
				element.style.lineHeight = `${size.lineHeight * 2}px`;
		}
	});
	expect(
		await helpText.evaluate((element) =>
			Number.parseFloat(getComputedStyle(element).fontSize),
		),
	).toBe(helpFontSize * 2);

	await expect(page.getByText('3 of 5 remaining')).toBeVisible();
	await expect(
		page.getByText('TRACK-DAY-OWNER-CREDENTIAL-12345'),
	).toBeVisible();
	await expect(
		page.getByText(
			'Workshop laptop with an intentionally long credential name that must wrap safely',
		),
	).toBeVisible();

	const controls = await page
		.locator('app-settings :is(.alloy-control, .alloy-field, .alloy-segment)')
		.evaluateAll((elements) =>
			elements
				.filter((element) => element.getClientRects().length > 0)
				.map((element) => {
					const box = element.getBoundingClientRect();
					return {
						height: box.height,
						label:
							element.textContent?.trim() || element.getAttribute('id') || '',
						left: box.left,
						right: box.right,
					};
				}),
		);
	expect(controls.length).toBeGreaterThan(8);
	for (const control of controls) {
		const geometry = `${control.label} ${JSON.stringify(control)}`;
		expect(control.height, geometry).toBeGreaterThanOrEqual(48);
		expect(control.left, geometry).toBeGreaterThanOrEqual(0);
		expect(control.right, geometry).toBeLessThanOrEqual(320);
	}
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth,
		),
	).toBe(true);

	const timezone = page.getByLabel('IANA timezone');
	await timezone.fill('');
	await page.getByRole('button', { name: 'Save timezone' }).click();
	await expect(timezone).toBeFocused();
	await expect(page.getByText('Enter a timezone.')).toBeVisible();

	const invite = page.getByLabel('New invite code');
	await invite.fill('');
	await page.getByRole('button', { name: 'Create code' }).click();
	await expect(invite).toBeFocused();
	await expect(page.getByText('Enter an invite code.')).toBeVisible();

	const passkey = page.getByLabel('Name a new passkey');
	await passkey.fill('');
	await page.getByRole('button', { name: 'Add passkey' }).click();
	await expect(passkey).toBeFocused();
	await expect(page.getByText('Name this passkey.')).toBeVisible();
	expect(await scan(page)).toEqual([]);
});

test('returns an expired Settings session to sign-in with a clear reason', async ({
	page,
}) => {
	await mockPopulatedSettings(page);
	await authenticateOwner(page);
	await page.unroute('**/api/v1/invite-codes');
	await page.route('**/api/v1/invite-codes', async (route) => {
		await route.fulfill({
			body: JSON.stringify({ error: 'Unauthorized' }),
			contentType: 'application/json',
			status: 401,
		});
	});

	await page.reload();
	await expect(page).toHaveURL(
		/sign-in\?returnTo=%2Fsettings&reason=session-expired/,
	);
	await expect(page.getByText('Your garage session has expired')).toBeVisible();
});

test('labels unavailable and failed Settings states in dark appearance', async ({
	page,
}) => {
	await page.addInitScript(() => {
		Object.defineProperty(window, 'PublicKeyCredential', {
			configurable: true,
			value: undefined,
		});
	});
	for (const endpoint of [
		'**/api/v1/preferences/timezone',
		'**/api/v1/invite-codes',
		'**/api/auth/passkey/list-user-passkeys',
	]) {
		await page.route(endpoint, async (route) => {
			await route.fulfill({
				body: JSON.stringify({ error: 'Unavailable' }),
				contentType: 'application/json',
				status: 503,
			});
		});
	}
	await authenticateOwner(page);
	await page.getByText('Dark', { exact: true }).click();

	await expect(
		page.getByText('Passkey registration is unavailable in this browser'),
	).toBeVisible();
	await expect(page.getByText('Attention', { exact: true })).toBeVisible();
	await expect(page.getByText('Error', { exact: true })).toHaveCount(3);
	await expect(
		page.getByRole('button', { name: 'Add passkey' }),
	).toBeDisabled();
	await expect(page.locator('html')).toHaveAttribute('data-appearance', 'dark');
	expect(await scan(page)).toEqual([]);
});
