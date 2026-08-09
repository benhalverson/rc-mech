import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShellRouteContext } from '../../shell/shell-route-context';
import {
	currentSetupGatewayFailure,
	CurrentSetupGateway,
} from './current-setup-gateway';
import { parseCurrentSetupCollection } from './current-setup.models';

const response = {
	currentSetupId: 'setup-1',
	setups: [
		{
			id: 'setup-1',
			carId: 'car/1',
			name: 'Current',
			current: true,
			context: {},
			sections: {
				vehicle: { rideHeight: '12 mm' },
				drivetrain: {},
				electronics: {},
				tires: {},
				shocks: {},
				frontSuspension: {},
				rearSuspension: {},
				notes: {},
			},
		},
	],
};

describe('CurrentSetupGateway', () => {
	const carId = signal<string | null>(null);
	let gateway: CurrentSetupGateway;
	let http: HttpTestingController;

	beforeEach(() => {
		carId.set(null);
		TestBed.configureTestingModule({
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				CurrentSetupGateway,
				{ provide: ShellRouteContext, useValue: { carId } },
			],
		});
		gateway = TestBed.inject(CurrentSetupGateway);
		http = TestBed.inject(HttpTestingController);
	});

	afterEach(() => {
		http.verify();
		TestBed.resetTestingModule();
	});

	it('parses setup collections and normalizes optional identifiers', () => {
		expect(parseCurrentSetupCollection(response)).toMatchObject({
			currentSetupId: 'setup-1',
			setups: [{ copiedFromSetupId: null }],
		});
		expect(
			parseCurrentSetupCollection({
				...response,
				currentSetupId: undefined,
				setups: [
					{
						...response.setups[0],
						copiedFromSetupId: 'setup-0',
					},
				],
			}),
		).toMatchObject({
			currentSetupId: null,
			setups: [{ copiedFromSetupId: 'setup-0' }],
		});
		expect(() =>
			parseCurrentSetupCollection({ setups: [{ id: '', name: 42 }] }),
		).toThrow('invalid');
	});

	it('loads authenticated setup history only for a selected car and refreshes', async () => {
		gateway.collection.value();
		http.expectNone('/api/v1/cars/car%2F1/setups');

		carId.set('car/1');
		let request: ReturnType<HttpTestingController['expectOne']> | undefined;
		await vi.waitFor(() => {
			request = http.expectOne('/api/v1/cars/car%2F1/setups');
		});
		if (!request) throw new Error('The setup request was not issued.');
		expect(request.request.method).toBe('GET');
		expect(request.request.withCredentials).toBe(true);
		request.flush(response);
		await vi.waitFor(() =>
			expect(gateway.collection.value()?.currentSetupId).toBe('setup-1'),
		);
		expect(gateway.failure()).toBeNull();

		gateway.refresh();
		let refresh: ReturnType<HttpTestingController['expectOne']> | undefined;
		await vi.waitFor(() => {
			refresh = http.expectOne('/api/v1/cars/car%2F1/setups');
		});
		refresh?.flush({ currentSetupId: null, setups: [] });
	});

	it('surfaces malformed transport data through the resource parser', async () => {
		carId.set('car-1');
		let request: ReturnType<HttpTestingController['expectOne']> | undefined;
		await vi.waitFor(() => {
			request = http.expectOne('/api/v1/cars/car-1/setups');
		});
		request?.flush({ currentSetupId: 'setup-1', setups: [{ id: 42 }] });
		await vi.waitFor(() => expect(gateway.collection.error()).toBeTruthy());
		expect(gateway.failure()).toEqual({ kind: 'invalid-response' });
	});

	it('maps every canonical read failure', () => {
		expect(currentSetupGatewayFailure(null)).toBeNull();
		expect(
			currentSetupGatewayFailure(new HttpErrorResponse({ status: 0 })),
		).toEqual({ kind: 'unavailable' });
		expect(
			currentSetupGatewayFailure(new HttpErrorResponse({ status: 401 })),
		).toEqual({ kind: 'http', status: 401 });
		expect(
			currentSetupGatewayFailure(
				new Error('The current setup response was invalid.'),
			),
		).toEqual({ kind: 'invalid-response' });
		expect(currentSetupGatewayFailure('offline')).toEqual({
			kind: 'unavailable',
		});
	});
});
