import {
	HttpErrorResponse,
	HttpEventType,
	provideHttpClient,
} from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom, toArray } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RACE_RECORDING_PART_SIZE } from './race-recording.models';
import {
	parseRaceRecordingCollection,
	parseRaceRecordingMutation,
	RaceRecordingGateway,
	raceRecordingGatewayFailure,
} from './race-recording-gateway';

const recording = {
	id: 'recording-1',
	carId: 'car-1',
	driveSessionId: 'drive-1',
	fileName: 'Race.mp4',
	contentType: 'video/mp4',
	sizeBytes: 3,
	partSizeBytes: RACE_RECORDING_PART_SIZE,
	status: 'uploading',
	uploadedBytes: 0,
	uploadedPartNumbers: [],
	createdAt: '2026-08-16T20:00:00.000Z',
	updatedAt: '2026-08-16T20:00:00.000Z',
	expiresAt: '2026-08-23T20:00:00.000Z',
	completedAt: null,
} as const;

describe('RaceRecordingGateway', () => {
	let gateway: RaceRecordingGateway;
	let http: HttpTestingController;

	beforeEach(() => {
		TestBed.configureTestingModule({
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				RaceRecordingGateway,
			],
		});
		gateway = TestBed.inject(RaceRecordingGateway);
		http = TestBed.inject(HttpTestingController);
	});

	afterEach(() => {
		http.verify();
		TestBed.resetTestingModule();
	});

	it('parses strict collections and mutations', () => {
		expect(parseRaceRecordingCollection({})).toEqual([]);
		expect(parseRaceRecordingCollection({ raceVideos: [recording] })).toEqual([
			recording,
		]);
		expect(parseRaceRecordingMutation({ raceVideo: recording })).toEqual(
			recording,
		);
		expect(() => parseRaceRecordingCollection({ raceVideos: [42] })).toThrow(
			'invalid',
		);
		expect(() => parseRaceRecordingMutation({})).toThrow('invalid');
		for (const raceVideo of [
			{ ...recording, sizeBytes: 0 },
			{ ...recording, sizeBytes: 1.5 },
			{ ...recording, partSizeBytes: 0 },
			{ ...recording, uploadedBytes: -1 },
			{ ...recording, uploadedPartNumbers: [1], uploadedBytes: 0 },
			{ ...recording, uploadedPartNumbers: [1, 1], uploadedBytes: 6 },
			{ ...recording, uploadedPartNumbers: [2], uploadedBytes: 3 },
			{ ...recording, completedAt: 'now' },
			{ ...recording, status: 'validating' },
		])
			expect(() => parseRaceRecordingMutation({ raceVideo })).toThrow(
				'invalid',
			);
		const twoPartRecording = {
			...recording,
			sizeBytes: RACE_RECORDING_PART_SIZE + 3,
			uploadedBytes: RACE_RECORDING_PART_SIZE + 3,
			uploadedPartNumbers: [1, 2],
			status: 'validating',
			completedAt: '2026-08-16T20:01:00.000Z',
		} as const;
		expect(parseRaceRecordingMutation({ raceVideo: twoPartRecording })).toEqual(
			twoPartRecording,
		);
	});

	it('maps transport, API, parser, and unknown failures', () => {
		expect(
			raceRecordingGatewayFailure(new HttpErrorResponse({ status: 0 })),
		).toEqual({ kind: 'unavailable' });
		expect(
			raceRecordingGatewayFailure(
				new HttpErrorResponse({
					status: 409,
					error: { error: 'Choose the same file.' },
				}),
			),
		).toEqual({
			kind: 'rejected-response',
			status: 409,
			message: 'Choose the same file.',
		});
		expect(
			raceRecordingGatewayFailure(new HttpErrorResponse({ status: 503 })),
		).toEqual({ kind: 'http', status: 503 });
		let parserError: unknown;
		try {
			parseRaceRecordingMutation({});
		} catch (error) {
			parserError = error;
		}
		expect(raceRecordingGatewayFailure(parserError)).toEqual({
			kind: 'invalid-response',
		});
		expect(raceRecordingGatewayFailure('offline')).toEqual({
			kind: 'unavailable',
		});
	});

	it('owns the authenticated collection resource and refresh', async () => {
		expect(gateway.collectionFailure()).toBeNull();
		gateway.selectCar('car/one');
		gateway.selectCar('car/one');
		await vi.waitFor(() => {
			const request = http.expectOne('/api/v1/cars/car%2Fone/race-videos');
			expect(request.request.withCredentials).toBe(true);
			request.flush({ raceVideos: [recording] });
		});
		await vi.waitFor(() => expect(gateway.collection.value()).toHaveLength(1));

		gateway.refresh();
		await vi.waitFor(() =>
			http
				.expectOne('/api/v1/cars/car%2Fone/race-videos')
				.flush('offline', { status: 503, statusText: 'Unavailable' }),
		);
		await vi.waitFor(() =>
			expect(gateway.collectionFailure()).toEqual({
				kind: 'http',
				status: 503,
			}),
		);
	});

	it('creates, transfers with progress, completes, and deletes recordings', async () => {
		const created = firstValueFrom(
			gateway.createUpload({
				carId: 'car/one',
				driveSessionId: 'drive/one',
				fileName: 'Race.mp4',
				contentType: 'video/mp4',
				sizeBytes: 3,
				requestId: 'request-1',
			}),
		);
		let request = http.expectOne(
			'/api/v1/cars/car%2Fone/drives/drive%2Fone/race-videos',
		);
		expect(request.request.method).toBe('POST');
		expect(request.request.withCredentials).toBe(true);
		expect(request.request.body).toEqual({
			fileName: 'Race.mp4',
			contentType: 'video/mp4',
			sizeBytes: 3,
			requestId: 'request-1',
		});
		request.flush({ raceVideo: recording });
		await expect(created).resolves.toEqual(recording);

		const events = firstValueFrom(
			gateway
				.uploadPart({
					carId: 'car/one',
					driveSessionId: 'drive/one',
					recordingId: 'recording/one',
					partNumber: 1,
					transferRequestId: 'stable-transfer',
					bytes: new Blob(['abc']),
				})
				.pipe(toArray()),
		);
		request = http.expectOne(
			'/api/v1/race-videos/recording%2Fone/upload-parts/1',
		);
		expect(request.request.method).toBe('PUT');
		expect(request.request.headers.get('x-transfer-request-id')).toBe(
			'stable-transfer',
		);
		request.event({ type: HttpEventType.Sent });
		request.event({ type: HttpEventType.UploadProgress, loaded: 2 });
		request.flush({
			raceVideo: {
				...recording,
				uploadedBytes: 3,
				uploadedPartNumbers: [1],
			},
		});
		expect(await events).toEqual([
			{ kind: 'progress', loaded: 2, total: 3 },
			{
				kind: 'completed',
				recording: expect.objectContaining({ uploadedBytes: 3 }),
			},
		]);

		const completed = firstValueFrom(
			gateway.completeUpload({
				carId: 'car-1',
				driveSessionId: 'drive-1',
				recordingId: 'recording-1',
			}),
		);
		request = http.expectOne('/api/v1/race-videos/recording-1/complete');
		expect(request.request.body).toBeNull();
		request.flush({
			raceVideo: {
				...recording,
				status: 'validating',
				uploadedBytes: recording.sizeBytes,
				uploadedPartNumbers: [1],
				completedAt: '2026-08-16T20:01:00.000Z',
			},
		});
		await expect(completed).resolves.toMatchObject({ status: 'validating' });

		const deleted = firstValueFrom(
			gateway.deleteRecording({
				carId: 'car-1',
				driveSessionId: 'drive-1',
				recordingId: 'recording-1',
			}),
		);
		request = http.expectOne('/api/v1/race-videos/recording-1');
		expect(request.request.method).toBe('DELETE');
		request.flush(null);
		await expect(deleted).resolves.toBeNull();
	});

	it('maps failures from every mutation boundary', async () => {
		const create = firstValueFrom(
			gateway.createUpload({
				carId: 'car-1',
				driveSessionId: 'drive-1',
				fileName: 'Race.mp4',
				contentType: 'video/mp4',
				sizeBytes: 3,
				requestId: 'request-1',
			}),
		);
		http
			.expectOne('/api/v1/cars/car-1/drives/drive-1/race-videos')
			.flush('down', { status: 503, statusText: 'Unavailable' });
		await expect(create).rejects.toEqual({ kind: 'http', status: 503 });

		const part = firstValueFrom(
			gateway.uploadPart({
				carId: 'car-1',
				driveSessionId: 'drive-1',
				recordingId: 'recording-1',
				partNumber: 1,
				transferRequestId: 'transfer-1',
				bytes: new Blob(['abc']),
			}),
		);
		http
			.expectOne('/api/v1/race-videos/recording-1/upload-parts/1')
			.flush('down', { status: 503, statusText: 'Unavailable' });
		await expect(part).rejects.toEqual({ kind: 'http', status: 503 });

		const complete = firstValueFrom(
			gateway.completeUpload({
				carId: 'car-1',
				driveSessionId: 'drive-1',
				recordingId: 'recording-1',
			}),
		);
		http
			.expectOne('/api/v1/race-videos/recording-1/complete')
			.flush('down', { status: 503, statusText: 'Unavailable' });
		await expect(complete).rejects.toEqual({ kind: 'http', status: 503 });

		const cancel = firstValueFrom(
			gateway.deleteRecording({
				carId: 'car-1',
				driveSessionId: 'drive-1',
				recordingId: 'recording-1',
			}),
		);
		http
			.expectOne('/api/v1/race-videos/recording-1')
			.flush('down', { status: 503, statusText: 'Unavailable' });
		await expect(cancel).rejects.toEqual({ kind: 'http', status: 503 });
	});
});
