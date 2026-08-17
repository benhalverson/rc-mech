import { describe, expect, test, vi } from 'vitest';
import type {
	RaceRecordingAuthority,
	RaceRecordingContentMetadata,
} from './race-recording-authority';
import {
	parseSingleByteRange,
	raceRecordingPlaybackResponse,
} from './race-recording-playback';

const identity = { ownerId: 'owner-1', recordingId: 'recording-1' };
const metadata: RaceRecordingContentMetadata = {
	size: 10,
	contentType: 'video/mp4',
	etag: '"etag-1"',
	uploaded: new Date('2026-08-17T10:00:00.500Z'),
};

const fixture = () => {
	const content = vi.fn(async () => ({
		...metadata,
		body: new Blob(['0123456789']).stream(),
	}));
	return {
		content,
		authority: { content } as unknown as Pick<
			RaceRecordingAuthority,
			'content'
		>,
	};
};

const request = (headers?: HeadersInit, method = 'GET') =>
	new Request(
		'https://chassisnotes.com/api/v1/race-videos/recording-1/content',
		{
			method,
			headers,
		},
	);

describe('Race-recording playback', () => {
	test('parses bounded open, closed, clamped, and suffix ranges', () => {
		expect(parseSingleByteRange('bytes=2-5', 10)).toEqual({
			offset: 2,
			length: 4,
		});
		expect(parseSingleByteRange(' bytes=7- ', 10)).toEqual({
			offset: 7,
			length: 3,
		});
		expect(parseSingleByteRange('bytes=8-99', 10)).toEqual({
			offset: 8,
			length: 2,
		});
		expect(parseSingleByteRange('bytes=-3', 10)).toEqual({
			offset: 7,
			length: 3,
		});
		expect(parseSingleByteRange('bytes=-99', 10)).toEqual({
			offset: 0,
			length: 10,
		});
		for (const invalid of [
			'items=0-1',
			'bytes=-',
			'bytes=0-1,3-4',
			'bytes=-0',
			'bytes=10-',
			'bytes=6-5',
			`bytes=${Number.MAX_SAFE_INTEGER + 1}-`,
			`bytes=0-${Number.MAX_SAFE_INTEGER + 1}`,
		])
			expect(parseSingleByteRange(invalid, 10)).toBeNull();
		expect(parseSingleByteRange('bytes=0-1', 0)).toBeNull();
	});

	test('streams full and partial private content with exact metadata', async () => {
		const full = fixture();
		let response = await raceRecordingPlaybackResponse(
			full.authority,
			identity,
			request(),
			metadata,
		);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-length')).toBe('10');
		expect(response.headers.get('accept-ranges')).toBe('bytes');
		expect(response.headers.get('cache-control')).toBe('private, no-store');
		expect(response.headers.get('content-type')).toBe('video/mp4');
		expect(response.headers.get('etag')).toBe('"etag-1"');
		expect(response.headers.get('x-content-type-options')).toBe('nosniff');
		expect(await response.text()).toBe('0123456789');
		expect(full.content).toHaveBeenCalledWith(identity, undefined);

		const partial = fixture();
		response = await raceRecordingPlaybackResponse(
			partial.authority,
			identity,
			request({ range: 'bytes=2-5' }),
			metadata,
		);
		expect(response.status).toBe(206);
		expect(response.headers.get('content-range')).toBe('bytes 2-5/10');
		expect(response.headers.get('content-length')).toBe('4');
		expect(partial.content).toHaveBeenCalledWith(identity, {
			offset: 2,
			length: 4,
		});
	});

	test('answers HEAD and unsatisfiable ranges without reading R2 content', async () => {
		const value = fixture();
		let response = await raceRecordingPlaybackResponse(
			value.authority,
			identity,
			request({ range: 'bytes=-2' }, 'HEAD'),
			metadata,
		);
		expect(response.status).toBe(206);
		expect(response.headers.get('content-range')).toBe('bytes 8-9/10');
		expect(await response.text()).toBe('');
		expect(value.content).not.toHaveBeenCalled();

		response = await raceRecordingPlaybackResponse(
			value.authority,
			identity,
			request({ range: 'bytes=50-' }),
			metadata,
		);
		expect(response.status).toBe(416);
		expect(response.headers.get('content-range')).toBe('bytes */10');
		expect(value.content).not.toHaveBeenCalled();
	});

	test('enforces entity-tag and date preconditions in HTTP order', async () => {
		for (const headers of [
			{ 'if-match': '"other"' },
			{ 'if-match': 'W/"etag-1"' },
			{ 'if-unmodified-since': 'Sun, 17 Aug 2026 09:59:59 GMT' },
		]) {
			const value = fixture();
			const response = await raceRecordingPlaybackResponse(
				value.authority,
				identity,
				request(headers),
				metadata,
			);
			expect(response.status).toBe(412);
			expect(value.content).not.toHaveBeenCalled();
		}

		for (const headers of [
			{ 'if-none-match': '*' },
			{ 'if-none-match': '"other", W/"etag-1"' },
			{ 'if-modified-since': 'Sun, 17 Aug 2026 10:00:00 GMT' },
		]) {
			const value = fixture();
			const response = await raceRecordingPlaybackResponse(
				value.authority,
				identity,
				request(headers),
				metadata,
			);
			expect(response.status).toBe(304);
			expect(value.content).not.toHaveBeenCalled();
		}

		for (const headers of [
			{ 'if-match': '*', 'if-unmodified-since': 'invalid' },
			{ 'if-match': '"etag-1"', 'if-unmodified-since': 'yesterday' },
			{ 'if-none-match': '"other"', 'if-modified-since': 'tomorrow' },
			{ 'if-modified-since': 'invalid' },
		]) {
			const value = fixture();
			const response = await raceRecordingPlaybackResponse(
				value.authority,
				identity,
				request(headers),
				metadata,
			);
			expect(response.status).toBe(200);
			expect(value.content).toHaveBeenCalledOnce();
		}
	});

	test('honors only strong current If-Range validators', async () => {
		for (const ifRange of [
			'"other"',
			'W/"etag-1"',
			'Sun, 17 Aug 2026 09:59:59 GMT',
			'invalid',
		]) {
			const value = fixture();
			const response = await raceRecordingPlaybackResponse(
				value.authority,
				identity,
				request({ range: 'bytes=2-5', 'if-range': ifRange }),
				metadata,
			);
			expect(response.status).toBe(200);
			expect(value.content).toHaveBeenCalledWith(identity, undefined);
		}

		for (const ifRange of ['"etag-1"', 'Sun, 17 Aug 2026 10:00:00 GMT']) {
			const value = fixture();
			const response = await raceRecordingPlaybackResponse(
				value.authority,
				identity,
				request({ range: 'bytes=2-5', 'if-range': ifRange }),
				metadata,
			);
			expect(response.status).toBe(206);
			expect(value.content).toHaveBeenCalledWith(identity, {
				offset: 2,
				length: 4,
			});
		}
	});
});
