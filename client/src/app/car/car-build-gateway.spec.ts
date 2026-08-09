import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledComponent, SaveBuildCommand } from './car.models';
import {
	CarBuildGateway,
	buildGatewayFailure,
	parseBuildCollection,
	parseBuildMutation,
} from './car-build-gateway';

const component = (
	overrides: Partial<InstalledComponent> = {},
): InstalledComponent => ({
	id: 'component/1',
	carId: 'car/1',
	slot: 'motor',
	name: 'Race motor',
	...overrides,
});

const command = (
	mode: SaveBuildCommand['mode'],
	componentId: string | null,
): SaveBuildCommand => ({
	carId: 'car/1',
	mode,
	componentId,
	input: { slot: 'motor', name: 'Race motor' },
});

describe('CarBuildGateway', () => {
	let gateway: CarBuildGateway;
	let http: HttpTestingController;

	beforeEach(() => {
		TestBed.configureTestingModule({
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				CarBuildGateway,
			],
		});
		gateway = TestBed.inject(CarBuildGateway);
		http = TestBed.inject(HttpTestingController);
	});

	afterEach(() => {
		http.verify();
		TestBed.resetTestingModule();
	});

	it('parses build responses and maps all failure kinds', () => {
		expect(
			parseBuildCollection({ components: [component()] }).components,
		).toEqual([component()]);
		expect(parseBuildMutation({ component: component() })).toEqual(component());
		expect(() => parseBuildCollection({ components: [{ id: 4 }] })).toThrow();
		expect(() => parseBuildMutation({ component: {} })).toThrow();
		expect(buildGatewayFailure(new HttpErrorResponse({ status: 0 }))).toEqual({
			kind: 'unavailable',
		});
		expect(buildGatewayFailure(new HttpErrorResponse({ status: 409 }))).toEqual(
			{
				kind: 'http',
				status: 409,
			},
		);
		expect(buildGatewayFailure('offline')).toEqual({ kind: 'unavailable' });
		let malformed: unknown;
		try {
			parseBuildMutation(null);
		} catch (error) {
			malformed = error;
		}
		expect(buildGatewayFailure(malformed)).toEqual({
			kind: 'invalid-response',
		});
	});

	it('loads and refreshes encoded component history for one selected car', async () => {
		gateway.collection.value();
		http.expectNone('/api/v1/cars/car%2F1/components');
		expect(gateway.failure()).toBeNull();
		gateway.selectCar('car/1');
		gateway.selectCar('car/1');
		let read: ReturnType<HttpTestingController['expectOne']> | undefined;
		await vi.waitFor(() => {
			read = http.expectOne(
				(request) =>
					request.url === '/api/v1/cars/car%2F1/components' &&
					request.params.get('history') === 'true',
			);
		});
		expect(read?.request.withCredentials).toBe(true);
		read?.flush({ components: [component()] });
		await vi.waitFor(() =>
			expect(gateway.collection.value()?.components).toHaveLength(1),
		);

		gateway.refresh();
		let refresh: ReturnType<HttpTestingController['expectOne']> | undefined;
		await vi.waitFor(() => {
			refresh = http.expectOne(
				(request) => request.params.get('history') === 'true',
			);
		});
		refresh?.flush({ components: [{ id: 4 }] });
		await vi.waitFor(() => expect(gateway.collection.error()).toBeTruthy());
		expect(gateway.failure()).toEqual({ kind: 'invalid-response' });
	});

	it('uses add, edit, and replacement mutation endpoints', async () => {
		for (const [mode, componentId, method, endpoint] of [
			['add', null, 'POST', '/api/v1/cars/car%2F1/components'],
			[
				'edit',
				'component/1',
				'PATCH',
				'/api/v1/cars/car%2F1/components/component%2F1',
			],
			[
				'replace',
				'component/1',
				'POST',
				'/api/v1/cars/car%2F1/components/component%2F1/replace',
			],
		] as const) {
			const saved = firstValueFrom(gateway.save(command(mode, componentId)));
			const request = http.expectOne(endpoint);
			expect(request.request.method).toBe(method);
			expect(request.request.withCredentials).toBe(true);
			expect(request.request.body).toEqual({
				slot: 'motor',
				name: 'Race motor',
			});
			request.flush({ component: component() });
			await expect(saved).resolves.toEqual(component());
		}
	});

	it('maps malformed mutation responses through the canonical failure', async () => {
		const saved = firstValueFrom(gateway.save(command('add', null)));
		http
			.expectOne('/api/v1/cars/car%2F1/components')
			.flush({ component: { id: 4 } });
		await expect(saved).rejects.toEqual({ kind: 'invalid-response' });
	});
});
