import type * as z from 'zod/mini';
import {
	int,
	literal,
	minLength,
	nonnegative,
	nullable,
	optional,
	strictObject,
	string,
	union,
} from 'zod/mini';
import { type DrivingAnalysis, subjectSeed } from './driving-analysis.models';

export const reidentificationContextSchema = strictObject({
	runId: string().check(minLength(1)),
	segmentId: string().check(minLength(1)),
	acceptedDigest: string().check(minLength(1)),
	pendingCorrection: optional(
		strictObject({ correctionId: string().check(minLength(1)), subjectSeed }),
	),
	gap: strictObject({
		startTimestampMs: int().check(nonnegative()),
		reason: union([
			literal('ambiguous-identity'),
			literal('occluded'),
			literal('missing'),
		]),
	}),
});
export const reidentificationResponseSchema = strictObject({
	context: nullable(reidentificationContextSchema),
});
export const correctionReceiptSchema = strictObject({
	correctionId: string().check(minLength(1)),
	runId: string().check(minLength(1)),
	segmentId: string().check(minLength(1)),
});
export type ReidentificationContext = z.infer<
	typeof reidentificationContextSchema
>;
export type CorrectionReceipt = z.infer<typeof correctionReceiptSchema>;
export type ReidentifySubjectCommand = Readonly<{
	analysisId: string;
	context: ReidentificationContext;
	subjectSeed: DrivingAnalysis['subjectSeed'];
}>;
