import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { expect, test } from 'vitest';
import { z } from 'zod';
import {
	sourceFrameErrorResponseSchema,
	sourceFrameRequestSchema,
	sourceFrameResponseSchema,
} from './subject-frame-contracts';

const named = z.object({ name: z.string(), value: z.unknown() });
const fixtures = z
	.object({
		acceptedRequests: z.array(named),
		acceptedResponses: z.array(named),
		rejectedResponses: z.array(z.unknown()),
		invalidRequests: z.array(named),
		invalidResponses: z.array(z.unknown()),
		invalidRejectedResponses: z.array(z.unknown()),
	})
	.parse(
		JSON.parse(
			readFileSync(
				new URL(
					'../../../containers/driving-analysis/tests/fixtures/source-frame/contracts.json',
					import.meta.url,
				),
				'utf8',
			),
		),
	);

test.each(fixtures.acceptedRequests)(
	'accepts shared source frame request $name',
	({ value }) => {
		expect(sourceFrameRequestSchema.parse(value)).toEqual(value);
	},
);
test.each(fixtures.acceptedResponses)(
	'accepts shared source frame response $name',
	({ value }) => {
		expect(sourceFrameResponseSchema.parse(value)).toEqual(value);
	},
);
test.each(fixtures.invalidRequests)(
	'rejects shared invalid source frame request $name',
	({ value }) => {
		expect(sourceFrameRequestSchema.safeParse(value).success).toBe(false);
	},
);
test.each(fixtures.rejectedResponses)(
	'accepts the shared safe error envelope %#',
	(value) => {
		expect(sourceFrameErrorResponseSchema.parse(value)).toEqual(value);
	},
);
test.each(fixtures.invalidResponses)(
	'rejects malformed shared successful response %#',
	(value) => {
		expect(sourceFrameResponseSchema.safeParse(value).success).toBe(false);
	},
);
test.each(fixtures.invalidRejectedResponses)(
	'rejects malformed shared error envelope %#',
	(value) => {
		expect(sourceFrameErrorResponseSchema.safeParse(value).success).toBe(false);
	},
);
