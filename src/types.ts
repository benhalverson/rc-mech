import type { Context } from "hono";
import { z } from "zod";

export type AppContext = Context<{ Bindings: Env }>;

export const carInput = z.object({
	name: z.string().min(1).max(120),
	manufacturer: z.string().max(120).optional(),
	model: z.string().max(120).optional(),
	scale: z.string().max(20).optional(),
	notes: z.string().max(4000).optional(),
});

export const componentInput = z.object({
	slot: z.string().min(1).max(80),
	name: z.string().min(1).max(160),
	serialNumber: z.string().max(120).optional(),
	notes: z.string().max(4000).optional(),
});

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
