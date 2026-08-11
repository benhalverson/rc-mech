import { httpResource } from '@angular/common/http';
import { computed, Service } from '@angular/core';
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

@Service()
export class OwnerSessionStore {
	private resolvedOnce = false;
	readonly session = httpResource<OwnerSessionResponse>(() => ({
		url: '/api/auth/get-session',
		withCredentials: true,
	}));
	private readonly sessionStatuses = toObservable(this.session.status);
	readonly authenticated = computed(
		() => this.session.hasValue() && Boolean(this.session.value()?.session),
	);
	readonly resolutionFailed = computed(() => this.session.status() === 'error');
	readonly ownerEmail = computed(
		() =>
			(this.session.hasValue() ? this.session.value()?.user?.email : null) ??
			'Owner',
	);
	readonly sessionKey = computed(() =>
		ownerSessionKey(
			this.session.hasValue() ? (this.session.value() ?? null) : null,
		),
	);

	async resolved(): Promise<OwnerSessionResponse> {
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

	expire(): void {
		this.resolvedOnce = true;
		this.session.set(null);
		void this.refresh();
	}
}
