import { expect, type Page, test } from '@playwright/test';
import { getViolations, injectAxe } from 'axe-playwright';
import {
	authenticateDemoOwner,
	installAppearance,
} from './support/chassis-notes-demo';

const expectAxeClean = async (page: Page): Promise<void> => {
	await injectAxe(page);
	expect(await getViolations(page)).toEqual([]);
};

for (const appearance of ['light', 'dark'] as const) {
	test(`opens the ${appearance} public entry without checking a session`, async ({
		page,
	}) => {
		await page.setViewportSize({ width: 390, height: 844 });
		await page.emulateMedia({ reducedMotion: 'reduce' });
		await installAppearance(page, appearance);
		const sessionRequests: string[] = [];
		const loadedScripts: Array<Promise<string>> = [];
		page.on('request', (request) => {
			if (new URL(request.url()).pathname === '/api/auth/get-session')
				sessionRequests.push(request.url());
		});
		page.on('response', (response) => {
			if (response.request().resourceType() === 'script')
				loadedScripts.push(response.text());
		});

		await page.goto('/', { waitUntil: 'networkidle' });
		await expect(
			page.getByRole('heading', {
				name: 'Know what’s on the car. What changed. What happened next.',
			}),
		).toBeVisible();
		expect(sessionRequests).toEqual([]);
		const loadedSource = (await Promise.all(loadedScripts)).join('\n');
		expect(loadedSource).not.toContain('/api/auth/get-session');
		expect(loadedSource).not.toContain('Chassis Notes owner workspace');
		await expect(page).toHaveTitle(
			'Chassis Notes — Setup history for RC racers',
		);
		await expect(page.locator('meta[name="description"]')).toHaveAttribute(
			'content',
			'Keep your RC car’s current setup, intentional changes, Drive sessions, trackside voice notes, and maintenance history together in one private field notebook.',
		);
		await expect(page.locator('html')).toHaveAttribute(
			'data-appearance',
			appearance,
		);
		await expect(
			page.getByRole('img', {
				name: /Current setup for the B7 carpet car/,
			}),
		).toHaveAttribute(
			'src',
			new RegExp(`current-setup-mobile-${appearance}\\.png`),
		);
		await expect(page.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
			'href',
			'/sign-in',
		);
		await expect(
			page.getByRole('link', { name: 'Enter Chassis Notes' }).first(),
		).toHaveAttribute('href', '/garage');
		for (const action of [
			page.getByRole('link', { name: 'Enter Chassis Notes' }).first(),
			page.getByRole('link', { name: 'See how it works' }),
		]) {
			expect((await action.boundingBox())?.height).toBeGreaterThanOrEqual(48);
		}

		await page.getByRole('link', { name: 'See how it works' }).click();
		await expect(
			page.getByRole('heading', { name: 'Start with what’s on the car.' }),
		).toBeInViewport();
		await expect(page.locator('#walkthrough')).toBeFocused();
		await expect(
			page.getByRole('heading', {
				name: 'Change the setup. Keep the baseline.',
			}),
		).toBeAttached();
		await expect(
			page.getByRole('img', {
				name: /Setup history for the example B7/,
			}),
		).toHaveAttribute(
			'src',
			new RegExp(`setup-history-desktop-${appearance}\\.png`),
		);
		await expect(page.getByText('35 wt / 30 wt')).toBeAttached();
		await expect(
			page.getByText(/Team Associated RC10B7 · 1\/10-scale electric 2WD buggy/),
		).toBeAttached();
		await expect(page.getByText('30 wt', { exact: true })).toBeAttached();
		await expect(page.getByText('35 wt', { exact: true })).toBeAttached();
		await expect(
			page.getByRole('heading', {
				name: 'Say what happened while it’s fresh.',
			}),
		).toBeAttached();
		await expect(
			page.getByRole('img', { name: /voice-note review for the example B7/ }),
		).toHaveAttribute(
			'src',
			new RegExp(`voice-review-mobile-${appearance}\\.png`),
		);
		await expect(
			page.getByText(
				'The rear stepped out on corner entry. I changed rear shock oil from 30 wt to 35 wt.',
			),
		).toBeAttached();
		await expect(
			page.getByText(
				'Nothing enters Garage history until you review and confirm it.',
			),
		).toBeAttached();
		await expect(
			page.getByRole('img', {
				name: /Drive-session history for the example B7/,
			}),
		).toHaveAttribute(
			'src',
			new RegExp(`drive-session-desktop-${appearance}\\.png`),
		);
		await expect(
			page.getByText('The record preserves sequence, not causation.', {
				exact: false,
			}),
		).toBeAttached();
		await expect(
			page.getByRole('heading', {
				name: 'Carry the record back to the bench.',
			}),
		).toBeAttached();
		await expect(
			page.getByRole('img', {
				name: /tire-service history for the example B7/,
			}),
		).toHaveAttribute(
			'src',
			new RegExp(`tire-service-desktop-${appearance}\\.png`),
		);
		await expect(
			page.getByRole('heading', { name: 'Your Garage stays yours.' }),
		).toBeAttached();
		await expect(
			page.getByText('Each User has an isolated private Garage.', {
				exact: false,
			}),
		).toBeAttached();
		await expect(
			page.getByText(
				'Chassis Notes records observations and decisions. It does not provide setup advice.',
			),
		).toBeAttached();
		const finalEntry = page
			.getByRole('link', { name: 'Enter Chassis Notes' })
			.last();
		expect((await finalEntry.boundingBox())?.height).toBeGreaterThanOrEqual(48);
		await expect(
			page.getByText('An invite is required for first registration.'),
		).toHaveCount(2);
		await expect(page.locator('main form')).toHaveCount(0);
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth,
			),
		).toBe(true);
		await expect(page.locator('app-appearance-selector')).toHaveCount(0);
		await expectAxeClean(page);
	});
}

test('keeps the complete public story ordered and usable on desktop', async ({
	page,
}) => {
	await page.setViewportSize({ width: 1366, height: 960 });
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await installAppearance(page, 'light');
	await page.goto('/');

	expect(
		(await page.locator('main h2').allTextContents()).map((heading) =>
			heading.trim(),
		),
	).toEqual([
		'Start with what’s on the car.',
		'Change the setup. Keep the baseline.',
		'Say what happened while it’s fresh.',
		'Carry the record back to the bench.',
		'Your Garage stays yours.',
		'Keep the next change in the same history.',
	]);
	const benchHeading = page.getByRole('heading', {
		name: 'Carry the record back to the bench.',
	});
	await benchHeading.scrollIntoViewIfNeeded();
	await expect(benchHeading).toBeInViewport();
	await expect(
		page.getByRole('img', {
			name: /tire-service history for the example B7/,
		}),
	).toBeVisible();
	const finalEntry = page
		.getByRole('link', { name: 'Enter Chassis Notes' })
		.last();
	await finalEntry.scrollIntoViewIfNeeded();
	await finalEntry.focus();
	await expect(finalEntry).toBeFocused();
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth,
		),
	).toBe(true);
	await expectAxeClean(page);
});

test('uses dark system appearance before requesting public evidence', async ({
	page,
}) => {
	await page.emulateMedia({ colorScheme: 'dark' });
	const evidenceRequests: string[] = [];
	page.on('request', (request) => {
		if (request.url().includes('/landing/current-setup-mobile-'))
			evidenceRequests.push(new URL(request.url()).pathname);
	});

	await page.goto('/');
	await expect(page.locator('html')).toHaveAttribute('data-appearance', 'dark');
	await expect(
		page.getByRole('img', { name: /Current setup for the B7 carpet car/ }),
	).toHaveAttribute('src', /current-setup-mobile-dark\.png/);
	expect(evidenceRequests).toEqual(['/landing/current-setup-mobile-dark.png']);
});

test('keeps the public root visible to an authenticated Racer', async ({
	page,
}) => {
	await authenticateDemoOwner(page);
	const sessionRequests: string[] = [];
	page.on('request', (request) => {
		if (new URL(request.url()).pathname === '/api/auth/get-session')
			sessionRequests.push(request.url());
	});

	await page.goto('/');
	await expect(
		page.getByRole('heading', {
			name: 'Know what’s on the car. What changed. What happened next.',
		}),
	).toBeVisible();
	expect(sessionRequests).toEqual([]);
});

test('preserves a signed-out deep link through the guarded Garage entry', async ({
	page,
}) => {
	await page.goto('/garage/example-car/photos?mode=grid#gallery');
	await expect(page).toHaveURL(
		/sign-in\?returnTo=%2Fgarage%2Fexample-car%2Fphotos%3Fmode%3Dgrid%23gallery$/,
	);
	await expect(
		page.getByRole('heading', { name: 'Back to the workbench.' }),
	).toBeVisible();
});

test('keeps the branded checking state when entering Garage from the public page', async ({
	page,
}) => {
	await page.goto('/');
	let releaseSession = (): void => undefined;
	const sessionReady = new Promise<void>((resolve) => {
		releaseSession = resolve;
	});
	await page.route('**/api/auth/get-session', async (route) => {
		await sessionReady;
		await route.continue();
	});

	const navigation = page
		.getByRole('link', { name: 'Enter Chassis Notes' })
		.first()
		.click();
	try {
		await expect(
			page.getByText('Chassis Notes / Field notebook'),
		).toBeVisible();
		await expect(page.getByText('Checking the garage latch…')).toBeVisible();
	} finally {
		releaseSession();
	}
	await navigation;
	await expect(page).toHaveURL(/\/sign-in\?returnTo=%2Fgarage$/);
});
