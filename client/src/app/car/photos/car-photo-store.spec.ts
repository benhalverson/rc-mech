import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject, type Observable } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	CarPhoto,
	PhotoGatewayFailure,
	PhotoMutationCommand,
} from '../car.models';
import { CarPhotoGateway } from './car-photo-gateway';
import { CarPhotoStore } from './car-photo-store';

const photo = (overrides: Partial<CarPhoto> = {}): CarPhoto => ({
	id: 'photo-1',
	carId: 'car-1',
	contentType: 'image/webp',
	createdAt: '2026-08-09T18:00:00.000Z',
	sortOrder: 0,
	...overrides,
});

class FakePhotoGateway {
	private readonly collectionValue = signal<{ photos: CarPhoto[] } | undefined>(
		undefined,
	);
	private readonly collectionLoading = signal(false);
	private readonly readFailure = signal<PhotoGatewayFailure | null>(null);
	private uploadResult = new Subject<CarPhoto>();
	private replaceResult = new Subject<CarPhoto>();
	private primaryResult = new Subject<CarPhoto>();
	private deleteResult = new Subject<{
		deleted: boolean;
		primaryPhotoId?: string | null;
	}>();
	private reorderResult = new Subject<CarPhoto[]>();

	readonly collection = {
		hasValue: () => this.collectionValue() !== undefined,
		value: () => this.collectionValue() ?? { photos: [] },
		isLoading: this.collectionLoading,
	};
	readonly failure = vi.fn(() => this.readFailure());
	readonly selectCar = vi.fn();
	readonly refresh = vi.fn();
	readonly upload = vi.fn(
		(_carId: string, _file: File): Observable<CarPhoto> =>
			this.uploadResult.asObservable(),
	);
	readonly replace = vi.fn(
		(_photo: CarPhoto, _file: File): Observable<CarPhoto> =>
			this.replaceResult.asObservable(),
	);
	readonly setPrimary = vi.fn(
		(_photo: CarPhoto): Observable<CarPhoto> =>
			this.primaryResult.asObservable(),
	);
	readonly delete = vi.fn(
		(
			_photo: CarPhoto,
		): Observable<{
			deleted: boolean;
			primaryPhotoId?: string | null;
		}> => this.deleteResult.asObservable(),
	);
	readonly reorder = vi.fn(
		(_carId: string, _photos: readonly CarPhoto[]): Observable<CarPhoto[]> =>
			this.reorderResult.asObservable(),
	);

	setCollection(value: CarPhoto[] | undefined): void {
		this.collectionValue.set(value ? { photos: value } : undefined);
	}

	setLoading(value: boolean): void {
		this.collectionLoading.set(value);
	}

	setFailure(value: PhotoGatewayFailure | null): void {
		this.readFailure.set(value);
	}

	reset(kind: PhotoMutationCommand['kind']): void {
		if (kind === 'upload') this.uploadResult = new Subject<CarPhoto>();
		else if (kind === 'replace') this.replaceResult = new Subject<CarPhoto>();
		else if (kind === 'primary') this.primaryResult = new Subject<CarPhoto>();
		else if (kind === 'delete')
			this.deleteResult = new Subject<{
				deleted: boolean;
				primaryPhotoId?: string | null;
			}>();
		else this.reorderResult = new Subject<CarPhoto[]>();
	}

	succeed(kind: 'upload' | 'replace' | 'primary', value: CarPhoto): void;
	succeed(
		kind: 'delete',
		value: { deleted: boolean; primaryPhotoId?: string | null },
	): void;
	succeed(kind: 'reorder', value: CarPhoto[]): void;
	succeed(
		kind: PhotoMutationCommand['kind'],
		value:
			| CarPhoto
			| CarPhoto[]
			| { deleted: boolean; primaryPhotoId?: string | null },
	): void {
		if (kind === 'upload') {
			this.uploadResult.next(value as CarPhoto);
			this.uploadResult.complete();
		} else if (kind === 'replace') {
			this.replaceResult.next(value as CarPhoto);
			this.replaceResult.complete();
		} else if (kind === 'primary') {
			this.primaryResult.next(value as CarPhoto);
			this.primaryResult.complete();
		} else if (kind === 'delete') {
			this.deleteResult.next(
				value as { deleted: boolean; primaryPhotoId?: string | null },
			);
			this.deleteResult.complete();
		} else {
			this.reorderResult.next(value as CarPhoto[]);
			this.reorderResult.complete();
		}
	}

	fail(kind: PhotoMutationCommand['kind'], failure: PhotoGatewayFailure): void {
		if (kind === 'upload') this.uploadResult.error(failure);
		else if (kind === 'replace') this.replaceResult.error(failure);
		else if (kind === 'primary') this.primaryResult.error(failure);
		else if (kind === 'delete') this.deleteResult.error(failure);
		else this.reorderResult.error(failure);
	}
}

describe('CarPhotoStore', () => {
	let gateway: FakePhotoGateway;
	let store: InstanceType<typeof CarPhotoStore>;
	const file = new File(['image'], 'car.webp', { type: 'image/webp' });

	beforeEach(() => {
		gateway = new FakePhotoGateway();
		TestBed.configureTestingModule({
			providers: [
				CarPhotoStore,
				{ provide: CarPhotoGateway, useValue: gateway },
			],
		});
		store = TestBed.inject(CarPhotoStore);
	});

	afterEach(() => TestBed.resetTestingModule());

	it('publishes resource state and maps canonical read failures', () => {
		expect(store.photos()).toEqual([]);
		expect(store.loading()).toBe(false);
		expect(store.failure()).toBeNull();
		gateway.setCollection([photo()]);
		expect(store.photos()).toEqual([photo()]);
		gateway.setLoading(true);
		expect(store.loading()).toBe(true);

		gateway.setFailure({ kind: 'http', status: 401 });
		expect(store.failure()).toEqual({
			message: 'Your garage session has expired. Sign in again to continue.',
			retryable: false,
		});
		gateway.setFailure({ kind: 'invalid-response' });
		expect(store.failure()).toMatchObject({
			message: 'The photo gallery could not be loaded.',
			retryable: true,
		});
		gateway.setFailure({ kind: 'unavailable' });
		expect(store.failure()?.retryable).toBe(true);
	});

	it('selects one car, suppresses duplicates, uploads, retries, and clears outcomes', () => {
		store.mutate({ kind: 'upload', file });
		expect(gateway.upload).not.toHaveBeenCalled();
		gateway.setCollection([photo()]);
		store.selectCar('car-1');
		store.selectCar('car-1');
		expect(gateway.selectCar).toHaveBeenCalledOnce();

		store.mutate({ kind: 'upload', file });
		expect(store.action()).toBe('upload');
		expect(store.outcome()).toMatchObject({
			status: 'pending',
			operationId: 1,
		});
		store.mutate({ kind: 'upload', file });
		expect(gateway.upload).toHaveBeenCalledOnce();
		const uploaded = photo({ id: 'photo-2', sortOrder: 1 });
		gateway.succeed('upload', uploaded);
		expect(store.photos()).toEqual([photo(), uploaded]);
		expect(store.outcome()).toMatchObject({
			status: 'succeeded',
			operationId: 1,
		});
		expect(store.action()).toBeNull();
		expect(gateway.refresh).toHaveBeenCalledOnce();

		store.clearOutcome();
		expect(store.outcome()).toEqual({ status: 'idle', operationId: null });
		store.retry();
		expect(gateway.refresh).toHaveBeenCalledTimes(2);
	});

	it('builds local photo state when a mutation finishes before the read resource', () => {
		store.selectCar('car-1');
		store.mutate({ kind: 'upload', file });
		const uploaded = photo({ id: 'photo-before-read' });
		gateway.succeed('upload', uploaded);
		expect(store.photos()).toEqual([uploaded]);
	});

	it('applies replace, primary, delete, and both reorder response variants', () => {
		const first = photo();
		const second = photo({ id: 'photo-2', sortOrder: 1, isPrimary: true });
		gateway.setCollection([first, second]);
		store.selectCar('car-1');

		store.mutate({ kind: 'replace', photo: first, file });
		expect(store.action()).toBe('replace:photo-1');
		const replacement = { ...first, contentType: 'image/png' };
		gateway.succeed('replace', replacement);
		expect(store.photos()).toEqual([replacement, second]);

		gateway.reset('primary');
		store.mutate({ kind: 'primary', photo: replacement });
		expect(store.action()).toBe('primary:photo-1');
		gateway.succeed('primary', { ...replacement, isPrimary: true });
		expect(store.photos()).toEqual([
			expect.objectContaining({ id: 'photo-1', isPrimary: true }),
			expect.objectContaining({
				id: 'photo-2',
				isPrimary: false,
				primary: false,
			}),
		]);

		gateway.reset('delete');
		store.mutate({ kind: 'delete', photo: replacement });
		expect(store.action()).toBe('delete:photo-1');
		gateway.succeed('delete', { deleted: true, primaryPhotoId: 'photo-2' });
		expect(store.photos()).toEqual([
			expect.objectContaining({
				id: 'photo-2',
				isPrimary: true,
				primary: true,
			}),
		]);

		const third = photo({ id: 'photo-3', sortOrder: 1 });
		gateway.reset('upload');
		store.mutate({ kind: 'upload', file });
		gateway.succeed('upload', third);
		const reversed = [third, second];
		gateway.reset('reorder');
		store.mutate({ kind: 'reorder', photos: reversed });
		expect(store.action()).toBe('reorder');
		expect(
			store.photos().map(({ id, sortOrder }) => ({ id, sortOrder })),
		).toEqual([
			{ id: 'photo-3', sortOrder: 0 },
			{ id: 'photo-2', sortOrder: 1 },
		]);
		gateway.succeed('reorder', []);
		expect(store.photos().map((item) => item.id)).toEqual([
			'photo-3',
			'photo-2',
		]);

		gateway.reset('reorder');
		const serverOrder = [
			{ ...second, sortOrder: 0 },
			{ ...third, sortOrder: 1 },
		];
		store.mutate({ kind: 'reorder', photos: serverOrder });
		gateway.succeed('reorder', serverOrder);
		expect(store.photos()).toEqual(serverOrder);
	});

	it('restores optimistic order and maps every mutation error message', () => {
		const first = photo();
		const second = photo({ id: 'photo-2', sortOrder: 1 });
		gateway.setCollection([first, second]);
		store.selectCar('car-1');

		const fail = (
			command: PhotoMutationCommand,
			failure: PhotoGatewayFailure,
			expected: string,
		): void => {
			gateway.reset(command.kind);
			store.mutate(command);
			gateway.fail(command.kind, failure);
			expect(store.error()).toContain(expected);
		};

		fail({ kind: 'upload', file }, { kind: 'unavailable' }, 'uploaded');
		fail(
			{ kind: 'replace', photo: first, file },
			{ kind: 'unavailable' },
			'replaced',
		);
		fail(
			{ kind: 'primary', photo: first },
			{ kind: 'unavailable' },
			'primary photo',
		);
		fail({ kind: 'delete', photo: first }, { kind: 'unavailable' }, 'deleted');
		fail(
			{ kind: 'reorder', photos: [second, first] },
			{ kind: 'unavailable' },
			'order',
		);
		expect(store.photos()).toEqual([first, second]);

		for (const [status, expected] of [
			[401, 'session has expired'],
			[403, 'not available'],
			[404, 'not available'],
			[409, 'archived'],
			[413, 'rejected this image'],
			[500, 'uploaded'],
		] as const)
			fail({ kind: 'upload', file }, { kind: 'http', status }, expected);

		expect(store.outcome().operationId).toBe(11);
		store.clearOutcome();
		expect(store.error()).toBe('');
	});

	it('ignores stale success and failure responses after route reuse', () => {
		store.selectCar('car-1');
		store.mutate({ kind: 'upload', file });
		store.selectCar('car-2');
		gateway.succeed('upload', photo({ id: 'stale' }));
		expect(store.outcome().status).toBe('idle');
		expect(gateway.refresh).not.toHaveBeenCalled();

		gateway.reset('upload');
		store.mutate({ kind: 'upload', file });
		store.selectCar('car-3');
		gateway.fail('upload', { kind: 'unavailable' });
		expect(store.outcome().status).toBe('idle');
		expect(store.error()).toBe('');
	});

	it('restores the resource gallery when the first optimistic reorder fails', () => {
		const first = photo();
		const second = photo({ id: 'photo-2', sortOrder: 1 });
		gateway.setCollection([first, second]);
		store.selectCar('car-1');
		store.mutate({ kind: 'reorder', photos: [second, first] });
		expect(store.photos()[0].id).toBe('photo-2');
		gateway.fail('reorder', { kind: 'unavailable' });
		expect(store.photos()).toEqual([first, second]);
	});
});
