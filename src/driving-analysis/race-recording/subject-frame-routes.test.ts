import { afterEach, expect, test, vi } from 'vitest';
import { createHonoFixture } from '../../testing/hono-fixture';
import { DrivingAnalysisAuthorityError } from '../analysis/driving-analysis-authority';
import { MAX_SUBJECT_FRAME_BYTES } from './subject-frame-contracts';
import { SubjectFrames } from './subject-frames';

afterEach(() => vi.restoreAllMocks());
const path = '/api/v1/race-videos/recording/subject-frame';
const imagePath = `/api/v1/race-videos/recording/subject-frames/2/content?checksum=${'a'.repeat(64)}`;

test.each([
	['NOT_FOUND', 404],
	['INVALID_INPUT', 400],
	['SOURCE_UNAVAILABLE', 409],
] as const)(
	'reports frame authority failure %s safely',
	async (code, status) => {
		vi.spyOn(SubjectFrames.prototype, 'select').mockRejectedValue(
			new DrivingAnalysisAuthorityError(code, 'Frame unavailable'),
		);
		const response = await createHonoFixture().request(
			`${path}?timestampMs=125`,
		);
		expect(response.status).toBe(status);
		expect(response.headers.get('cache-control')).toBe('private, no-store');
		expect(await response.json()).toEqual({ error: 'Frame unavailable' });
	},
);

test.each([
	`${path}?timestampMs=-1`,
	path,
	imagePath.replace('/2/', '/-1/'),
	imagePath.replace('checksum=', 'missing='),
])('rejects invalid frame query %s without extraction', async (url) => {
	const select = vi.spyOn(SubjectFrames.prototype, 'select');
	expect((await createHonoFixture().request(url)).status).toBe(400);
	expect(select).not.toHaveBeenCalled();
});

test.each([
	null,
	'',
	'AAAA',
	'/wAA',
	'!',
	btoa('x'.repeat(MAX_SUBJECT_FRAME_BYTES + 1)),
])('never delivers missing or malformed frame bytes', async (imageBase64) => {
	vi.spyOn(SubjectFrames.prototype, 'select').mockResolvedValue({
		contractVersion: 'source-frame.v1',
		frameIndex: 2,
		timestampMs: 200,
		sourceChecksumSha256: 'a'.repeat(64),
		imageBase64,
	});
	const response = await createHonoFixture().request(imagePath);
	expect(response.status).toBe(503);
	expect(await response.json()).toEqual({
		error: 'The verified source frame is unavailable',
	});
});
