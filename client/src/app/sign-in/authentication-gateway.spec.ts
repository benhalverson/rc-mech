import { DOCUMENT } from '@angular/common';
import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	AUTHENTICATION_ORIGIN,
	authenticationGatewayFailure,
	AuthenticationGateway,
	parseAccessResponse,
	parsePasskeyRequestOptions,
	parseVerifiedAuthentication,
} from './authentication-gateway';

describe('AuthenticationGateway', () => {
	let gateway: AuthenticationGateway;
	let http: HttpTestingController;

	beforeEach(() => {
		TestBed.configureTestingModule({
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				AuthenticationGateway,
				{ provide: AUTHENTICATION_ORIGIN, useValue: 'https://rc.example' },
			],
		});
		gateway = TestBed.inject(AuthenticationGateway);
		http = TestBed.inject(HttpTestingController);
	});

	afterEach(() => {
		http.verify();
		TestBed.resetTestingModule();
	});

	it('parses access, passkey-option, and verified-session responses', () => {
		expect(parseAccessResponse({ status: true })).toBeUndefined();
		expect(
			parsePasskeyRequestOptions({
				challenge: 'AQ',
				timeout: 60_000,
				rpId: 'rc.example',
				allowCredentials: [
					{ id: '-_8', type: 'public-key', transports: ['internal'] },
				],
				userVerification: 'preferred',
				extensions: { credProps: true },
			}),
		).toMatchObject({ challenge: 'AQ', rpId: 'rc.example' });
		expect(
			parseVerifiedAuthentication({
				session: { id: 'session-1', token: 'private' },
				user: { id: 'owner-1', email: 'owner@example.test' },
			}),
		).toBeUndefined();
		expect(() => parseAccessResponse({ status: false })).toThrow('invalid');
		expect(() => parsePasskeyRequestOptions({ challenge: '' })).toThrow(
			'invalid',
		);
		expect(() => parseVerifiedAuthentication({ status: true })).toThrow(
			'invalid',
		);
	});

	it('maps transport, rate-limit, parser, and unknown failures', () => {
		expect(
			authenticationGatewayFailure(new HttpErrorResponse({ status: 0 })),
		).toEqual({ kind: 'unavailable' });
		expect(
			authenticationGatewayFailure(new HttpErrorResponse({ status: 429 })),
		).toEqual({ kind: 'rate-limited', status: 429 });
		expect(
			authenticationGatewayFailure(new HttpErrorResponse({ status: 503 })),
		).toEqual({ kind: 'http', status: 503 });
		let parserError: unknown;
		try {
			parseAccessResponse({});
		} catch (error) {
			parserError = error;
		}
		expect(authenticationGatewayFailure(parserError)).toEqual({
			kind: 'invalid-response',
		});
		expect(authenticationGatewayFailure('offline')).toEqual({
			kind: 'unavailable',
		});
	});

	it('derives its default origin from the injected document', () => {
		TestBed.resetTestingModule();
		TestBed.configureTestingModule({
			providers: [{ provide: DOCUMENT, useValue: { location: undefined } }],
		});
		expect(
			TestBed.runInInjectionContext(() => inject(AUTHENTICATION_ORIGIN)),
		).toBe('http://localhost');

		TestBed.resetTestingModule();
		TestBed.configureTestingModule({
			providers: [
				{
					provide: DOCUMENT,
					useValue: { location: { origin: 'https://garage.example' } },
				},
			],
		});
		expect(
			TestBed.runInInjectionContext(() => inject(AUTHENTICATION_ORIGIN)),
		).toBe('https://garage.example');
	});

	it('owns normalized magic-link and registration requests', async () => {
		const magic = firstValueFrom(
			gateway.requestMagicLink(
				{ operation: 'request-magic-link', email: 'owner@example.test' },
				'/garage/car-42/photos',
			),
		);
		let request = http.expectOne('/api/auth/sign-in/magic-link');
		expect(request.request.method).toBe('POST');
		expect(request.request.withCredentials).toBe(true);
		expect(request.request.body).toEqual({
			email: 'owner@example.test',
			callbackURL: 'https://rc.example/garage/car-42/photos',
		});
		request.flush({ status: true });
		await expect(magic).resolves.toBeUndefined();

		const registration = firstValueFrom(
			gateway.register(
				{
					operation: 'register',
					email: 'user@example.test',
					inviteCode: 'TRACK-01',
				},
				'/garage',
			),
		);
		request = http.expectOne('/api/auth/register');
		expect(request.request.withCredentials).toBe(true);
		expect(request.request.body).toEqual({
			email: 'user@example.test',
			inviteCode: 'TRACK-01',
			callbackURL: '/garage',
		});
		request.flush({ status: true });
		await expect(registration).resolves.toBeUndefined();
	});

	it('owns passkey option and verification transport', async () => {
		const options = firstValueFrom(gateway.authenticationOptions());
		let request = http.expectOne(
			'/api/auth/passkey/generate-authenticate-options',
		);
		expect(request.request.method).toBe('GET');
		expect(request.request.withCredentials).toBe(true);
		request.flush({ challenge: 'AQ' });
		await expect(options).resolves.toEqual({ challenge: 'AQ' });

		const response = {
			id: 'passkey-1',
			rawId: 'AQID',
			response: {
				clientDataJSON: 'BA',
				authenticatorData: 'BQ',
				signature: 'Bg',
			},
			type: 'public-key',
			clientExtensionResults: {},
		};
		const verification = firstValueFrom(
			gateway.verifyAuthentication({ response }),
		);
		request = http.expectOne('/api/auth/passkey/verify-authentication');
		expect(request.request.method).toBe('POST');
		expect(request.request.withCredentials).toBe(true);
		expect(request.request.body).toEqual({ response });
		request.flush({
			session: { id: 'session-1' },
			user: { email: 'owner@example.test' },
		});
		await expect(verification).resolves.toBeUndefined();
	});

	it('maps malformed and failed gateway requests', async () => {
		const optionsResult = firstValueFrom(gateway.authenticationOptions());
		http
			.expectOne('/api/auth/passkey/generate-authenticate-options')
			.flush({ challenge: '' });
		await expect(optionsResult).rejects.toEqual({ kind: 'invalid-response' });

		const magicLinkResult = firstValueFrom(
			gateway.requestMagicLink(
				{ operation: 'request-magic-link', email: 'owner@example.test' },
				'/garage',
			),
		);
		http
			.expectOne('/api/auth/sign-in/magic-link')
			.flush({}, { status: 429, statusText: 'Too Many Requests' });
		await expect(magicLinkResult).rejects.toEqual({
			kind: 'rate-limited',
			status: 429,
		});

		const registrationResult = firstValueFrom(
			gateway.register(
				{
					operation: 'register',
					email: 'owner@example.test',
					inviteCode: 'TRACK-01',
				},
				'/garage',
			),
		);
		http
			.expectOne('/api/auth/register')
			.flush({}, { status: 503, statusText: 'Unavailable' });
		await expect(registrationResult).rejects.toEqual({
			kind: 'http',
			status: 503,
		});

		const verificationResult = firstValueFrom(
			gateway.verifyAuthentication({
				response: {
					id: 'passkey-1',
					rawId: 'AQID',
					response: {
						clientDataJSON: 'BA',
						authenticatorData: 'BQ',
						signature: 'Bg',
					},
					type: 'public-key',
					clientExtensionResults: {},
				},
			}),
		);
		http
			.expectOne('/api/auth/passkey/verify-authentication')
			.flush({ status: true });
		await expect(verificationResult).rejects.toEqual({
			kind: 'invalid-response',
		});
	});
});
