import { describe, expect, test, vi } from 'vitest';
import type { RaceRecordingContent } from './race-recording-authority';
import {
	RACE_RECORDING_READ_WINDOW,
	raceRecordingContentStream,
} from './race-recording-content-stream';

const content = (
	length: number,
	etag = '"same"',
	cancel = vi.fn(),
): RaceRecordingContent => ({
	size: length,
	contentType: 'video/mp4',
	etag,
	uploaded: new Date(0),
	body: new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new Uint8Array(length));
			controller.close();
		},
		cancel,
	}),
});

describe('Bounded recording storage reads', () => {
	test('cancels a pending reader without publishing another chunk', async () => {
		const cancel = vi.fn();
		const reader = raceRecordingContentStream(
			{ ...content(1), body: new ReadableStream({ cancel }) },
			{ offset: 0, length: 1 },
			vi.fn(),
		).getReader();
		const pending = reader.read();
		await Promise.resolve();
		await reader.cancel('seek');
		expect(await pending).toEqual({ value: undefined, done: true });
		expect(cancel).toHaveBeenCalledWith('seek');
	});

	test('retains the stream failure when cancelling storage also fails', async () => {
		const first = {
			...content(1),
			body: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array(2));
				},
				cancel() {
					return Promise.reject(new Error('cancel failed'));
				},
			}),
		};
		const reader = raceRecordingContentStream(
			first,
			{ offset: 0, length: 1 },
			vi.fn(),
		).getReader();
		await expect(reader.read()).rejects.toThrow('exceeded');
	});

	test('ignores a pending storage rejection after cancellation', async () => {
		let fail!: (reason: Error) => void;
		const read = vi.fn(
			() =>
				new Promise<RaceRecordingContent>((_resolve, reject) => {
					fail = reject;
				}),
		);
		const reader = raceRecordingContentStream(
			content(RACE_RECORDING_READ_WINDOW),
			{ offset: 0, length: RACE_RECORDING_READ_WINDOW + 1 },
			read,
		).getReader();
		await reader.read();
		const pending = reader.read();
		await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
		await reader.cancel();
		fail(new Error('storage failed'));
		expect((await pending).done).toBe(true);
	});

	test('reads exact subsequent offsets only when downstream asks', async () => {
		const read = vi.fn(async () => content(3));
		const reader = raceRecordingContentStream(
			content(RACE_RECORDING_READ_WINDOW),
			{ offset: 7, length: RACE_RECORDING_READ_WINDOW + 3 },
			read,
		).getReader();
		expect(read).not.toHaveBeenCalled();
		expect((await reader.read()).value?.byteLength).toBe(
			RACE_RECORDING_READ_WINDOW,
		);
		expect(read).not.toHaveBeenCalled();
		expect((await reader.read()).value?.byteLength).toBe(3);
		expect(read).toHaveBeenCalledExactlyOnceWith({
			offset: 7 + RACE_RECORDING_READ_WINDOW,
			length: 3,
		});
		expect((await reader.read()).done).toBe(true);
	});

	test('cancellation prevents later window reads', async () => {
		const cancel = vi.fn();
		const first = {
			...content(RACE_RECORDING_READ_WINDOW),
			body: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array(1));
				},
				cancel,
			}),
		};
		const read = vi.fn();
		const reader = raceRecordingContentStream(
			first,
			{ offset: 0, length: RACE_RECORDING_READ_WINDOW + 1 },
			read,
		).getReader();
		await reader.read();
		await reader.cancel('seek');
		expect(cancel).toHaveBeenCalledWith('seek');
		expect(read).not.toHaveBeenCalled();
	});

	test('cancels a storage body that arrives after downstream cancellation', async () => {
		let finish!: (value: RaceRecordingContent) => void;
		const read = vi.fn(
			() =>
				new Promise<RaceRecordingContent>((resolve) => {
					finish = resolve;
				}),
		);
		const reader = raceRecordingContentStream(
			content(RACE_RECORDING_READ_WINDOW),
			{ offset: 0, length: RACE_RECORDING_READ_WINDOW + 1 },
			read,
		).getReader();
		await reader.read();
		const pending = reader.read();
		await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
		await reader.cancel();
		const cancel = vi.fn();
		finish({ ...content(1), body: new ReadableStream({ cancel }) });
		await pending;
		await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
	});

	test('rejects truncated, oversized, and replaced storage windows', async () => {
		for (const size of [0, 2]) {
			const reader = raceRecordingContentStream(
				content(size),
				{ offset: 0, length: 1 },
				vi.fn(),
			).getReader();
			if (size === 0) await reader.read();
			await expect(reader.read()).rejects.toThrow(
				size === 0 ? 'truncated' : 'exceeded',
			);
		}
		const cancel = vi.fn();
		const reader = raceRecordingContentStream(
			content(RACE_RECORDING_READ_WINDOW),
			{ offset: 0, length: RACE_RECORDING_READ_WINDOW + 1 },
			async () => ({
				...content(1, '"changed"'),
				body: new ReadableStream({ cancel }),
			}),
		).getReader();
		await reader.read();
		await expect(reader.read()).rejects.toThrow('changed');
		expect(cancel).toHaveBeenCalledOnce();
	});
});
