import {
	array,
	nullable,
	number,
	object,
	optional,
	pipe,
	readonly,
	string,
	transform,
} from 'zod/mini';
import type * as z from 'zod/mini';

const nullableString = pipe(
	optional(nullable(string())),
	transform((value) => value ?? null),
);
const nullableNumber = pipe(
	optional(nullable(number())),
	transform((value) => value ?? null),
);

export const driveSessionSchema = readonly(
	object({
		id: string(),
		carId: string(),
		startedAt: string(),
		durationMinutes: nullableNumber,
		conditions: nullableString,
		notes: nullableString,
		deletedAt: nullableString,
	}),
);

export const driveSessionCollectionSchema = pipe(
	object({
		driveSessions: optional(array(driveSessionSchema)),
		sessions: optional(array(driveSessionSchema)),
		timezone: optional(nullable(string())),
	}),
	transform((value) => ({
		sessions: value.driveSessions ?? value.sessions ?? [],
		timezone: value.timezone ?? null,
	})),
);

export const driveSessionMutationSchema = pipe(
	object({ driveSession: driveSessionSchema }),
	transform((value) => value.driveSession),
);

export const driveSessionTimezoneSchema = pipe(
	object({ timezone: optional(nullable(string())) }),
	transform((value) => ({ timezone: value.timezone ?? null })),
);

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
