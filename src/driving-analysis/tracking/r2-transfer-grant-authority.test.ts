import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
	ATTEMPT_ID,
	inferenceProfileFixture,
	LEASE_ID,
	PROFILE_DIGEST,
	RUN_ID,
	SEGMENT_ID,
	submissionFixture,
	TRANSFER_ID,
} from '../../testing/driving-analysis-tracking-fixtures';
import {
	preparedDescriptorFixture,
	preparedObjectsFixture,
	trackingRunInputFixture,
} from '../../testing/prepared-track-view-fixtures';
import { createSqliteD1, type SqliteD1Fixture } from '../../testing/sqlite-d1';
import { PreparedTrackViewAuthority } from './prepared-track-view-authority';
import {
	Aws4FetchR2TransferGrantSigner,
	INPUT_TRANSFER_GRANT_SECONDS,
	issueTrackingTransferGrantCommandSchema,
	OUTPUT_TRANSFER_GRANT_SECONDS,
	R2TransferGrantAuthority,
	r2TransferGrantAuthority,
	type TransferGrantSigner,
} from './r2-transfer-grant-authority';
import { TrackingAuthority } from './tracking-authority';

const OWNER_ID = 'owner-1';
const NOW_SECONDS = 2_000_000_000;
const NOW = new Date(NOW_SECONDS * 1000).toISOString();
const INPUT_DIGEST =
	'b9fcffe729ec029ce020dc5e1583d9573579d6576ffd8bfc036e05ca77b8f133';
const migrationDirectory = resolve(
	dirname(fileURLToPath(import.meta.url)),
	'../../../migrations',
);
const migrations = [
	'0019_tracking_authority.sql',
	'0020_immutable_track_view.sql',
]
	.map((name) => readFileSync(resolve(migrationDirectory, name), 'utf8'))
	.join('\n');

let fixture: SqliteD1Fixture | undefined;

afterEach(() => {
	fixture?.close();
	fixture = undefined;
});

const authorityFixture = async () => {
	fixture = createSqliteD1();
	fixture.exec(migrations);
	const authority = new TrackingAuthority(fixture.database);
	const prepared = new PreparedTrackViewAuthority(fixture.database);
	await authority.createRun({
		runId: RUN_ID,
		analysisId: 'analysis-1',
		ownerId: OWNER_ID,
		sequence: 1,
		workflowId: 'workflow-1',
		profile: inferenceProfileFixture(),
		inputDigest: INPUT_DIGEST,
		createdAt: NOW,
	});
	await prepared.pinRunInput({
		ownerId: OWNER_ID,
		input: trackingRunInputFixture(),
		createdAt: NOW,
	});
	await prepared.acceptPreparedTrackView({
		ownerId: OWNER_ID,
		runId: RUN_ID,
		expectedRunVersion: 1,
		expectedInputDigest: INPUT_DIGEST,
		descriptor: preparedDescriptorFixture(INPUT_DIGEST),
		objects: preparedObjectsFixture(),
		deleteAfter: new Date((NOW_SECONDS + 86_400) * 1000).toISOString(),
		createdAt: NOW,
	});
	const segment = await authority.createSegment({
		ownerId: OWNER_ID,
		runId: RUN_ID,
		segmentId: SEGMENT_ID,
		order: 0,
		seed: {
			kind: 'initial',
			sourceId: null,
			value: submissionFixture().trackingRequest.subjectSeed,
		},
		preparedMediaId: preparedDescriptorFixture(INPUT_DIGEST).preparedMediaId,
		specificationVersion: 'tracking-segment-spec.v1',
		availabilityDeadlineAt: (NOW_SECONDS + 86_400) * 1000,
		createdAt: NOW,
	});
	await authority.activateAttempt({
		ownerId: OWNER_ID,
		runId: RUN_ID,
		segmentId: SEGMENT_ID,
		attemptId: ATTEMPT_ID,
		leaseId: LEASE_ID,
		fence: 7,
		expectedCurrentAttemptId: null,
		createdAt: NOW,
	});
	return { authority, database: fixture.database, segment };
};

const issueCommand = (specificationDigest: string) => ({
	ownerId: OWNER_ID,
	runId: RUN_ID,
	segmentId: SEGMENT_ID,
	attemptId: ATTEMPT_ID,
	leaseId: LEASE_ID,
	fencingToken: 7,
	specificationDigest,
	profileDigest: PROFILE_DIGEST,
	transferRequestId: TRANSFER_ID,
	role: 'prepared-media' as const,
	method: 'GET' as const,
});

const successfulWitness = () => ({
	witness: vi.fn(async () => ({ status: 'ok' as const, expiresAt: 1 })),
});

const makeOutputReady = async (authority: TrackingAuthority) => {
	await authority.transitionAttempt({
		ownerId: OWNER_ID,
		runId: RUN_ID,
		segmentId: SEGMENT_ID,
		attemptId: ATTEMPT_ID,
		leaseId: LEASE_ID,
		fence: 7,
		expectedState: 'active',
		nextState: 'processing',
		progress: 20,
		safeFailureCode: null,
		updatedAt: NOW,
	});
	await authority.transitionAttempt({
		ownerId: OWNER_ID,
		runId: RUN_ID,
		segmentId: SEGMENT_ID,
		attemptId: ATTEMPT_ID,
		leaseId: LEASE_ID,
		fence: 7,
		expectedState: 'processing',
		nextState: 'output-ready',
		progress: 90,
		safeFailureCode: null,
		updatedAt: NOW,
	});
};

describe('R2TransferGrantAuthority', () => {
	test('issues and renews one exact GET grant without changing logical identity', async () => {
		const { authority, segment } = await authorityFixture();
		const witness = successfulWitness();
		const sign = vi
			.fn<TransferGrantSigner['sign']>()
			.mockResolvedValueOnce('https://r2.example/first?signature=one')
			.mockResolvedValueOnce('https://r2.example/second?signature=two');
		let now = NOW_SECONDS;
		const grants = new R2TransferGrantAuthority(
			authority,
			witness,
			{ sign },
			() => now,
		);
		const command = issueCommand(segment.specificationDigest);
		const first = await grants.issue(command);
		expect(first).toMatchObject({
			contractVersion: 'tracking-provider.v1',
			runId: command.runId,
			segmentId: command.segmentId,
			attemptId: command.attemptId,
			leaseId: command.leaseId,
			fencingToken: command.fencingToken,
			specificationDigest: command.specificationDigest,
			profileDigest: command.profileDigest,
			transferRequestId: command.transferRequestId,
			role: command.role,
			method: command.method,
			expiresAt: NOW_SECONDS + INPUT_TRANSFER_GRANT_SECONDS,
		});
		expect(sign).toHaveBeenCalledWith(
			{
				objectKey: expect.stringMatching(/\/track-view\.mp4$/),
				contentType: 'video/mp4',
				role: 'prepared-media',
				method: 'GET',
			},
			INPUT_TRANSFER_GRANT_SECONDS,
			NOW_SECONDS,
		);

		now += 60;
		const renewed = await grants.issue(command);
		expect(renewed.transferRequestId).toBe(first.transferRequestId);
		expect(renewed.url).not.toBe(first.url);
		expect(renewed.expiresAt).toBe(
			NOW_SECONDS + 60 + INPUT_TRANSFER_GRANT_SECONDS,
		);
		expect(witness.witness).toHaveBeenCalledTimes(2);
	});

	test('fails closed before signing when the lease witness is stale or unavailable', async () => {
		const { authority, segment } = await authorityFixture();
		const sign = vi.fn<TransferGrantSigner['sign']>();
		const stale = new R2TransferGrantAuthority(
			authority,
			{ witness: vi.fn(async () => ({ status: 'stale' as const })) },
			{ sign },
			() => NOW_SECONDS,
		);
		await expect(
			stale.issue(issueCommand(segment.specificationDigest)),
		).rejects.toMatchObject({ code: 'LEASE_MISMATCH' });
		expect(sign).not.toHaveBeenCalled();

		const unavailable = new R2TransferGrantAuthority(
			authority,
			{
				witness: vi.fn(() =>
					Promise.reject(new Error('internal coordinator detail')),
				),
			},
			{ sign },
			() => NOW_SECONDS,
		);
		await expect(
			unavailable.issue(issueCommand(segment.specificationDigest)),
		).rejects.toEqual(
			expect.objectContaining({
				name: 'TrackingTransferGrantError',
				message: 'LEASE_MISMATCH',
			}),
		);
	});

	test('redacts signing failures after authority and lease checks', async () => {
		const { authority, segment } = await authorityFixture();
		const grants = new R2TransferGrantAuthority(
			authority,
			successfulWitness(),
			{
				sign: vi.fn(() =>
					Promise.reject(
						new Error('https://secret.example/object?signature=do-not-leak'),
					),
				),
			},
			() => NOW_SECONDS,
		);
		const promise = grants.issue(issueCommand(segment.specificationDigest));
		await expect(promise).rejects.toMatchObject({ code: 'SIGNING_FAILED' });
		await expect(promise).rejects.not.toThrow(/secret|signature/i);
	});

	test('redacts malformed signer output instead of exposing it through validation', async () => {
		const { authority, segment } = await authorityFixture();
		const grants = new R2TransferGrantAuthority(
			authority,
			successfulWitness(),
			{
				sign: vi.fn(async () => 'http://secret.example/?signature=do-not-leak'),
			},
			() => NOW_SECONDS,
		);
		const promise = grants.issue(issueCommand(segment.specificationDigest));
		await expect(promise).rejects.toMatchObject({ code: 'SIGNING_FAILED' });
		await expect(promise).rejects.not.toThrow(/secret|signature/i);
	});

	test('issues a bounded PUT grant only for output-ready authority', async () => {
		const { authority, segment } = await authorityFixture();
		await makeOutputReady(authority);
		const sign = vi
			.fn<TransferGrantSigner['sign']>()
			.mockResolvedValue('https://r2.example/output?signature=one');
		const grants = new R2TransferGrantAuthority(
			authority,
			successfulWitness(),
			{ sign },
			() => NOW_SECONDS,
		);
		const value = await grants.issue({
			...issueCommand(segment.specificationDigest),
			role: 'observation-artifact',
			method: 'PUT',
		});
		expect(value.expiresAt).toBe(NOW_SECONDS + OUTPUT_TRANSFER_GRANT_SECONDS);
		expect(sign).toHaveBeenCalledWith(
			expect.objectContaining({
				objectKey: expect.stringMatching(/^tracking-staging\//),
				contentType: 'application/octet-stream',
				method: 'PUT',
			}),
			OUTPUT_TRANSFER_GRANT_SECONDS,
			NOW_SECONDS,
		);
	});

	test('uses the system clock by default and composes from Worker bindings', async () => {
		const { authority, database, segment } = await authorityFixture();
		const sign = vi
			.fn<TransferGrantSigner['sign']>()
			.mockResolvedValue('https://r2.example/input?signature=one');
		const grants = new R2TransferGrantAuthority(
			authority,
			successfulWitness(),
			{ sign },
		);
		const before = Math.floor(Date.now() / 1000);
		const value = await grants.issue(issueCommand(segment.specificationDigest));
		expect(value.expiresAt).toBeGreaterThanOrEqual(
			before + INPUT_TRANSFER_GRANT_SECONDS,
		);

		const namespace = {
			getByName: vi.fn(() => successfulWitness()),
		};
		const environment = {
			DB: database,
			GPU_LEASE_COORDINATOR: namespace,
			R2_ACCOUNT_ID: 'a'.repeat(32),
			R2_ACCESS_KEY_ID: 'access-key',
			R2_SECRET_ACCESS_KEY: 'secret-key',
		} satisfies Parameters<typeof r2TransferGrantAuthority>[0];
		expect(r2TransferGrantAuthority(environment)).toBeInstanceOf(
			R2TransferGrantAuthority,
		);
		expect(namespace.getByName).toHaveBeenCalledWith('rtx-3090');
		const incompleteEnvironment = {
			DB: database,
			GPU_LEASE_COORDINATOR: namespace,
		} satisfies Parameters<typeof r2TransferGrantAuthority>[0];
		expect(() => r2TransferGrantAuthority(incompleteEnvironment)).toThrow(
			'CONFIGURATION_INVALID',
		);
	});

	test('rejects method-role mismatch before touching authority', () => {
		expect(
			issueTrackingTransferGrantCommandSchema.safeParse({
				...issueCommand('4'.repeat(64)),
				method: 'PUT',
			}).success,
		).toBe(false);
	});
});

describe('Aws4FetchR2TransferGrantSigner', () => {
	const signer = () =>
		new Aws4FetchR2TransferGrantSigner({
			accountId: 'a'.repeat(32),
			accessKeyId: 'access-key',
			secretAccessKey: 'secret-key',
			bucketName: 'private-analysis',
		});

	test.each([
		{
			method: 'GET' as const,
			contentType: 'video/mp4',
			duration: INPUT_TRANSFER_GRANT_SECONDS,
			signedHeaders: 'host',
		},
		{
			method: 'PUT' as const,
			contentType: 'application/octet-stream',
			duration: OUTPUT_TRANSFER_GRANT_SECONDS,
			signedHeaders: 'content-type;host',
		},
	])(
		'signs exact $method object scope and expiry',
		async ({ method, contentType, duration, signedHeaders }) => {
			const value = new URL(
				await signer().sign(
					{
						objectKey: 'scope with space/object+name',
						contentType,
						method,
					},
					duration,
					NOW_SECONDS,
				),
			);
			expect(value.origin).toBe(
				`https://${'a'.repeat(32)}.r2.cloudflarestorage.com`,
			);
			expect(value.pathname).toBe(
				'/private-analysis/scope%20with%20space/object%2Bname',
			);
			expect(value.searchParams.get('X-Amz-Expires')).toBe(String(duration));
			expect(value.searchParams.get('X-Amz-SignedHeaders')).toBe(signedHeaders);
			expect(value.searchParams.get('X-Amz-Signature')).toMatch(
				/^[0-9a-f]{64}$/,
			);
		},
	);

	test('rejects invalid signing configuration without echoing credentials', () => {
		expect(
			() =>
				new Aws4FetchR2TransferGrantSigner({
					accountId: 'not-an-account',
					accessKeyId: 'access-key',
					secretAccessKey: 'do-not-leak',
					bucketName: 'private-analysis',
				}),
		).toThrow('CONFIGURATION_INVALID');
		expect(
			() =>
				new Aws4FetchR2TransferGrantSigner({
					accountId: 'not-an-account',
					accessKeyId: 'access-key',
					secretAccessKey: 'do-not-leak',
					bucketName: 'private-analysis',
				}),
		).not.toThrow(/do-not-leak/);
	});
});
