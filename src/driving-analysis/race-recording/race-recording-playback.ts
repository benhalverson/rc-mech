import {
	type RaceRecordingAuthority,
	type RaceRecordingContentMetadata,
	type RaceRecordingIdentity,
} from './race-recording-authority';

type ByteRange = Readonly<{ offset: number; length: number }>;

const entityTagValues = (value: string): readonly string[] =>
	value
		.split(',')
		.map((candidate) => candidate.trim())
		.filter(Boolean);

const weakTag = (value: string): string =>
	value.startsWith('W/') ? value.slice(2) : value;

const dateAtHttpPrecision = (value: Date): number =>
	Math.floor(value.getTime() / 1000) * 1000;

const parsedHttpDate = (value: string | null): number | null => {
	if (value === null) return null;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : null;
};

const preconditionStatus = (
	headers: Headers,
	metadata: RaceRecordingContentMetadata,
): 304 | 412 | null => {
	const ifMatch = headers.get('if-match');
	if (
		ifMatch !== null &&
		ifMatch !== '*' &&
		!entityTagValues(ifMatch).some(
			(candidate) => !candidate.startsWith('W/') && candidate === metadata.etag,
		)
	)
		return 412;
	if (ifMatch === null) {
		const unmodifiedSince = parsedHttpDate(headers.get('if-unmodified-since'));
		if (
			unmodifiedSince !== null &&
			dateAtHttpPrecision(metadata.uploaded) > unmodifiedSince
		)
			return 412;
	}

	const ifNoneMatch = headers.get('if-none-match');
	if (
		ifNoneMatch !== null &&
		(ifNoneMatch === '*' ||
			entityTagValues(ifNoneMatch).some(
				(candidate) => weakTag(candidate) === weakTag(metadata.etag),
			))
	)
		return 304;
	if (ifNoneMatch === null) {
		const modifiedSince = parsedHttpDate(headers.get('if-modified-since'));
		if (
			modifiedSince !== null &&
			dateAtHttpPrecision(metadata.uploaded) <= modifiedSince
		)
			return 304;
	}
	return null;
};

export const parseSingleByteRange = (
	value: string,
	size: number,
): ByteRange | null => {
	const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
	if (!match || size < 1) return null;
	const [, startText = '', endText = ''] = match;
	if (startText === '' && endText === '') return null;
	if (startText === '') {
		const suffix = Number(endText);
		if (!Number.isSafeInteger(suffix) || suffix < 1) return null;
		const length = Math.min(suffix, size);
		return { offset: size - length, length };
	}
	const start = Number(startText);
	if (!Number.isSafeInteger(start) || start >= size) return null;
	const requestedEnd = endText === '' ? size - 1 : Number(endText);
	if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) return null;
	const end = Math.min(requestedEnd, size - 1);
	return { offset: start, length: end - start + 1 };
};

const rangeIsCurrent = (
	value: string | null,
	metadata: RaceRecordingContentMetadata,
): boolean => {
	if (value === null) return true;
	if (value.startsWith('W/')) return false;
	if (value.startsWith('"')) return value === metadata.etag;
	const timestamp = parsedHttpDate(value);
	return (
		timestamp !== null && dateAtHttpPrecision(metadata.uploaded) <= timestamp
	);
};

const responseHeaders = (metadata: RaceRecordingContentMetadata): Headers =>
	new Headers({
		'accept-ranges': 'bytes',
		'cache-control': 'private, no-store',
		'content-type': metadata.contentType,
		etag: metadata.etag,
		'last-modified': metadata.uploaded.toUTCString(),
		'x-content-type-options': 'nosniff',
	});

export const raceRecordingPlaybackResponse = async (
	authority: Pick<RaceRecordingAuthority, 'content'>,
	identity: RaceRecordingIdentity,
	request: Request,
	metadata: RaceRecordingContentMetadata,
): Promise<Response> => {
	const headers = responseHeaders(metadata);
	const precondition = preconditionStatus(request.headers, metadata);
	if (precondition !== null)
		return new Response(null, { status: precondition, headers });

	const rangeHeader = request.headers.get('range');
	let range: ByteRange | undefined;
	if (
		rangeHeader !== null &&
		rangeIsCurrent(request.headers.get('if-range'), metadata)
	) {
		range = parseSingleByteRange(rangeHeader, metadata.size) ?? undefined;
		if (!range) {
			headers.set('content-range', `bytes */${metadata.size}`);
			return new Response(null, { status: 416, headers });
		}
	}

	if (range) {
		headers.set(
			'content-range',
			`bytes ${range.offset}-${range.offset + range.length - 1}/${metadata.size}`,
		);
		headers.set('content-length', String(range.length));
	} else headers.set('content-length', String(metadata.size));
	if (request.method === 'HEAD')
		return new Response(null, { status: range ? 206 : 200, headers });

	const content = await authority.content(identity, range);
	return new Response(content.body, {
		status: range ? 206 : 200,
		headers,
	});
};
