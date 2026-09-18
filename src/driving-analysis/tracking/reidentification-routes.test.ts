import { afterEach, describe, expect, test, vi } from 'vitest';
import {
	RUN_ID,
	SEGMENT_ID,
	submissionFixture,
} from '../../testing/driving-analysis-tracking-fixtures';
import { createHonoFixture } from '../../testing/hono-fixture';
import {
	TrackingAuthority,
	TrackingAuthorityError,
	type TrackingWorkflowContext,
} from './tracking-authority';

const correctionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const path = '/api/v1/driving-analyses/analysis-1/reidentification';
const command = {
	runId: RUN_ID,
	segmentId: SEGMENT_ID,
	correctionId,
	acceptedDigest: 'a'.repeat(64),
	subjectSeed: submissionFixture().trackingRequest.subjectSeed,
};
const post = (body: unknown = command): RequestInit => ({
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(body),
});
const queueRun = (fixture: ReturnType<typeof createHonoFixture>) =>
	fixture.d1.queue({
		kind: 'first',
		value: { id: RUN_ID, workflowId: 'workflow-1' },
	});

afterEach(() => vi.restoreAllMocks());

describe('Subject re-identification routes', () => {
	test.each(['saved', 'initial', 'stale'])(
		'recovers safe correction receipt after restart: %s',
		async (kind) => {
			const fixture = createHonoFixture();
			queueRun(fixture);
			fixture.d1.queue({
				kind: 'first',
				value:
					kind === 'initial'
						? null
						: {
								id: correctionId,
								seedSourceId: kind === 'stale' ? 'missing' : SEGMENT_ID,
								seedJson: JSON.stringify(command.subjectSeed),
							},
			});
			vi.spyOn(
				TrackingAuthority.prototype,
				'publicProvenance',
			).mockResolvedValue({
				runId: RUN_ID,
				profileDigest: 'b'.repeat(64),
				segments: [
					{
						segmentId: SEGMENT_ID,
						order: 0,
						outcome: 'tracking-gap',
						gap: { startTimestampMs: 50, reason: 'missing' },
						artifact: {
							artifactId: SEGMENT_ID,
							digest: command.acceptedDigest,
							contractDigest: 'c'.repeat(64),
							byteCount: 10,
						},
					},
					{
						segmentId: correctionId,
						order: 1,
						outcome: null,
						gap: null,
						artifact: null,
					},
				],
			});
			const response = await fixture.request(path);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				context:
					kind === 'saved'
						? {
								runId: RUN_ID,
								segmentId: SEGMENT_ID,
								acceptedDigest: command.acceptedDigest,
								gap: { startTimestampMs: 50, reason: 'missing' },
								pendingCorrection: {
									correctionId,
									subjectSeed: command.subjectSeed,
								},
							}
						: null,
			});
		},
	);
	test('requires authentication and owner-scoped current-run authority', async () => {
		expect((await createHonoFixture(false).request(path)).status).toBe(401);
		const fixture = createHonoFixture();
		fixture.d1.queue({ kind: 'first', value: null });
		expect((await fixture.request(path)).status).toBe(404);
		expect(fixture.d1.queries[0]?.values).toEqual([
			'owner-1',
			'analysis-1',
			'active',
		]);
		expect(fixture.d1.queries[0]?.query).toContain(
			'"driving_analysis"."workflow_id" = "tracking_run"."workflow_id"',
		);
		expect((await fixture.request(path, post({}))).status).toBe(400);
		expect((await fixture.request(path, { ...post(), body: '{' })).status).toBe(
			400,
		);
	});
	test('returns only safe accepted gap context and no context after resolution', async () => {
		const fixture = createHonoFixture();
		const provenance = vi.spyOn(
			TrackingAuthority.prototype,
			'publicProvenance',
		);
		for (const segments of [
			[],
			[
				{
					segmentId: SEGMENT_ID,
					order: 0,
					outcome: 'tracking-gap' as const,
					gap: { startTimestampMs: 250, reason: 'missing' as const },
					artifact: {
						artifactId: correctionId,
						digest: command.acceptedDigest,
						contractDigest: 'b'.repeat(64),
						byteCount: 10,
					},
				},
			],
		]) {
			queueRun(fixture);
			provenance.mockResolvedValueOnce({
				runId: RUN_ID,
				profileDigest: 'c'.repeat(64),
				segments,
			});
			const response = await fixture.request(path);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				context: segments.length
					? {
							runId: RUN_ID,
							segmentId: SEGMENT_ID,
							acceptedDigest: command.acceptedDigest,
							gap: { startTimestampMs: 250, reason: 'missing' },
						}
					: null,
			});
		}
	});
	test('commits before waking and retries the same saved correction after a lost event acknowledgement', async () => {
		const fixture = createHonoFixture();
		const trace: string[] = [];
		const reidentify = vi
			.spyOn(TrackingAuthority.prototype, 'reidentify')
			.mockImplementation(async () => {
				trace.push('commit');
				return {
					runId: RUN_ID,
					segmentId: correctionId,
				} as TrackingWorkflowContext;
			});
		const sendEvent = vi.fn(async () => {
			trace.push('wake');
		});
		Object.assign(fixture.env.DRIVING_ANALYSIS_WORKFLOW, {
			get: vi.fn(async () => ({ sendEvent })),
		});
		sendEvent.mockRejectedValueOnce(new Error('lost event acknowledgement'));
		queueRun(fixture);
		expect((await fixture.request(path, post())).status).toBe(503);
		queueRun(fixture);
		const response = await fixture.request(path, post());
		expect(response.status).toBe(202);
		expect(await response.json()).toEqual({
			correctionId,
			runId: RUN_ID,
			segmentId: correctionId,
		});
		expect(reidentify).toHaveBeenCalledWith(
			{
				ownerId: 'owner-1',
				analysisId: 'analysis-1',
				workflowId: 'workflow-1',
				runId: RUN_ID,
				segmentId: SEGMENT_ID,
			},
			correctionId,
			command.acceptedDigest,
			command.subjectSeed,
		);
		expect(trace).toEqual(['commit', 'commit', 'wake']);
		expect(sendEvent).toHaveBeenLastCalledWith({
			type: 'tracking-reidentified',
			payload: { correctionId },
		});
	});
	test('rejects stale runs, conflicting corrections, and fails unexpected infrastructure errors', async () => {
		const fixture = createHonoFixture();
		queueRun(fixture);
		expect(
			(await fixture.request(path, post({ ...command, runId: correctionId })))
				.status,
		).toBe(409);
		const reidentify = vi.spyOn(TrackingAuthority.prototype, 'reidentify');
		queueRun(fixture);
		reidentify.mockRejectedValueOnce(
			new TrackingAuthorityError('CONFLICT', 'Gap already resolved'),
		);
		expect((await fixture.request(path, post())).status).toBe(409);
		queueRun(fixture);
		reidentify.mockRejectedValueOnce(new Error('D1 unavailable'));
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		expect((await fixture.request(path, post())).status).toBe(500);
	});
});
