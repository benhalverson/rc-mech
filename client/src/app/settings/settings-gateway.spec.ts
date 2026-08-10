import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InviteCode, Passkey } from './settings.models';
import { SettingsGateway, settingsGatewayFailure } from './settings-gateway';

const invite: InviteCode = {
	id: 'invite/1',
	code: 'TRACK-01',
	status: 'available',
	createdAt: '2026-08-09T18:00:00.000Z',
};

const passkey: Passkey = {
	id: 'passkey/1',
	name: 'Workshop laptop',
	createdAt: '2026-08-09T18:00:00.000Z',
};

const invitesResponse = {
	allowance: 5,
	used: 1,
	remaining: 4,
	codes: [invite],
};

describe('SettingsGateway', () => {
	let gateway: SettingsGateway;
	let http: HttpTestingController;

	beforeEach(() => {
		TestBed.configureTestingModule({
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				SettingsGateway,
			],
		});
		gateway = TestBed.inject(SettingsGateway);
		http = TestBed.inject(HttpTestingController);
	});

	afterEach(() => {
		for (const request of http.match('/api/v1/invite-codes'))
			request.flush(invitesResponse);
		for (const request of http.match('/api/auth/passkey/list-user-passkeys'))
			request.flush([passkey]);
		http.verify();
		TestBed.resetTestingModule();
	});

	const startReads = async (): Promise<{
		invites: ReturnType<HttpTestingController['expectOne']>;
		passkeys: ReturnType<HttpTestingController['expectOne']>;
	}> => {
		gateway.invites.value();
		gateway.passkeys.value();
		let invites: ReturnType<HttpTestingController['expectOne']> | undefined;
		let passkeys: ReturnType<HttpTestingController['expectOne']> | undefined;
		await vi.waitFor(() => {
			invites = http.expectOne('/api/v1/invite-codes');
		});
		await vi.waitFor(() => {
			passkeys = http.expectOne('/api/auth/passkey/list-user-passkeys');
		});
		if (!invites || !passkeys)
			throw new Error('Settings reads were not issued.');
		return { invites, passkeys };
	};

	it('loads and parses both authenticated settings resources', async () => {
		expect(gateway.inviteFailure()).toBeNull();
		expect(gateway.passkeyFailure()).toBeNull();
		const { invites, passkeys } = await startReads();
		expect(invites.request.withCredentials).toBe(true);
		invites.flush(invitesResponse);
		expect(passkeys.request.withCredentials).toBe(true);
		passkeys.flush([passkey]);

		await vi.waitFor(() => {
			expect(gateway.invites.value()?.remaining).toBe(4);
			expect(gateway.passkeys.value()?.[0]?.id).toBe('passkey/1');
		});
	});

	it('surfaces malformed resource responses through canonical failures', async () => {
		const { invites, passkeys } = await startReads();
		invites.flush({ codes: [] });
		passkeys.flush([{ id: 4 }]);
		await vi.waitFor(() => {
			expect(gateway.invites.error()).toBeTruthy();
			expect(gateway.passkeys.error()).toBeTruthy();
		});
		expect(gateway.inviteFailure()).toEqual({ kind: 'invalid-response' });
		expect(gateway.passkeyFailure()).toEqual({ kind: 'invalid-response' });
	});

	it('preserves structured server messages and maps every failure kind', () => {
		expect(
			settingsGatewayFailure(new HttpErrorResponse({ status: 0 })),
		).toEqual({ kind: 'unavailable' });
		expect(
			settingsGatewayFailure(
				new HttpErrorResponse({
					status: 409,
					error: { error: 'That invite is already in use.' },
				}),
			),
		).toEqual({
			kind: 'http',
			status: 409,
			message: 'That invite is already in use.',
		});
		expect(
			settingsGatewayFailure(
				new HttpErrorResponse({ status: 503, error: 'offline' }),
			),
		).toEqual({ kind: 'http', status: 503 });
		expect(
			settingsGatewayFailure(
				new HttpErrorResponse({ status: 400, error: { error: 42 } }),
			),
		).toEqual({ kind: 'http', status: 400 });
		expect(settingsGatewayFailure('offline')).toEqual({ kind: 'unavailable' });
	});

	it('creates and revokes invite codes through owner-scoped endpoints', async () => {
		const created = firstValueFrom(gateway.createInvite('TRACK-02'));
		const create = http.expectOne('/api/v1/invite-codes');
		expect(create.request.method).toBe('POST');
		expect(create.request.withCredentials).toBe(true);
		expect(create.request.body).toEqual({ code: 'TRACK-02' });
		create.flush({ code: { ...invite, id: 'invite-2', code: 'TRACK-02' } });
		await expect(created).resolves.toMatchObject({ id: 'invite-2' });

		const revoked = firstValueFrom(gateway.revokeInvite(invite));
		const revoke = http.expectOne('/api/v1/invite-codes/invite%2F1/revoke');
		expect(revoke.request.method).toBe('POST');
		expect(revoke.request.body).toEqual({});
		revoke.flush({ code: { ...invite, status: 'revoked' } });
		await expect(revoked).resolves.toBeUndefined();
	});

	it('runs registration, rename, and revocation passkey mutations', async () => {
		const options = firstValueFrom(gateway.registrationOptions('Workshop key'));
		const optionRequest = http.expectOne(
			(request) =>
				request.url === '/api/auth/passkey/generate-register-options' &&
				request.params.get('name') === 'Workshop key',
		);
		expect(optionRequest.request.withCredentials).toBe(true);
		optionRequest.flush({ challenge: 'AQID', rp: { name: 'Chassis Notes' } });
		await expect(options).resolves.toMatchObject({ challenge: 'AQID' });

		const verified = firstValueFrom(
			gateway.verifyRegistration('Workshop key', { id: 'credential-1' }),
		);
		const verify = http.expectOne('/api/auth/passkey/verify-registration');
		expect(verify.request.body).toEqual({
			response: { id: 'credential-1' },
			name: 'Workshop key',
		});
		verify.flush({ status: true });
		await expect(verified).resolves.toBeUndefined();

		const renamed = firstValueFrom(
			gateway.renamePasskey(passkey, 'Pit tablet'),
		);
		const rename = http.expectOne('/api/auth/passkey/update-passkey');
		expect(rename.request.body).toEqual({
			id: 'passkey/1',
			name: 'Pit tablet',
		});
		rename.flush({ status: true });
		await expect(renamed).resolves.toBeUndefined();

		const revoked = firstValueFrom(gateway.revokePasskey(passkey));
		const revoke = http.expectOne('/api/auth/passkey/delete-passkey');
		expect(revoke.request.body).toEqual({ id: 'passkey/1' });
		revoke.flush({ status: true });
		await expect(revoked).resolves.toBeUndefined();
	});

	it('rejects malformed and HTTP mutation responses canonically', async () => {
		const malformedInvite = firstValueFrom(gateway.createInvite('TRACK-03'));
		http.expectOne('/api/v1/invite-codes').flush({ code: { id: 4 } });
		await expect(malformedInvite).rejects.toEqual({ kind: 'invalid-response' });

		const malformedOptions = firstValueFrom(
			gateway.registrationOptions('Workshop key'),
		);
		http
			.expectOne(
				(request) =>
					request.url === '/api/auth/passkey/generate-register-options' &&
					request.params.get('name') === 'Workshop key',
			)
			.flush({ challenge: 4 });
		await expect(malformedOptions).rejects.toEqual({
			kind: 'invalid-response',
		});

		const malformedAck = firstValueFrom(
			gateway.verifyRegistration('Workshop key', {}),
		);
		http
			.expectOne('/api/auth/passkey/verify-registration')
			.flush('not-an-object');
		await expect(malformedAck).rejects.toEqual({ kind: 'invalid-response' });

		const rejected = firstValueFrom(gateway.revokeInvite(invite));
		http
			.expectOne('/api/v1/invite-codes/invite%2F1/revoke')
			.flush(
				{ error: 'That invite is reserved.' },
				{ status: 409, statusText: 'Conflict' },
			);
		await expect(rejected).rejects.toEqual({
			kind: 'http',
			status: 409,
			message: 'That invite is reserved.',
		});
	});
});
