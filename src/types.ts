import type { Context } from "hono";
import { z } from "zod";

export type AppVariables = { userId: string };
export type AppEnv = { Bindings: Env; Variables: AppVariables };
export type AppContext = Context<AppEnv>;

const carFields = {
	name: z.string().min(1).max(120),
	make: z.string().max(120).optional(),
	model: z.string().max(120).optional(),
	scale: z.string().max(20).optional(),
	vehicleType: z.string().max(80).optional(),
	powerType: z.string().max(80).optional(),
	notes: z.string().max(4000).optional(),
};

export const carInput = z.object(carFields);
export const carUpdateInput = z.object({
	name: carFields.name.optional(),
	make: carFields.make,
	model: carFields.model,
	scale: carFields.scale,
	vehicleType: carFields.vehicleType,
	powerType: carFields.powerType,
	notes: carFields.notes,
}).refine((value) => Object.keys(value).length > 0, "At least one car field is required");

export const componentInput = z.object({
	slot: z.string().trim().min(1).max(80),
	slotType: z.enum(["standard", "custom"]).optional(),
	name: z.string().min(1).max(160),
	manufacturer: z.string().max(120).optional(),
	model: z.string().max(120).optional(),
	serialNumber: z.string().max(120).optional(),
	notes: z.string().max(4000).optional(),
	installedAt: z.string().datetime().optional(),
});

export const componentUpdateInput = z.object({
	name: z.string().min(1).max(160).optional(),
	manufacturer: z.string().max(120).optional(),
	model: z.string().max(120).optional(),
	serialNumber: z.string().max(120).optional(),
	notes: z.string().max(4000).optional(),
	installedAt: z.string().datetime().optional(),
}).refine((value) => Object.keys(value).length > 0, "At least one component field is required");

export const driveSessionInput = z.object({
	carId: z.string().min(1),
	startedAt: z.string().datetime(),
	durationMinutes: z.number().int().positive().max(1440).optional(),
	conditions: z.string().max(1000).optional(),
	notes: z.string().max(4000).optional(),
});

export const serviceRecordInput = z.object({
	carId: z.string().min(1),
	componentId: z.string().optional(),
	performedAt: z.string().datetime(),
	description: z.string().min(1).max(4000),
	baselineAt: z.string().datetime().optional(),
});

export const maintenancePlanInput = z.object({
	carId: z.string().min(1),
	componentId: z.string().min(1),
	name: z.string().min(1).max(160),
	intervalDays: z.number().int().positive().optional(),
	intervalSessions: z.number().int().positive().optional(),
});
