import { describe, expect, test, vi } from 'vitest';
import type { AppDependencies } from '../../app-dependencies';
import {
	DrivingAnalysisAuthority,
	DrivingAnalysisAuthorityError,
} from '../../driving-analysis/analysis/driving-analysis-authority';
import { createHonoFixture } from '../../testing/hono-fixture';

const ANALYSIS_ID = '66666666-6666-4666-8666-666666666666';
const createBody = {
	requestId: '55555555-5555-4555-8555-555555555555',
	raceVideoId: '33333333-3333-4333-8333-333333333333',
	approvedTrackMapVersionId: '44444444-4444-4444-8444-444444444444',
	raceWindow: { startTimestampMs: 120_000, endTimestampMs: 720_000 },
	subjectSeed: {
		timestampMs: 180_000,
		frameIndex: 1800,
		identity: 'subject-1',
		box: { x: 0.25, y: 0.4, width: 0.08, height: 0.06 },
	},
};
const analysis = {
	id: ANALYSIS_ID,
	requestId: createBody.requestId,
	carId: 'car-1',
	driveSessionId: 'drive-1',
	raceVideoId: createBody.raceVideoId,
	raceWindow: createBody.raceWindow,
	approvedTrackMapVersionId: createBody.approvedTrackMapVersionId,
	subjectSeed: createBody.subjectSeed,
	status: 'queued',
	stage: 'preparation',
	progress: 0,
	stateVersion: 1,
};
const json = (body: unknown): RequestInit => ({
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(body),
});

describe('Driving-analysis routes', () => {
	test('returns one stable accepted creation without waiting for processing', async () => {
		const create = vi.fn(async () => ({ analysis, created: true }));
		const get = vi.fn(async () => analysis);
		const retry = vi.fn(async () => ({ analysis, retried: true }));
		const authority = {
			create,
			get,
			retry,
		} as unknown as DrivingAnalysisAuthority;
		const { request } = createHonoFixture({
			drivingAnalysisAuthority: (() =>
				authority) satisfies AppDependencies['drivingAnalysisAuthority'],
		});
		const path = '/api/v1/cars/car-1/drives/drive-1/driving-analyses';
		expect(
			(await request(path, { ...json(createBody), body: '{' })).status,
		).toBe(400);
		expect(
			(
				await request(
					path,
					json({
						...createBody,
						subjectSeed: { ...createBody.subjectSeed, timestampMs: 720_000 },
					}),
				)
			).status,
		).toBe(400);

		let response = await request(path, json(createBody));
		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({ drivingAnalysis: analysis });
		expect(create).toHaveBeenCalledWith({
			ownerId: 'owner-1',
			carId: 'car-1',
			driveSessionId: 'drive-1',
			input: createBody,
		});

		create.mockResolvedValueOnce({ analysis, created: false });
		response = await request(path, json(createBody));
		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({ drivingAnalysis: analysis });

		response = await request(`/api/v1/driving-analyses/${ANALYSIS_ID}`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ drivingAnalysis: analysis });
		expect(get).toHaveBeenCalledWith('owner-1', ANALYSIS_ID);

		const retryPath = `/api/v1/driving-analyses/${ANALYSIS_ID}/retry`;
		expect((await request(retryPath, { ...json({}), body: '{' })).status).toBe(
			400,
		);
		expect((await request(retryPath, json({}))).status).toBe(400);
		response = await request(
			retryPath,
			json({ expectedStateVersion: analysis.stateVersion }),
		);
		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({ drivingAnalysis: analysis });
		expect(retry).toHaveBeenCalledWith(
			'owner-1',
			ANALYSIS_ID,
			analysis.stateVersion,
		);
	});

	test.each([
		['INVALID_INPUT', 400],
		['NOT_FOUND', 404],
		['CONFLICT', 409],
		['QUOTA_EXCEEDED', 409],
		['RATE_LIMITED', 429],
		['WORKFLOW_UNAVAILABLE', 503],
	] as const)('maps safe %s authority failures to %i', async (code, status) => {
		const create = vi
			.fn()
			.mockRejectedValue(
				new DrivingAnalysisAuthorityError(code, 'Safe analysis failure'),
			);
		const authority = { create } as unknown as DrivingAnalysisAuthority;
		const { request } = createHonoFixture({
			drivingAnalysisAuthority: () => authority,
		});
		const response = await request(
			'/api/v1/cars/car-1/drives/drive-1/driving-analyses',
			json(createBody),
		);
		expect(response.status).toBe(status);
		expect(await response.json()).toEqual({ error: 'Safe analysis failure' });
	});

	test('does not disguise unexpected authority failures', async () => {
		const authority = {
			create: vi.fn().mockRejectedValue(new Error('unexpected')),
		} as unknown as DrivingAnalysisAuthority;
		const { request } = createHonoFixture({
			drivingAnalysisAuthority: () => authority,
		});
		const response = await request(
			'/api/v1/cars/car-1/drives/drive-1/driving-analyses',
			json(createBody),
		);
		expect(response.status).toBe(500);
	});
});
