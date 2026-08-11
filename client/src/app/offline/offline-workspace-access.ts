import { InjectionToken, inject, Service } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { OfflineCapabilities } from './offline-capabilities';
import { OfflineGarageGateway } from './offline-garage-gateway';
import {
	type OfflineGarageSnapshot,
	OfflineGarageStorage,
} from './offline-garage-storage';
import type { OfflineOwner } from './offline-owner';

export const systemNow = (): Date => new Date();
export const systemClock = (): (() => Date) => systemNow;

export const OFFLINE_NOW = new InjectionToken<() => Date>('OFFLINE_NOW', {
	factory: systemClock,
});

export type OfflinePreparationResult =
	| Readonly<{ kind: 'unsupported' }>
	| Readonly<{ kind: 'ready'; snapshot: OfflineGarageSnapshot }>;

@Service()
export class OfflineWorkspaceAccess {
	private readonly capabilities = inject(OfflineCapabilities);
	private readonly gateway = inject(OfflineGarageGateway);
	private readonly storage = inject(OfflineGarageStorage);
	private readonly now = inject(OFFLINE_NOW);

	async prepare(owner: OfflineOwner): Promise<OfflinePreparationResult> {
		if (!this.capabilities.supported) return { kind: 'unsupported' };
		if (!(await this.storage.activate(owner.key, owner.sessionKey)))
			throw new Error('Offline preparation was superseded by sign-out.');
		await this.capabilities.prepareShell();
		const collection = await firstValueFrom(this.gateway.load());
		const snapshot: OfflineGarageSnapshot = {
			ownerKey: owner.key,
			ownerEmail: owner.email,
			offlineUntil: owner.offlineUntil,
			preparedAt: this.now().toISOString(),
			cars: collection.cars,
			setupCollections: collection.setupCollections,
		};
		if (!(await this.storage.save(snapshot, owner.sessionKey)))
			throw new Error('Offline preparation was superseded by another User.');
		return { kind: 'ready', snapshot };
	}

	async restore(): Promise<OfflineGarageSnapshot | null> {
		if (!this.capabilities.supported) return null;
		return this.storage.restoreCurrent(this.now());
	}
}
