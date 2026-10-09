import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
	SettingsSyncGateway,
	settingsSyncFailure,
} from './settings-sync-gateway';

const operation = {
	operationId: 'op',
	ownerKey: 'owner',
	createdAt: 'today',
	command: {
		type: 'timezone' as const,
		base: 'UTC',
		timezone: 'Europe/London',
	},
	status: 'pending' as const,
	dependencies: [],
};
let gateway: SettingsSyncGateway;
let http: HttpTestingController;
beforeEach(() => {
	TestBed.configureTestingModule({
		providers: [provideHttpClient(), provideHttpClientTesting()],
	});
	gateway = TestBed.inject(SettingsSyncGateway);
	http = TestBed.inject(HttpTestingController);
});
afterEach(() => {
	http.verify();
	TestBed.resetTestingModule();
});
it('sends stable authenticated operations and parses acknowledgements and canonical rejections', async () => {
	for (const body of [
		{ operationId: 'op', outcome: 'applied', timezone: 'Europe/London' },
		{ operationId: 'op', outcome: 'rejected', error: 'Reserved code' },
		{
			operationId: 'op',
			outcome: 'conflict',
			error: 'Changed',
			remote: 'Asia/Tokyo',
		},
	]) {
		const promise = firstValueFrom(gateway.apply(operation));
		const request = http.expectOne('/api/v1/settings/sync/operations/op');
		expect(request.request.withCredentials).toBe(true);
		expect(request.request.body).toEqual({
			contractVersion: 1,
			command: operation.command,
		});
		request.flush(
			body,
			body.outcome === 'applied' ? {} : { status: 409, statusText: 'Conflict' },
		);
		expect(await promise).toEqual(body);
	}
});
it('refuses malformed, mismatched, unavailable, and unauthorized results', async () => {
	for (const body of [{}, { operationId: 'other', outcome: 'applied' }]) {
		const promise = firstValueFrom(gateway.apply(operation));
		http.expectOne('/api/v1/settings/sync/operations/op').flush(body);
		await expect(promise).rejects.toEqual({ kind: 'invalid-response' });
	}
	for (const status of [401, 503]) {
		const promise = firstValueFrom(gateway.apply(operation));
		http
			.expectOne('/api/v1/settings/sync/operations/op')
			.flush({}, { status, statusText: 'Unavailable' });
		await expect(promise).rejects.toEqual(
			status >= 500 ? { kind: 'unavailable' } : { kind: 'http', status },
		);
	}
});
it('verifies each acknowledgement belongs to its command', async () => {
	const invite = {
		id: 'op',
		code: 'TRACK-01',
		status: 'available',
		createdAt: 'today',
	};
	for (const command of [
		{ type: 'invite-create' as const, code: 'TRACK-01' },
		{ type: 'invite-revoke' as const, inviteId: 'invite' },
	]) {
		const result = firstValueFrom(gateway.apply({ ...operation, command }));
		http.expectOne('/api/v1/settings/sync/operations/op').flush({
			operationId: 'op',
			outcome: 'applied',
			...(command.type === 'invite-create'
				? { invite }
				: { revokedInviteId: 'invite' }),
		});
		await expect(result).resolves.toMatchObject({ outcome: 'applied' });
		const missing = firstValueFrom(gateway.apply({ ...operation, command }));
		http
			.expectOne('/api/v1/settings/sync/operations/op')
			.flush({ operationId: 'op', outcome: 'applied' });
		await expect(missing).rejects.toEqual({ kind: 'invalid-response' });
	}
	const result = firstValueFrom(gateway.apply(operation));
	http
		.expectOne('/api/v1/settings/sync/operations/op')
		.flush({ operationId: 'op', outcome: 'applied', timezone: 'UTC' });
	await expect(result).rejects.toEqual({ kind: 'invalid-response' });
});

it('classifies a disconnected request as retryable connectivity evidence', () => {
	expect(settingsSyncFailure(new HttpErrorResponse({ status: 0 }))).toEqual({
		kind: 'unavailable',
	});
});
