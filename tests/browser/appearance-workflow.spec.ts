import { expect, test } from '@playwright/test';
import { getViolations, injectAxe } from 'axe-playwright';

let ownerAuthentication = 0;

const authenticateOwner = async (page: import('@playwright/test').Page) => {
	ownerAuthentication += 1;
	await page.setExtraHTTPHeaders({
		'CF-Connecting-IP': `appearance-owner-${ownerAuthentication}`,
	});
	await page.goto('/sign-in');
	await page.getByLabel('Email address').fill('owner@example.com');
	await page.getByRole('button', { name: 'Send magic link' }).click();
	await expect(page.getByRole('status')).toContainText('link is on its way');
	await page.goto(
		`/api/auth/magic-link/verify?token=local-test-token&callbackURL=${encodeURIComponent('/settings')}`,
	);
	await expect(page.locator('.workspace-shell')).toHaveCount(1);
};

const scan = async (page: import('@playwright/test').Page) => {
	await injectAxe(page);
	return getViolations(page);
};

test('applies a persisted override before Angular can render', async ({
	page,
}) => {
	await page.emulateMedia({ colorScheme: 'dark' });
	await page.addInitScript(() => {
		localStorage.setItem('rc-mech.appearance', 'light');
	});
	await page.route('**/*', async (route) => {
		if (route.request().resourceType() === 'script') await route.abort();
		else await route.continue();
	});

	await page.goto('/sign-in', { waitUntil: 'domcontentloaded' });
	const root = page.locator('html');
	await expect(root).toHaveAttribute('data-appearance-preference', 'light');
	await expect(root).toHaveAttribute('data-appearance', 'light');
	await expect
		.poll(() =>
			page.evaluate(() => getComputedStyle(document.body).backgroundColor),
		)
		.toBe('rgb(200, 204, 205)');
});

test('keeps the pre-render bootstrap safe when storage fails', async ({
	page,
}) => {
	await page.emulateMedia({ colorScheme: 'dark' });
	await page.addInitScript(() => {
		Object.defineProperty(Storage.prototype, 'getItem', {
			configurable: true,
			value: () => {
				throw new DOMException('Storage blocked');
			},
		});
	});
	await page.route('**/*', async (route) => {
		if (route.request().resourceType() === 'script') await route.abort();
		else await route.continue();
	});

	await page.goto('/sign-in', { waitUntil: 'domcontentloaded' });
	await expect(page.locator('html')).not.toHaveAttribute('data-appearance');
	await expect
		.poll(() =>
			page.evaluate(() => getComputedStyle(document.body).backgroundColor),
		)
		.toBe('rgb(17, 21, 22)');
});

test('appearance resolves before the workspace, persists, follows the system, and respects reduced motion', async ({
	page,
}) => {
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
			return {
				canvasSecondary: rootStyles
					.getPropertyValue('--alloy-text-on-canvas-secondary')
					.trim(),
				commandSecondary: rootStyles
					.getPropertyValue('--alloy-command-secondary')
					.trim(),
				commandAccent: rootStyles
					.getPropertyValue('--alloy-command-accent')
					.trim(),
				legacyAliases: ['--muted', '--accent', '--line'].map((property) =>
					rootStyles.getPropertyValue(property).trim(),
				),
			};
		}),
	).toEqual({
		canvasSecondary: '#465251',
		commandSecondary: '#a6b0ae',
		commandAccent: '#78a4ad',
		legacyAliases: ['', '', ''],
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

test('recomposes the selector and distinguishes pointer selection from keyboard focus', async ({
	page,
}) => {
	await page.setViewportSize({ width: 320, height: 800 });
	await authenticateOwner(page);

	const segments = page.locator('.alloy-segment');
	await expect(segments).toHaveCount(3);
	expect(
		await segments.evaluateAll((elements) =>
			elements.map((element) => getComputedStyle(element).transitionProperty),
		),
	).toEqual(['border-color', 'border-color', 'border-color']);
	const boxes = await segments.evaluateAll((elements) =>
		elements.map((element) => {
			const box = element.getBoundingClientRect();
			return {
				bottom: box.bottom,
				height: box.height,
				left: box.left,
				right: box.right,
				top: box.top,
			};
		}),
	);
	for (const box of boxes) {
		expect(box.height).toBeGreaterThanOrEqual(48);
		expect(box.left).toBeGreaterThanOrEqual(0);
		expect(box.right).toBeLessThanOrEqual(320);
	}
	expect(boxes[1]?.top).toBeGreaterThanOrEqual(boxes[0]?.bottom ?? 0);
	expect(boxes[2]?.top).toBeGreaterThanOrEqual(boxes[1]?.bottom ?? 0);

	await expect(page.locator('#appearance-title')).toBeFocused();
	await page.keyboard.press('Tab');
	const system = page.getByRole('radio', { name: 'System' });
	await expect(system).toBeFocused();
	expect(
		await system.locator('..').evaluate((element) => {
			const style = getComputedStyle(element);
			return `${style.outlineStyle} ${style.outlineWidth}`;
		}),
	).toBe('solid 2px');

	const dark = page.getByRole('radio', { name: 'Dark' });
	await page.getByText('Dark', { exact: true }).click();
	expect(
		await dark
			.locator('..')
			.evaluate((element) => getComputedStyle(element).outlineStyle),
	).toBe('none');
	expect(await scan(page)).toEqual([]);
});

test('keeps overdue and archived states accessible in the light appearance', async ({
	page,
}) => {
	await authenticateOwner(page);
	await page.getByText('Light', { exact: true }).click();
	const carResponse = await page.request.post('/api/v1/cars', {
		data: {
			make: 'Review fixture',
			model: 'Contrast',
			name: 'Alloy state fixture',
		},
	});
	expect(carResponse.ok()).toBe(true);
	const created = (await carResponse.json()) as { car: { id: string } };
	const planResponse = await page.request.post('/api/v1/maintenance-plans', {
		data: {
			baselineAt: '2020-01-01T00:00:00.000Z',
			carId: created.car.id,
			intervalDays: 1,
			name: 'Review overdue state',
		},
	});
	expect(planResponse.ok()).toBe(true);

	await page.goto('/maintenance');
	const overdue = page.locator('.plan-overdue').filter({
		hasText: 'Review overdue state',
	});
	await expect(overdue).toBeVisible();
	expect(
		await overdue
			.locator('.plan-state')
			.evaluate((element) => getComputedStyle(element).color),
	).toBe('rgb(23, 27, 29)');
	expect(await scan(page)).toEqual([]);

	const archiveResponse = await page.request.post(
		`/api/v1/cars/${created.car.id}/archive`,
	);
	expect(archiveResponse.ok()).toBe(true);
	await page.goto(`/garage/${created.car.id}/photos`);
	const archiveNote = page.getByText(
		'This car is archived. Its photos remain visible, but photo changes are disabled until the car is restored.',
	);
	await expect(archiveNote).toBeVisible();
	expect(
		await archiveNote.evaluate((element) => getComputedStyle(element).color),
	).toBe('rgb(23, 27, 29)');
	expect(await scan(page)).toEqual([]);
});
