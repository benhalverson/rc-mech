import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ShellRouteContext } from '../../shell/shell-route-context';
import {
	parseCurrentSetupCollection,
	parseCurrentSetupMutation,
	parseCurrentSetupTimezone,
	type SaveCurrentSetupCommand,
} from './current-setup.models';
import {
	CurrentSetupGateway,
	currentSetupGatewayFailure,
} from './current-setup-gateway';

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

const saveCommand: SaveCurrentSetupCommand = {
	carId: 'car/1',
	sourceSetupId: 'setup/1',
	sourceUpdatedAt: '2026-08-09T21:00:00.000Z',
	draft: {
		name: 'Current · Aug 9, 3:15 AM',
		recordedAt: '2026-08-09T00:00:00.000Z',
		track: 'Club track',
		event: null,
		surface: null,
		traction: null,
		moisture: null,
		condition: 'Dry',
		temperature: null,
		sections: {
			vehicle: { rideHeight: '14 mm' },
			drivetrain: { driveType: '4WD' },
			electronics: {},
			tires: {},
			shocks: {},
			frontSuspension: {},
			rearSuspension: {},
			notes: { setupNotes: 'Changed at the track.' },
		},
	},
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
		for (const request of http.match('/api/v1/preferences/timezone'))
			request.flush({ timezone: 'UTC' });
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
		expect(
			parseCurrentSetupMutation({ setup: response.setups[0] }),
		).toMatchObject({ id: 'setup-1', copiedFromSetupId: null });
		expect(parseCurrentSetupTimezone({})).toEqual({ timezone: null });
		expect(parseCurrentSetupTimezone({ timezone: 'UTC' })).toEqual({
			timezone: 'UTC',
		});
		expect(() => parseCurrentSetupMutation({ setup: { id: 4 } })).toThrow(
			'invalid',
		);
		expect(() => parseCurrentSetupTimezone({ timezone: 4 })).toThrow('invalid');
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

	it('loads the garage timezone and saves one authenticated atomic copy', async () => {
		gateway.timezone.value();
		expect(gateway.timezone.isLoading()).toBe(true);
		let timezone: ReturnType<HttpTestingController['expectOne']> | undefined;
		await vi.waitFor(() => {
			timezone = http.expectOne('/api/v1/preferences/timezone');
		});
		expect(timezone?.request.withCredentials).toBe(true);
		timezone?.flush({ timezone: 'America/Los_Angeles' });
		await vi.waitFor(() =>
			expect(gateway.timezone.value()?.timezone).toBe('America/Los_Angeles'),
		);

		const saved = firstValueFrom(gateway.saveCurrentSetup(saveCommand));
		const request = http.expectOne(
			'/api/v1/cars/car%2F1/setups/setup%2F1/copy',
		);
		expect(request.request.method).toBe('POST');
		expect(request.request.withCredentials).toBe(true);
		expect(request.request.body).toEqual({
			name: 'Current · Aug 9, 3:15 AM',
			expectedCurrentSetupId: 'setup/1',
			expectedSourceUpdatedAt: '2026-08-09T21:00:00.000Z',
			setupDate: '2026-08-09T00:00:00.000Z',
			track: 'Club track',
			event: null,
			surface: null,
			traction: null,
			moisture: null,
			condition: 'Dry',
			temperature: null,
			vehicle: { rideHeight: '14 mm' },
			drivetrain: { driveType: '4WD' },
			electronics: {},
			tires: {},
			shocks: {},
			frontSuspension: {},
			rearSuspension: {},
			notes: 'Changed at the track.',
			makeCurrent: true,
		});
		request.flush({
			setup: {
				...response.setups[0],
				id: 'setup-2',
				name: saveCommand.draft.name,
				copiedFromSetupId: 'setup-1',
			},
		});
		expect(await saved).toMatchObject({
			id: 'setup-2',
			copiedFromSetupId: 'setup-1',
		});
	});

	it('maps rejected and malformed mutation responses canonically', async () => {
		const withoutNotes = firstValueFrom(
			gateway.saveCurrentSetup({
				...saveCommand,
				draft: {
					...saveCommand.draft,
					sections: { ...saveCommand.draft.sections, notes: {} },
				},
			}),
		);
		const noNotesRequest = http.expectOne(
			'/api/v1/cars/car%2F1/setups/setup%2F1/copy',
		);
		expect(noNotesRequest.request.body.notes).toBeNull();
		noNotesRequest.flush({ setup: response.setups[0] });
		await expect(withoutNotes).resolves.toMatchObject({ id: 'setup-1' });

		const rejected = firstValueFrom(gateway.saveCurrentSetup(saveCommand));
		http
			.expectOne('/api/v1/cars/car%2F1/setups/setup%2F1/copy')
			.flush(
				{ error: 'Restore this car first.' },
				{ status: 409, statusText: 'Conflict' },
			);
		await expect(rejected).rejects.toEqual({
			kind: 'rejected-response',
			status: 409,
			message: 'Restore this car first.',
		});

		const malformed = firstValueFrom(gateway.saveCurrentSetup(saveCommand));
		http
			.expectOne('/api/v1/cars/car%2F1/setups/setup%2F1/copy')
			.flush({ setup: { id: 42 } });
		await expect(malformed).rejects.toEqual({ kind: 'invalid-response' });
	});

	it('maps every canonical read failure', () => {
		expect(currentSetupGatewayFailure(null)).toEqual({ kind: 'unavailable' });
		expect(
			currentSetupGatewayFailure(new HttpErrorResponse({ status: 0 })),
		).toEqual({ kind: 'unavailable' });
		expect(
			currentSetupGatewayFailure(new HttpErrorResponse({ status: 401 })),
		).toEqual({ kind: 'http', status: 401 });
		expect(
			currentSetupGatewayFailure(
				new HttpErrorResponse({
					status: 422,
					error: { error: 'Review the setup.' },
				}),
			),
		).toEqual({
			kind: 'rejected-response',
			status: 422,
			message: 'Review the setup.',
		});
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
