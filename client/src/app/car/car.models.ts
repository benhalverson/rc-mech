import {
	array,
	boolean,
	literal,
	nullable,
	number,
	object,
	optional,
	string,
	union,
} from 'zod/mini';
import type { GarageCarInput } from '../garage/garage.models';

const optionalText = optional(nullable(string()));

export const installedComponentSchema = object({
	id: string(),
	carId: string(),
	slot: string(),
	slotType: optional(nullable(union([literal('standard'), literal('custom')]))),
	name: string(),
	manufacturer: optionalText,
	model: optionalText,
	serialNumber: optionalText,
	notes: optionalText,
	installedAt: optional(string()),
	removedAt: optionalText,
});

export const installedComponentCollectionSchema = object({
	components: array(installedComponentSchema),
});

export const installedComponentMutationSchema = object({
	component: installedComponentSchema,
});

export type InstalledComponent = {
	id: string;
	carId: string;
	slot: string;
	slotType?: 'standard' | 'custom' | null;
	name: string;
	manufacturer?: string | null;
	model?: string | null;
	serialNumber?: string | null;
	notes?: string | null;
	installedAt?: string;
	removedAt?: string | null;
};

export type CarPhoto = {
	id: string;
	carId: string;
	objectKey?: string;
	contentType: string;
	createdAt: string;
	sortOrder?: number;
	position?: number;
	isPrimary?: boolean;
	primary?: boolean;
	url?: string;
};

export const carPhotoSchema = object({
	id: string(),
	carId: string(),
	objectKey: optional(string()),
	contentType: string(),
	createdAt: string(),
	sortOrder: optional(number()),
	position: optional(number()),
	isPrimary: optional(boolean()),
	primary: optional(boolean()),
	url: optional(string()),
});

export const carPhotoCollectionSchema = object({
	photos: array(carPhotoSchema),
});
export const carPhotoMutationSchema = object({ photo: carPhotoSchema });
export const carPhotoDeletionSchema = object({
	deleted: boolean(),
	primaryPhotoId: optional(nullable(string())),
});

export type PhotoGatewayFailure =
	| { readonly kind: 'http'; readonly status: number }
	| { readonly kind: 'invalid-response' }
	| { readonly kind: 'unavailable' };

export type PhotoMutationCommand =
	| { readonly kind: 'upload'; readonly file: File }
	| { readonly kind: 'replace'; readonly photo: CarPhoto; readonly file: File }
	| { readonly kind: 'primary'; readonly photo: CarPhoto }
	| { readonly kind: 'delete'; readonly photo: CarPhoto }
	| { readonly kind: 'reorder'; readonly photos: readonly CarPhoto[] };

export type PhotoMutationOutcome =
	| { readonly status: 'idle'; readonly operationId: null }
	| {
			readonly status: 'pending';
			readonly operationId: number;
			readonly command: PhotoMutationCommand;
	  }
	| {
			readonly status: 'succeeded';
			readonly operationId: number;
			readonly command: PhotoMutationCommand;
	  }
	| {
			readonly status: 'failed';
			readonly operationId: number;
			readonly command: PhotoMutationCommand;
			readonly error: PhotoGatewayFailure;
	  };

export type CarGatewayFailure =
	| { readonly kind: 'http'; readonly status: number }
	| { readonly kind: 'invalid-response' }
	| { readonly kind: 'unavailable' };

export type UpdateCarCommand = {
	readonly carId: string;
	readonly input: GarageCarInput;
};

export type ChangeCarLifecycleCommand = {
	readonly carId: string;
	readonly action: 'archive' | 'restore';
};

export type CarUpdateOutcome =
	| { readonly status: 'idle'; readonly operationId: null }
	| { readonly status: 'pending'; readonly operationId: number }
	| { readonly status: 'succeeded'; readonly operationId: number }
	| {
			readonly status: 'failed';
			readonly operationId: number;
			readonly error: CarGatewayFailure;
	  };

export type CarLifecycleOutcome =
	| {
			readonly status: 'idle';
			readonly operationId: null;
			readonly action: null;
	  }
	| {
			readonly status: 'pending' | 'succeeded';
			readonly operationId: number;
			readonly action: 'archive' | 'restore';
	  }
	| {
			readonly status: 'failed';
			readonly operationId: number;
			readonly action: 'archive' | 'restore';
			readonly error: CarGatewayFailure;
	  };

export type BuildMode = 'add' | 'edit' | 'replace';

export type BuildComponentInput = {
	readonly slot?: string;
	readonly slotType?: 'standard' | 'custom';
	readonly name: string;
	readonly manufacturer?: string;
	readonly model?: string;
	readonly serialNumber?: string;
	readonly notes?: string;
};

export type SaveBuildCommand = {
	readonly carId: string;
	readonly mode: BuildMode;
	readonly componentId: string | null;
	readonly input: BuildComponentInput;
};

export type BuildGatewayFailure =
	| { readonly kind: 'http'; readonly status: number }
	| { readonly kind: 'invalid-response' }
	| { readonly kind: 'unavailable' };

export type BuildSaveOutcome =
	| { readonly status: 'idle'; readonly operationId: null }
	| {
			readonly status: 'pending';
			readonly operationId: number;
			readonly mode: BuildMode;
	  }
	| {
			readonly status: 'succeeded';
			readonly operationId: number;
			readonly mode: BuildMode;
	  }
	| {
			readonly status: 'failed';
			readonly operationId: number;
			readonly mode: BuildMode;
			readonly error: BuildGatewayFailure;
	  };
