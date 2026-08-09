import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { type Observable, Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClipboardCapability } from './clipboard-capability';
import { InviteStore } from './invite-store';
import type {
	InviteCode,
	InviteCodesResponse,
	SettingsGatewayFailure,
} from './settings.models';
import { SettingsGateway } from './settings-gateway';

const invite = (overrides: Partial<InviteCode> = {}): InviteCode => ({
	id: 'invite-1',
	code: 'TRACK-01',
	status: 'available',
	createdAt: '2026-08-09T18:00:00.000Z',
	...overrides,
});

class FakeSettingsGateway {
	private readonly inviteValue = signal<InviteCodesResponse | undefined>(
		undefined,
	);
	private readonly inviteLoading = signal(false);
	private readonly inviteReadFailure = signal<SettingsGatewayFailure | null>(
		null,
	);
	private createResult = new Subject<InviteCode>();
	private revokeResult = new Subject<void>();

	readonly invites = {
		hasValue: () => this.inviteValue() !== undefined,
		value: () =>
			this.inviteValue() ?? {
				allowance: 5,
				used: 0,
				remaining: 5,
				codes: [],
			},
		isLoading: this.inviteLoading,
		reload: vi.fn(),
	};
	readonly inviteFailure = vi.fn(() => this.inviteReadFailure());
	readonly createInvite = vi.fn(
		(_code: string): Observable<InviteCode> => this.createResult.asObservable(),
	);
	readonly revokeInvite = vi.fn(
		(_code: InviteCode): Observable<void> => this.revokeResult.asObservable(),
	);

	setInvites(value: InviteCodesResponse | undefined): void {
		this.inviteValue.set(value);
	}

	setLoading(value: boolean): void {
		this.inviteLoading.set(value);
	}

	setReadFailure(value: SettingsGatewayFailure | null): void {
		this.inviteReadFailure.set(value);
	}

	resetCreate(): void {
		this.createResult = new Subject<InviteCode>();
	}

	resetRevoke(): void {
		this.revokeResult = new Subject<void>();
	}

	succeedCreate(value: InviteCode): void {
		this.createResult.next(value);
		this.createResult.complete();
	}

	failCreate(value: SettingsGatewayFailure): void {
		this.createResult.error(value);
	}

	succeedRevoke(): void {
		this.revokeResult.next();
		this.revokeResult.complete();
	}

	failRevoke(value: SettingsGatewayFailure): void {
		this.revokeResult.error(value);
	}
}

class FakeClipboardCapability {
	private copyResult = new Subject<void>();
	readonly copy = vi.fn(
		(_value: string): Observable<void> => this.copyResult.asObservable(),
	);

	resetCopy(): void {
		this.copyResult = new Subject<void>();
	}

	succeedCopy(): void {
		this.copyResult.next();
		this.copyResult.complete();
	}

	failCopy(): void {
		this.copyResult.error(new Error('clipboard unavailable'));
	}
}

describe('InviteStore', () => {
	let gateway: FakeSettingsGateway;
	let clipboard: FakeClipboardCapability;
	let store: InstanceType<typeof InviteStore>;

	beforeEach(() => {
		gateway = new FakeSettingsGateway();
		clipboard = new FakeClipboardCapability();
		TestBed.configureTestingModule({
			providers: [
				InviteStore,
				{ provide: SettingsGateway, useValue: gateway },
				{ provide: ClipboardCapability, useValue: clipboard },
			],
		});
		store = TestBed.inject(InviteStore);
	});

	afterEach(() => TestBed.resetTestingModule());

	it('publishes defaults, server allowance, loading, read failure, and retry', () => {
		expect(store.codes()).toEqual([]);
		expect(store.allowance()).toEqual({ allowance: 5, used: 0, remaining: 5 });
		expect(store.loading()).toBe(false);
		expect(store.readError()).toBe('');
		expect(store.action()).toBeNull();
		expect(store.message()).toBe('');
		expect(store.actionError()).toBe('');

		gateway.setInvites({
			allowance: 7,
			used: 2,
			remaining: 5,
			codes: [invite()],
		});
		expect(store.codes()).toEqual([invite()]);
		expect(store.allowance()).toEqual({ allowance: 7, used: 2, remaining: 5 });
		gateway.setLoading(true);
		expect(store.loading()).toBe(true);
		gateway.setReadFailure({ kind: 'unavailable' });
		expect(store.readError()).toContain('could not be loaded');
		store.retry();
		expect(gateway.invites.reload).toHaveBeenCalledOnce();
	});

	it('validates and creates trimmed invite codes with duplicate suppression', () => {
		store.create('TRACK-01');
		expect(gateway.createInvite).not.toHaveBeenCalled();
		gateway.setInvites({ allowance: 1, used: 1, remaining: 0, codes: [] });
		store.create('TRACK-01');
		expect(gateway.createInvite).not.toHaveBeenCalled();
		gateway.setInvites({ allowance: 5, used: 0, remaining: 5, codes: [] });

		store.create('bad!');
		expect(store.actionError()).toContain('6–32 characters');
		expect(store.outcome()).toMatchObject({ status: 'failed', operationId: 1 });

		store.create('  TRACK-02  ');
		expect(gateway.createInvite).toHaveBeenCalledWith('TRACK-02');
		expect(store.action()).toBe('create');
		store.create('TRACK-03');
		store.copy('TRACK-03');
		store.revoke(invite());
		expect(gateway.createInvite).toHaveBeenCalledOnce();
		expect(clipboard.copy).not.toHaveBeenCalled();
		expect(gateway.revokeInvite).not.toHaveBeenCalled();

		gateway.succeedCreate(invite({ id: 'invite-2', code: 'TRACK-02' }));
		expect(store.message()).toBe('Invite code created.');
		expect(gateway.invites.reload).toHaveBeenCalledOnce();
		store.clearOutcome();
		expect(store.outcome()).toEqual({ status: 'idle', operationId: null });
	});

	it('copies codes without reloading and maps clipboard failures', () => {
		store.copy('TRACK-01');
		expect(store.action()).toBe('copy');
		clipboard.succeedCopy();
		expect(store.message()).toBe('Copied TRACK-01.');
		expect(gateway.invites.reload).not.toHaveBeenCalled();

		clipboard.resetCopy();
		store.copy('TRACK-02');
		clipboard.failCopy();
		expect(store.actionError()).toBe('The invite code could not be copied.');
	});

	it('revokes only available codes and publishes success state', () => {
		store.revoke(invite({ status: 'reserved' }));
		expect(gateway.revokeInvite).not.toHaveBeenCalled();
		const available = invite();
		store.revoke(available);
		expect(gateway.revokeInvite).toHaveBeenCalledWith(available);
		expect(store.action()).toBe('revoke:invite-1');
		gateway.succeedRevoke();
		expect(store.message()).toBe('Invite code revoked.');
		expect(gateway.invites.reload).toHaveBeenCalledOnce();
	});

	it('preserves server messages and maps generic create and revoke failures', () => {
		gateway.setInvites({ allowance: 5, used: 0, remaining: 5, codes: [] });
		store.create('TRACK-01');
		gateway.failCreate({
			kind: 'http',
			status: 409,
			message: 'That invite is already in use.',
		});
		expect(store.actionError()).toBe('That invite is already in use.');

		gateway.resetCreate();
		store.create('TRACK-02');
		gateway.failCreate({ kind: 'unavailable' });
		expect(store.actionError()).toBe('Invite code could not be created.');

		store.revoke(invite());
		gateway.failRevoke({ kind: 'unavailable' });
		expect(store.actionError()).toBe('Invite code could not be revoked.');
		expect(store.message()).toBe('');
	});
});
