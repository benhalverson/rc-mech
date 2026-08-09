import type * as z from 'zod/mini';
import { array, minLength, nullable, object, optional, string } from 'zod/mini';

const optionalText = optional(nullable(string()));

export const garageCarSchema = object({
	id: string().check(minLength(1)),
	name: string().check(minLength(1)),
	manufacturer: optionalText,
	make: optionalText,
	model: optionalText,
	scale: optionalText,
	vehicleType: optionalText,
	powerType: optionalText,
	notes: optionalText,
	archivedAt: optionalText,
	createdAt: optional(string()),
});

export const garageCarCollectionSchema = object({
	cars: array(garageCarSchema),
});

export const garageCarCollectionResponseSchema = nullable(
	garageCarCollectionSchema,
);

export const garageCarMutationSchema = object({ car: garageCarSchema });

export type GarageCar = z.infer<typeof garageCarSchema>;

export type GarageCarInput = {
	name: string;
	make?: string;
	model?: string;
	scale?: string;
	vehicleType?: string;
	powerType?: string;
	notes?: string;
};

export type GarageCollection = { readonly cars: GarageCar[] };

export type GarageGatewayFailure =
	| { readonly kind: 'http'; readonly status: number }
	| { readonly kind: 'invalid-response' }
	| { readonly kind: 'unavailable' };

export type CreateCarCommand = { readonly input: GarageCarInput };

export type GarageCreateOutcome =
	| { readonly status: 'idle'; readonly operationId: null }
	| { readonly status: 'pending'; readonly operationId: number }
	| {
			readonly status: 'succeeded';
			readonly operationId: number;
			readonly car: GarageCar;
	  }
	| {
			readonly status: 'failed';
			readonly operationId: number;
			readonly error: GarageGatewayFailure;
	  };
