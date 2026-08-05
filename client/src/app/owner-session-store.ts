import { httpResource } from '@angular/common/http';
import { computed, Injectable } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { filter, firstValueFrom, take } from 'rxjs';

export type OwnerSessionResponse = {
	session?: unknown;
	user?: { email?: string };
} | null;

@Injectable({ providedIn: 'root' })
export class OwnerSessionStore {
	readonly session = httpResource<OwnerSessionResponse>(() => ({
		url: '/api/auth/get-session',
		withCredentials: true,
	}));
	readonly authenticated = computed(() =>
		Boolean(this.session.value()?.session),
	);
	readonly ownerEmail = computed(
		() => this.session.value()?.user?.email ?? 'Owner',
	);

	async resolved(): Promise<OwnerSessionResponse> {
		// Reading the resource starts its first request in zoneless test and browser runtimes.
		this.session.value();
		await firstValueFrom(
			toObservable(this.session.status).pipe(
				filter((status) => status === 'resolved' || status === 'error'),
				take(1),
			),
		);
		return this.session.value() ?? null;
	}

	refresh(): void {
		this.session.reload();
	}
}
