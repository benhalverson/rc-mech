import { expect, test } from '@playwright/test';

test.use({ serviceWorkers: 'allow' });

test('opens Add a car after stalled shell preparation without removing queued data', async ({
	page,
}) => {
	const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
	let backendWrites = 0;
	await page.route('**/api/**', async (route) => {
		if (route.request().method() !== 'GET') {
			backendWrites += 1;
			await route.abort();
			return;
		}
		const path = new URL(route.request().url()).pathname;
		const responses: Readonly<Record<string, unknown>> = {
			'/api/auth/get-session': {
				session: { id: 'isolated-ui-session', expiresAt },
				user: { id: 'isolated-ui-owner', email: 'ui-probe@example.test' },
			},
			'/api/v1/cars': { cars: [] },
			'/api/v1/feature-flags/owner': { isOwner: true },
			'/api/v1/feature-flags/driving-analysis': { enabled: false },
		};
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(responses[path] ?? {}),
		});
	});
	await page.addInitScript(() => {
		Object.defineProperty(navigator.serviceWorker, 'register', {
			value: () => new Promise(() => {}),
		});
		Object.defineProperty(navigator.serviceWorker, 'ready', {
			value: new Promise(() => {}),
		});
	});
	await page.goto('/garage');
	await expect(page.locator('[data-offline-status="preparing"]')).toBeVisible();
	await page.evaluate(async () => {
		await new Promise<void>((resolve, reject) => {
			const request = indexedDB.open('chassis-notes-offline-v1');
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const database = request.result;
				const transaction = database.transaction('operations', 'readwrite');
				transaction.objectStore('operations').put({
					operationId: 'retained-test-operation',
					ownerKey: 'isolated-ui-owner',
					carId: 'retained-test-car',
					status: 'pending',
					createdAt: '2026-10-06T00:00:00.000Z',
				});
				transaction.oncomplete = () => {
					database.close();
					resolve();
				};
				transaction.onerror = () => {
					database.close();
					reject(transaction.error);
				};
			};
		});
	});
	await expect(page.locator('[data-offline-status="online-only"]')).toBeVisible(
		{
			timeout: 10_000,
		},
	);
	const button = page.getByRole('button', { name: 'Add a car', exact: true });
	await expect(button).toBeEnabled();
	await button.click();
	await expect(
		page.getByRole('heading', { name: 'Add a car', exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole('button', { name: 'Save car', exact: true }),
	).toBeVisible();
	const retained = await page.evaluate(async () => {
		return new Promise<unknown>((resolve, reject) => {
			const request = indexedDB.open('chassis-notes-offline-v1');
			request.onerror = () => reject(request.error);
			request.onsuccess = () => {
				const database = request.result;
				const transaction = database.transaction('operations', 'readonly');
				const operation = transaction
					.objectStore('operations')
					.get('retained-test-operation');
				operation.onsuccess = () => resolve(operation.result);
				operation.onerror = () => reject(operation.error);
				transaction.oncomplete = () => database.close();
			};
		});
	});
	expect(retained).toMatchObject({
		operationId: 'retained-test-operation',
		status: 'pending',
	});
	expect(backendWrites).toBe(0);
});
