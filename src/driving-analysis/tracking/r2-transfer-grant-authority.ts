import { AwsClient } from 'aws4fetch';
import { z } from 'zod';
import {
	GPU_LEASE_COORDINATOR_OBJECT_NAME,
	type GpuLeaseMutationResult,
	type GpuLeaseWitnessInput,
} from '../gpu-lease-coordinator';
import {
	executionIdentitySchema,
	type TransferGrantCommand,
	transferGrantCommandSchema,
} from './contracts';
import { TrackingAuthority } from './tracking-authority';

export const INPUT_TRANSFER_GRANT_SECONDS = 30 * 60;
export const OUTPUT_TRANSFER_GRANT_SECONDS = 10 * 60;
export const ANALYSIS_MEDIA_BUCKET_NAME = 'rc-mech-analysis-media';

const transferRoleSchema = z.enum([
	'prepared-media',
	'frame-manifest',
	'observation-artifact',
]);

export const issueTrackingTransferGrantCommandSchema = executionIdentitySchema
	.extend({
		ownerId: z.string().trim().min(1).max(128),
		transferRequestId: z.string().uuid(),
		role: transferRoleSchema,
		method: z.enum(['GET', 'PUT']),
	})
	.refine(
		(value) =>
			value.method === (value.role === 'observation-artifact' ? 'PUT' : 'GET'),
	);

export type IssueTrackingTransferGrantCommand = z.infer<
	typeof issueTrackingTransferGrantCommandSchema
>;

type TransferGrantBinding = {
	objectKey: string;
	contentType: string;
	method: 'GET' | 'PUT';
};

export interface TransferGrantSigner {
	sign(
		binding: TransferGrantBinding,
		expiresInSeconds: number,
		nowEpochSeconds: number,
	): Promise<string>;
}

interface LeaseWitness {
	witness(input: GpuLeaseWitnessInput): Promise<GpuLeaseMutationResult>;
}

export type TrackingTransferGrantErrorCode =
	| 'CONFIGURATION_INVALID'
	| 'LEASE_MISMATCH'
	| 'SIGNING_FAILED';

export class TrackingTransferGrantError extends Error {
	constructor(readonly code: TrackingTransferGrantErrorCode) {
		super(code);
		this.name = 'TrackingTransferGrantError';
	}
}

const signingConfigurationSchema = z.strictObject({
	accountId: z.string().regex(/^[0-9a-f]{32}$/i),
	accessKeyId: z.string().trim().min(1).max(256),
	secretAccessKey: z.string().trim().min(1).max(1024),
	bucketName: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
});

export class Aws4FetchR2TransferGrantSigner implements TransferGrantSigner {
	private readonly accountId: string;
	private readonly bucketName: string;
	private readonly client: AwsClient;

	constructor(configurationValue: z.input<typeof signingConfigurationSchema>) {
		const parsed = signingConfigurationSchema.safeParse(configurationValue);
		if (!parsed.success)
			throw new TrackingTransferGrantError('CONFIGURATION_INVALID');
		const configuration = parsed.data;
		this.accountId = configuration.accountId;
		this.bucketName = configuration.bucketName;
		this.client = new AwsClient({
			accessKeyId: configuration.accessKeyId,
			secretAccessKey: configuration.secretAccessKey,
			service: 's3',
			region: 'auto',
			retries: 0,
		});
	}

	async sign(
		binding: TransferGrantBinding,
		expiresInSeconds: number,
		nowEpochSeconds: number,
	): Promise<string> {
		const url = new URL(`https://${this.accountId}.r2.cloudflarestorage.com`);
		url.pathname = `/${encodeURIComponent(this.bucketName)}/${binding.objectKey
			.split('/')
			.map((part) => encodeURIComponent(part))
			.join('/')}`;
		url.searchParams.set('X-Amz-Expires', String(expiresInSeconds));
		const request = await this.client.sign(url, {
			method: binding.method,
			headers:
				binding.method === 'PUT'
					? { 'Content-Type': binding.contentType }
					: undefined,
			aws: {
				signQuery: true,
				allHeaders: binding.method === 'PUT',
				datetime: awsTimestamp(nowEpochSeconds),
			},
		});
		return request.url;
	}
}

export class R2TransferGrantAuthority {
	constructor(
		private readonly authority: TrackingAuthority,
		private readonly leaseWitness: LeaseWitness,
		private readonly signer: TransferGrantSigner,
		private readonly clock: () => number = () => Math.floor(Date.now() / 1000),
	) {}

	async issue(
		commandValue: IssueTrackingTransferGrantCommand,
	): Promise<TransferGrantCommand> {
		const command = issueTrackingTransferGrantCommandSchema.parse(commandValue);
		const now = this.clock();
		const authorityCommand = {
			ownerId: command.ownerId,
			runId: command.runId,
			segmentId: command.segmentId,
			attemptId: command.attemptId,
			leaseId: command.leaseId,
			fence: command.fencingToken,
			profileDigest: command.profileDigest,
			specificationDigest: command.specificationDigest,
			transferRequestId: command.transferRequestId,
			role: command.role,
			method: command.method,
			requestedAt: new Date(now * 1000).toISOString(),
		};
		await this.authority.prepareTransferGrant(authorityCommand);

		let witness: GpuLeaseMutationResult;
		try {
			witness = await this.leaseWitness.witness({
				segmentId: command.segmentId,
				leaseId: command.leaseId,
				fence: command.fencingToken,
			});
		} catch {
			throw new TrackingTransferGrantError('LEASE_MISMATCH');
		}
		if (witness.status !== 'ok')
			throw new TrackingTransferGrantError('LEASE_MISMATCH');

		const binding =
			await this.authority.authorizeTransferGrant(authorityCommand);
		const expiresInSeconds =
			command.method === 'GET'
				? INPUT_TRANSFER_GRANT_SECONDS
				: OUTPUT_TRANSFER_GRANT_SECONDS;
		try {
			const url = await this.signer.sign(binding, expiresInSeconds, now);
			return transferGrantCommandSchema.parse({
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
				url,
				expiresAt: now + expiresInSeconds,
			});
		} catch {
			throw new TrackingTransferGrantError('SIGNING_FAILED');
		}
	}
}

export type R2TransferGrantEnvironment = {
	DB: D1Database;
	GPU_LEASE_COORDINATOR: {
		getByName(name: string): LeaseWitness;
	};
	R2_ACCOUNT_ID?: string;
	R2_ACCESS_KEY_ID?: string;
	R2_SECRET_ACCESS_KEY?: string;
};

export const r2TransferGrantAuthority = (
	env: R2TransferGrantEnvironment,
): R2TransferGrantAuthority =>
	new R2TransferGrantAuthority(
		new TrackingAuthority(env.DB),
		env.GPU_LEASE_COORDINATOR.getByName(GPU_LEASE_COORDINATOR_OBJECT_NAME),
		new Aws4FetchR2TransferGrantSigner({
			accountId: env.R2_ACCOUNT_ID ?? '',
			accessKeyId: env.R2_ACCESS_KEY_ID ?? '',
			secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? '',
			bucketName: ANALYSIS_MEDIA_BUCKET_NAME,
		}),
	);

const awsTimestamp = (epochSeconds: number): string =>
	new Date(epochSeconds * 1000).toISOString().replace(/[:-]|\.\d{3}/g, '');
