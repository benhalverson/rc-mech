import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseShellCarCollection, ShellCarGateway } from './shell-car-gateway';
import { ShellRouteContext } from './shell-route-context';

describe('ShellCarGateway', () => {
	const carId = signal<string | null>(null);
	let gateway: ShellCarGateway;
	let http: HttpTestingController;

	beforeEach(() => {
		carId.set(null);
		TestBed.configureTestingModule({
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				ShellCarGateway,
				{ provide: ShellRouteContext, useValue: { carId } },
			],
		});
		gateway = TestBed.inject(ShellCarGateway);
		http = TestBed.inject(HttpTestingController);
	});

	afterEach(() => {
		http.verify();
		TestBed.resetTestingModule();
	});

	it('normalizes optional lifecycle values and rejects malformed responses', () => {
		expect(
			parseShellCarCollection({
				cars: [
					{ id: 'car-1', name: 'Buggy', extra: 'ignored' },
					{ id: 'car-2', name: 'Truck', archivedAt: '2026-01-01' },
				],
			}),
		).toEqual({
			cars: [
				{ id: 'car-1', name: 'Buggy', archivedAt: null },
				{ id: 'car-2', name: 'Truck', archivedAt: '2026-01-01' },
			],
		});
		expect(() =>
			parseShellCarCollection({ cars: [{ id: '', name: 42 }] }),
		).toThrow('invalid');
	});

	it('loads all owner cars only while a car workspace is active', async () => {
		gateway.collection.value();
		http.expectNone('/api/v1/cars?archived=all');

		carId.set('car-1');
		let request: ReturnType<HttpTestingController['expectOne']> | undefined;
		await vi.waitFor(() => {
			request = http.expectOne('/api/v1/cars?archived=all');
		});
		if (!request) throw new Error('The shell car request was not issued.');
		expect(request.request.method).toBe('GET');
		expect(request.request.withCredentials).toBe(true);
		request.flush({ cars: [{ id: 'car-1', name: 'Buggy' }] });
		await vi.waitFor(() =>
			expect(gateway.collection.value()).toEqual({
				cars: [{ id: 'car-1', name: 'Buggy', archivedAt: null }],
			}),
		);

		gateway.refresh();
		let refresh: ReturnType<HttpTestingController['expectOne']> | undefined;
		await vi.waitFor(() => {
			refresh = http.expectOne('/api/v1/cars?archived=all');
		});
		if (!refresh) throw new Error('The shell car refresh was not issued.');
		refresh.flush({ cars: [] });
	});

	it('surfaces invalid transport data through the resource', async () => {
		carId.set('car-1');
		let request: ReturnType<HttpTestingController['expectOne']> | undefined;
		await vi.waitFor(() => {
			request = http.expectOne('/api/v1/cars?archived=all');
		});
		request?.flush({ cars: [{ id: 'car-1', name: null }] });
		await vi.waitFor(() => expect(gateway.collection.error()).toBeTruthy());
	});
});
