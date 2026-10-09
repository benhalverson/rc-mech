import { httpResource } from '@angular/common/http';
import { computed, Service, signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { filter, firstValueFrom, take } from 'rxjs';

export type OwnerSessionResponse = {
	session?: unknown;
	user?: { email?: string };
} | null;

export const ownerSessionKey = (
	response: OwnerSessionResponse,
): string | null => {
	const session = response?.session;
	if (typeof session !== 'object' || session === null || !('id' in session))
		return null;
	const id = session.id;
	return typeof id === 'string' && id.trim() ? id.trim() : null;
};

/**
 * Shared session resource used by route admission and owner-scoped workflows.
 * Provides a stable session key and distinguishes a settled server response from
 * an errored/unavailable resource, allowing offline admission without treating
 * transport failure as proof that a different User is signed in.
 */
@Service()
export class OwnerSessionStore {
	private resolvedOnce = false;
	private readonly locallySignedOut = signal(false);
	readonly session = httpResource<OwnerSessionResponse>(() => ({
		url: '/api/auth/get-session',
		withCredentials: true,
	}));
	private readonly sessionStatuses = toObservable(this.session.status);
	readonly authenticated = computed(
		() =>
			!this.locallySignedOut() &&
			this.session.hasValue() &&
			Boolean(this.session.value()?.session),
	);
	readonly resolutionFailed = computed(() => this.session.status() === 'error');
	readonly ownerEmail = computed(
		() =>
			(!this.locallySignedOut() && this.session.hasValue()
				? this.session.value()?.user?.email
				: null) ?? 'Owner',
	);
	readonly sessionKey = computed(() =>
		this.locallySignedOut()
			? null
			: ownerSessionKey(
					this.session.hasValue() ? (this.session.value() ?? null) : null,
				),
	);

	async resolved(): Promise<OwnerSessionResponse> {
		if (this.locallySignedOut()) return null;
		// Reading the resource starts its first request in zoneless test and browser runtimes.
		this.session.value();
		await firstValueFrom(
			this.sessionStatuses.pipe(
				filter((status) => status === 'resolved' || status === 'error'),
				take(1),
			),
		);
		this.resolvedOnce = true;
		return this.session.hasValue() ? (this.session.value() ?? null) : null;
	}

	get hasResolvedSession(): boolean {
		return this.resolvedOnce;
	}

	async refresh(): Promise<OwnerSessionResponse> {
		if (this.locallySignedOut()) return null;
		const previousStatus = this.session.status();
		if (!this.session.reload()) return this.resolved();
		await firstValueFrom(
			this.sessionStatuses.pipe(
				filter((status) => status !== previousStatus),
				take(1),
			),
		);
		return this.resolved();
	}

	signOutLocally(): void {
		this.locallySignedOut.set(true);
		this.resolvedOnce = true;
		this.session.set(null);
	}
	expire(): void {
		this.resolvedOnce = true;
		this.session.set(null);
		void this.refresh();
	}
}
