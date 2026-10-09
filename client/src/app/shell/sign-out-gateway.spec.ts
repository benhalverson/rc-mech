import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
	type TestRequest,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InvalidSignOutResponse } from './sign-out-contract';
import {
	SIGN_OUT_RESPONSE_LOADER,
	SIGN_OUT_TIMEOUT_MS,
	SignOutGateway,
	type SignOutResponseLoader,
	type SignOutResponseModule,
	signOutGatewayFailure,
	signOutTimeoutMs,
} from './sign-out-gateway';
import type { SignOutResponse } from './sign-out-response';

const responseModule = {
	parseSignOutResponse(value: unknown): SignOutResponse {
		if (
			typeof value === 'object' &&
			value !== null &&
			'success' in value &&
			value.success === true
		)
			return { success: true };
		throw new InvalidSignOutResponse();
	},
} satisfies SignOutResponseModule;

describe('SignOutGateway', () => {
	let gateway: SignOutGateway;
	let http: HttpTestingController;
	let loadResponseParser: ReturnType<typeof vi.fn<SignOutResponseLoader>>;

	beforeEach(() => {
		loadResponseParser = vi.fn<SignOutResponseLoader>(
			async () => responseModule,
		);
		TestBed.configureTestingModule({
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				SignOutGateway,
				{ provide: SIGN_OUT_RESPONSE_LOADER, useValue: loadResponseParser },
			],
		});
		gateway = TestBed.inject(SignOutGateway);
		http = TestBed.inject(HttpTestingController);
	});

	afterEach(() => {
		http.verify();
		TestBed.resetTestingModule();
	});

	const nextRequest = async (): Promise<TestRequest> => {
		let request: TestRequest | undefined;
		await vi.waitFor(() => {
			request = http.expectOne('/api/auth/sign-out');
		});
		if (!request) throw new Error('The sign-out request did not start.');
		return request;
	};

	it('resumes only the session named by a durable sign-out request', async () => {
		const resumed = firstValueFrom(gateway.resumeSignOut('old-session'));
		http
			.expectOne('/api/auth/get-session')
			.flush({ session: { id: 'old-session' } });
		(await nextRequest()).flush({ success: true });
		await expect(resumed).resolves.toEqual({ success: true });
		for (const session of [null, { session: { id: 'new-session' } }]) {
			const skipped = firstValueFrom(gateway.resumeSignOut('old-session'));
			http.expectOne('/api/auth/get-session').flush(session);
			await expect(skipped).resolves.toEqual({ success: true });
			http.expectNone('/api/auth/sign-out');
		}
		const unavailable = firstValueFrom(gateway.resumeSignOut('old-session'));
		http.expectOne('/api/auth/get-session').error(new ProgressEvent('offline'));
		await expect(unavailable).rejects.toEqual({ kind: 'unavailable' });
	});

	it('loads the parser before posting and returns parsed success', async () => {
		let resolveParser!: (module: SignOutResponseModule) => void;
		loadResponseParser.mockReturnValueOnce(
			new Promise((resolve) => {
				resolveParser = resolve;
			}),
		);
		const result = firstValueFrom(gateway.signOut());
		http.expectNone('/api/auth/sign-out');

		resolveParser(responseModule);
		const request = await nextRequest();
		expect(request.request.method).toBe('POST');
		expect(request.request.withCredentials).toBe(true);
		expect(request.request.body).toEqual({});
		request.flush({ success: true });
		expect(await result).toEqual({ success: true });
	});

	it('does not mutate the server when the parser chunk cannot load', async () => {
		loadResponseParser.mockRejectedValueOnce(new Error('chunk unavailable'));
		const result = firstValueFrom(gateway.signOut());
		await expect(result).rejects.toEqual({ kind: 'unavailable' });
		http.expectNone('/api/auth/sign-out');
	});

	it('maps malformed and unavailable responses to canonical failures', async () => {
		const malformed = firstValueFrom(gateway.signOut());
		(await nextRequest()).flush({ success: false });
		await expect(malformed).rejects.toEqual({ kind: 'invalid-response' });

		const unavailable = firstValueFrom(gateway.signOut());
		(await nextRequest()).error(new ProgressEvent('offline'));
		await expect(unavailable).rejects.toEqual({ kind: 'unavailable' });
	});

	it('maps HTTP and unknown failures without exposing transport errors', async () => {
		const result = firstValueFrom(gateway.signOut());
		(await nextRequest()).flush('nope', {
			status: 503,
			statusText: 'Unavailable',
		});
		await expect(result).rejects.toEqual({ kind: 'http', status: 503 });
		expect(signOutGatewayFailure(new Error('unexpected'))).toEqual({
			kind: 'unavailable',
		});
		expect(signOutTimeoutMs()).toBe(15_000);
		expect(TestBed.inject(SIGN_OUT_TIMEOUT_MS)).toBe(15_000);
	});
});

describe('default sign-out response loader', () => {
	afterEach(() => TestBed.resetTestingModule());

	it('loads the production parser module on demand', async () => {
		TestBed.configureTestingModule({});
		const loadResponseParser = TestBed.inject(SIGN_OUT_RESPONSE_LOADER);
		const responseParser = await loadResponseParser();

		expect(responseParser.parseSignOutResponse({ success: true })).toEqual({
			success: true,
		});
	});
});
