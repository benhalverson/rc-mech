import { expect, type Page, test } from '@playwright/test';
import { getViolations, injectAxe } from 'axe-playwright';

let authentication = 0;
const authenticate = async (page: Page, email = 'owner@example.com') => {
	await page.setExtraHTTPHeaders({
		'CF-Connecting-IP': `visibility-${++authentication}`,
	});
	const response = await page.request.post('/api/auth/sign-in/magic-link', {
		data: { email, callbackURL: '/garage' },
	});
	expect(response.ok()).toBe(true);
	const verified = await page.request.get(
		'/api/auth/magic-link/verify?token=local-test-token&callbackURL=%2Fgarage',
		{ maxRedirects: 0 },
	);
	expect([302, 303]).toContain(verified.status());
};

test('Owner saves persist across User reload; hidden links and ordinary sessions remain usable', async ({
	page,
	browser,
	baseURL,
}) => {
	test.setTimeout(60_000);
	await authenticate(page);
	const initial = await page.request.put(
		'/api/v1/feature-flags/driving-analysis',
		{ data: { enabled: false } },
	);
	expect(initial.ok()).toBe(true);
	const invite = await page.request.post('/api/v1/invite-codes', {
		data: { code: 'VISIBILITY-343' },
	});
	expect(invite.ok()).toBe(true);
	const userContext = await browser.newContext({ baseURL });
	const user = await userContext.newPage();
	await user.setExtraHTTPHeaders({ 'CF-Connecting-IP': 'visibility-register' });
	try {
		const registered = await user.request.post('/api/auth/register', {
			data: {
				email: 'visibility-user@example.com',
				inviteCode: 'VISIBILITY-343',
				callbackURL: '/garage',
			},
		});
		expect(registered.ok()).toBe(true);
		const verified = await user.request.get(
			'/api/auth/magic-link/verify?token=local-test-token&callbackURL=%2Fgarage',
			{ maxRedirects: 0 },
		);
		expect([302, 303]).toContain(verified.status());
		const created = await user.request.post('/api/v1/cars', {
			data: { name: 'Visibility buggy', make: 'Test', model: 'Buggy' },
		});
		expect(created.ok()).toBe(true);
		const { car } = await created.json();
		await user.goto(`/garage/${car.id}/drive-sessions`);
		await expect(
			user.getByRole('heading', { name: 'Drive sessions', exact: true }),
		).toBeVisible();
		await expect(
			user.getByRole('link', { name: 'Track maps', exact: true }),
		).toHaveCount(0);
		await user
			.getByRole('button', { name: 'Record the first drive session' })
			.click();
		await user
			.getByRole('button', { name: 'Save session', exact: true })
			.click();
		await expect(
			user.getByRole('button', { name: 'Edit drive session 1', exact: true }),
		).toBeVisible();
		await expect(user.locator('app-race-recording-upload')).toHaveCount(0);
		await injectAxe(user);
		expect(await getViolations(user)).toEqual([]);
		await user.goto('/track-maps');
		await expect(user).toHaveURL(/\/garage$/);
		await expect(user.locator('app-track-maps')).toHaveCount(0);
		await page.goto('/settings');
		const toggle = page.getByRole('checkbox', {
			name: 'Driving analysis',
			exact: true,
		});
		await expect(toggle).not.toBeChecked();
		await toggle.click();
		await expect(
			page.getByText('Driving analysis setting saved.', { exact: true }),
		).toBeVisible();
		await expect(toggle).toBeChecked();
		await page.getByRole('link', { name: 'Garage', exact: true }).click();
		await expect(page).toHaveURL(/\/garage$/);
		await page.getByRole('link', { name: 'Settings', exact: true }).click();
		await expect(toggle).toBeChecked();
		await injectAxe(page);
		expect(await getViolations(page)).toEqual([]);
		await user.getByRole('link', { name: 'Settings', exact: true }).click();
		await expect(
			user.getByRole('link', { name: 'Track maps', exact: true }),
		).toHaveCount(0);
		await user.reload();
		await expect(
			user.getByRole('link', { name: 'Track maps', exact: true }),
		).toBeVisible();
		await expect(
			user.getByRole('checkbox', { name: 'Driving analysis', exact: true }),
		).toHaveCount(0);
		await user.goto(`/garage/${car.id}/drive-sessions`);
		await expect(user.locator('app-race-recording-upload')).toHaveCount(1);
		await toggle.click();
		await expect(toggle).not.toBeChecked();
		await user.setViewportSize({ width: 390, height: 844 });
		await user.reload();
		await user.locator('[aria-controls="workspace-navigation"]').click();
		await expect(
			user.getByRole('link', { name: 'Track maps', exact: true }),
		).toHaveCount(0);
		await injectAxe(user);
		expect(await getViolations(user)).toEqual([]);
		await page.reload();
		await expect(toggle).not.toBeChecked();
		await page.getByRole('link', { name: 'Track maps', exact: true }).click();
		await expect(page).toHaveURL(/\/track-maps$/);
	} finally {
		await page.request.put('/api/v1/feature-flags/driving-analysis', {
			data: { enabled: false },
		});
		await userContext.close();
	}
});

test('bounded pending direct navigation fails closed without rendering Track maps', async ({
	page,
}) => {
	await authenticate(page);
	await page.route('**/api/v1/feature-flags/owner', (route) =>
		route.fulfill({ json: { isOwner: false } }),
	);
	await page.route('**/api/v1/feature-flags/driving-analysis', () => undefined);
	await page.goto('/track-maps');
	await expect(page.locator('app-track-maps')).toHaveCount(0);
	await expect(page).toHaveURL(/\/garage$/, { timeout: 10_000 });
	await expect(
		page.getByRole('link', { name: 'Track maps', exact: true }),
	).toHaveCount(0);
});

test('sign-out clears Owner visibility and a new SPA sign-in reads afresh', async ({
	page,
}) => {
	await authenticate(page);
	await page.goto('/garage');
	await expect(
		page.getByRole('link', { name: 'Track maps', exact: true }),
	).toBeVisible();
	await page.getByRole('button', { name: 'Sign out', exact: true }).click();
	await expect(page).toHaveURL(/\/sign-in/);
	let flagReads = 0;
	await page.route('**/api/v1/feature-flags/owner', (route) =>
		route.fulfill({ json: { isOwner: false } }),
	);
	await page.route('**/api/v1/feature-flags/driving-analysis', (route) => {
		flagReads++;
		return route.fulfill({ json: { enabled: false } });
	});
	// Keep the Angular document alive while replacing the server session. The
	// credential boundary is a fixture; the sign-in workflow and session refresh run normally.
	await authenticate(page);
	const session = await (
		await page.request.get('/api/auth/get-session')
	).json();
	await page.route(
		'**/api/auth/passkey/generate-authenticate-options',
		(route) => route.fulfill({ json: { challenge: 'AQID' } }),
	);
	await page.route('**/api/auth/passkey/verify-authentication', (route) =>
		route.fulfill({ json: session }),
	);
	await page.evaluate(() => {
		class Credential {
			id = 'visibility-credential';
			rawId = new Uint8Array([1]).buffer;
			type = 'public-key';
			response = {
				clientDataJSON: new Uint8Array([2]).buffer,
				authenticatorData: new Uint8Array([3]).buffer,
				signature: new Uint8Array([4]).buffer,
				userHandle: null,
			};
			getClientExtensionResults() {
				return {};
			}
		}
		Object.defineProperty(window, 'PublicKeyCredential', { value: Credential });
		Object.defineProperty(navigator.credentials, 'get', {
			value: async () => new Credential(),
		});
	});
	await page
		.getByRole('button', { name: 'Sign in with a passkey', exact: true })
		.click();
	await expect(page).toHaveURL(/\/garage$/);
	await expect.poll(() => flagReads).toBe(1);
	await expect(
		page.getByRole('link', { name: 'Track maps', exact: true }),
	).toHaveCount(0);
});
