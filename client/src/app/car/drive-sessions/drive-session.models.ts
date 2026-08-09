import { z } from 'zod';

const nullableString = z
	.string()
	.nullable()
	.optional()
	.transform((value) => value ?? null);
const nullableNumber = z
	.number()
	.nullable()
	.optional()
	.transform((value) => value ?? null);

export const driveSessionSchema = z
	.object({
		id: z.string(),
		carId: z.string(),
		startedAt: z.string(),
		durationMinutes: nullableNumber,
		conditions: nullableString,
		notes: nullableString,
		deletedAt: nullableString,
	})
	.readonly();

export const driveSessionCollectionSchema = z
	.object({
		driveSessions: z.array(driveSessionSchema).optional(),
		sessions: z.array(driveSessionSchema).optional(),
		timezone: z.string().nullable().optional(),
	})
	.transform((value) => ({
		sessions: value.driveSessions ?? value.sessions ?? [],
		timezone: value.timezone ?? null,
	}));

export const driveSessionMutationSchema = z
	.object({ driveSession: driveSessionSchema })
	.transform((value) => value.driveSession);

export const driveSessionTimezoneSchema = z
	.object({ timezone: z.string().nullable().optional() })
	.transform((value) => ({ timezone: value.timezone ?? null }));

export type DriveSession = z.infer<typeof driveSessionSchema>;
export type DriveSessionCollection = z.infer<
	typeof driveSessionCollectionSchema
>;
export type DriveSessionDraft = Readonly<{
	startedAt: string;
	durationMinutes: number | null;
	conditions: string;
	notes: string;
}>;
export type SaveDriveSessionCommand = Readonly<{
	carId: string;
	sessionId: string | null;
	draft: DriveSessionDraft;
}>;
export type ArchiveDriveSessionCommand = Readonly<{
	carId: string;
	sessionId: string;
}>;

export type DriveSessionGatewayFailure =
	| { readonly kind: 'http'; readonly status: number }
	| {
			readonly kind: 'rejected-response';
			readonly status: number;
			readonly message: string;
	  }
	| { readonly kind: 'unavailable' }
	| { readonly kind: 'invalid-response' };

export type DriveSessionOperation =
	| 'save-drive-session'
	| 'archive-drive-session';
export type DriveSessionOutcome =
	| {
			readonly status: 'idle';
			readonly operation: null;
			readonly operationId: null;
	  }
	| {
			readonly status: 'pending';
			readonly operation: DriveSessionOperation;
			readonly operationId: number;
	  }
	| {
			readonly status: 'succeeded';
			readonly operation: DriveSessionOperation;
			readonly operationId: number;
			readonly session: DriveSession;
	  }
	| {
			readonly status: 'failed';
			readonly operation: DriveSessionOperation;
			readonly operationId: number;
			readonly error: DriveSessionGatewayFailure;
	  };
