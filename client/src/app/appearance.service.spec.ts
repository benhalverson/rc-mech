import { DOCUMENT } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	APPEARANCE_STORAGE_KEY,
	AppearanceService,
	isAppearancePreference,
} from './appearance.service';

interface AppearanceFixture {
	readonly root: { setAttribute: ReturnType<typeof vi.fn> };
	readonly storage: Storage;
	readonly media: {
		matches: boolean;
		addEventListener: ReturnType<typeof vi.fn>;
		removeEventListener: ReturnType<typeof vi.fn>;
		emit(matches: boolean): void;
	};
	readonly service: AppearanceService;
}

const storageFixture = (stored: string | null = null): Storage => ({
	length: stored === null ? 0 : 1,
	clear: vi.fn(),
	getItem: vi.fn(() => stored),
	key: vi.fn(() => null),
	removeItem: vi.fn(),
	setItem: vi.fn(),
});

const createFixture = ({
	stored = null,
	systemDark = false,
}: {
	stored?: string | null;
	systemDark?: boolean;
} = {}): AppearanceFixture => {
	let listener: ((event: MediaQueryListEvent) => void) | undefined;
	const media = {
		matches: systemDark,
		addEventListener: vi.fn(
			(_type: string, next: (event: MediaQueryListEvent) => void) => {
				listener = next;
			},
		),
		removeEventListener: vi.fn(),
		emit(matches: boolean): void {
			this.matches = matches;
			listener?.({ matches } as MediaQueryListEvent);
		},
	};
	const storage = storageFixture(stored);
	const root = { setAttribute: vi.fn() };
	const document = {
		documentElement: root,
		defaultView: {
			localStorage: storage,
			matchMedia: vi.fn(() => media),
		},
	} as unknown as Document;
	TestBed.configureTestingModule({
		providers: [AppearanceService, { provide: DOCUMENT, useValue: document }],
	});
	return {
		root,
		storage,
		media,
		service: TestBed.inject(AppearanceService),
	};
};

describe('AppearanceService', () => {
	afterEach(() => TestBed.resetTestingModule());

	it('recognizes only supported appearance preferences', () => {
		expect(isAppearancePreference('system')).toBe(true);
		expect(isAppearancePreference('light')).toBe(true);
		expect(isAppearancePreference('dark')).toBe(true);
		expect(isAppearancePreference('contrast')).toBe(false);
		expect(isAppearancePreference(null)).toBe(false);
	});

	it('follows live system changes and persists explicit choices', () => {
		const { root, storage, media, service } = createFixture({
			systemDark: true,
		});

		expect(service.preference()).toBe('system');
		expect(service.resolved()).toBe('dark');
		expect(service.persistenceAvailable()).toBe(true);
		expect(root.setAttribute).toHaveBeenNthCalledWith(
			1,
			'data-appearance-preference',
			'system',
		);
		expect(root.setAttribute).toHaveBeenNthCalledWith(
			2,
			'data-appearance',
			'dark',
		);

		media.emit(false);
		expect(service.resolved()).toBe('light');
		expect(root.setAttribute).toHaveBeenLastCalledWith(
			'data-appearance',
			'light',
		);

		service.setAppearance('light');
		expect(storage.setItem).toHaveBeenCalledWith(
			APPEARANCE_STORAGE_KEY,
			'light',
		);
		media.emit(true);
		expect(service.resolved()).toBe('light');

		service.setAppearance('system');
		expect(storage.removeItem).toHaveBeenCalledWith(APPEARANCE_STORAGE_KEY);
		expect(service.resolved()).toBe('dark');

		TestBed.resetTestingModule();
		expect(media.removeEventListener).toHaveBeenCalledWith(
			'change',
			expect.any(Function),
		);
	});

	it('restores a valid explicit preference and ignores malformed storage', () => {
		const restored = createFixture({ stored: 'dark' }).service;
		expect(restored.preference()).toBe('dark');
		expect(restored.resolved()).toBe('dark');

		TestBed.resetTestingModule();
		const malformed = createFixture({ stored: 'sepia' }).service;
		expect(malformed.preference()).toBe('system');
		expect(malformed.resolved()).toBe('light');
	});

	it('keeps in-memory choices when storage reads and writes fail', () => {
		const root = { setAttribute: vi.fn() };
		const storage = storageFixture();
		vi.mocked(storage.getItem).mockImplementation(() => {
			throw new Error('read denied');
		});
		vi.mocked(storage.setItem).mockImplementation(() => {
			throw new Error('write denied');
		});
		vi.mocked(storage.removeItem).mockImplementation(() => {
			throw new Error('remove denied');
		});
		TestBed.configureTestingModule({
			providers: [
				AppearanceService,
				{
					provide: DOCUMENT,
					useValue: {
						documentElement: root,
						defaultView: { localStorage: storage },
					},
				},
			],
		});
		const service = TestBed.inject(AppearanceService);
		expect(service.persistenceAvailable()).toBe(false);

		service.setAppearance('dark');
		expect(service.preference()).toBe('dark');
		expect(service.resolved()).toBe('dark');
		expect(service.persistenceAvailable()).toBe(false);
		service.setAppearance('system');
		expect(service.preference()).toBe('system');
	});

	it('is safe without a browser document or persistence capability', () => {
		const root = { setAttribute: vi.fn() };
		TestBed.configureTestingModule({
			providers: [
				AppearanceService,
				{
					provide: DOCUMENT,
					useValue: { documentElement: root, defaultView: null },
				},
			],
		});
		const service = TestBed.inject(AppearanceService);
		expect(service.preference()).toBe('system');
		expect(service.resolved()).toBe('light');
		expect(service.persistenceAvailable()).toBe(false);

		service.setAppearance('dark');
		expect(service.resolved()).toBe('dark');
	});

	it('survives blocked storage and media-query capabilities', () => {
		const root = { setAttribute: vi.fn() };
		const view = {
			get localStorage(): Storage {
				throw new Error('storage blocked');
			},
			matchMedia: vi.fn(() => {
				throw new Error('media query blocked');
			}),
		};
		TestBed.configureTestingModule({
			providers: [
				AppearanceService,
				{
					provide: DOCUMENT,
					useValue: { documentElement: root, defaultView: view },
				},
			],
		});
		const service = TestBed.inject(AppearanceService);

		expect(service.persistenceAvailable()).toBe(false);
		expect(service.resolved()).toBe('light');
	});

	it('survives media-query objects without usable event listeners', () => {
		const root = { setAttribute: vi.fn() };
		const storage = storageFixture();
		const configure = (media: object): AppearanceService => {
			TestBed.configureTestingModule({
				providers: [
					AppearanceService,
					{
						provide: DOCUMENT,
						useValue: {
							documentElement: root,
							defaultView: {
								localStorage: storage,
								matchMedia: () => media,
							},
						},
					},
				],
			});
			return TestBed.inject(AppearanceService);
		};

		expect(configure({ matches: false }).resolved()).toBe('light');
		TestBed.resetTestingModule();
		expect(
			configure({
				matches: true,
				addEventListener: () => {
					throw new Error('listener blocked');
				},
			}).resolved(),
		).toBe('dark');
	});
});
