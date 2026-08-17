import { z } from 'zod';

const gateDirectionSchema = z.enum(['forward', 'reverse']);

const coordinate = z.number().finite().min(0).max(1);
const pointSchema = z.object({ x: coordinate, y: coordinate }).strict();
const gateSchema = z
	.object({
		start: pointSchema,
		end: pointSchema,
		direction: gateDirectionSchema,
	})
	.strict();
const cornerViewSchema = z
	.object({
		x: coordinate,
		y: coordinate,
		width: coordinate,
		height: coordinate,
	})
	.strict()
	.superRefine((view, context) => {
		if (view.width <= 0 || view.height <= 0) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'Corner view must have positive dimensions.',
			});
		}
		if (view.x + view.width > 1 || view.y + view.height > 1) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'Corner view must stay inside the Track view.',
			});
		}
	});

const nonDegenerateGate = (
	gate: z.infer<typeof gateSchema>,
	message: string,
	context: z.RefinementCtx,
) => {
	if (gate.start.x === gate.end.x && gate.start.y === gate.end.y)
		context.addIssue({ code: z.ZodIssueCode.custom, message });
};

export const trackCornerInputSchema = z
	.object({
		key: z
			.string()
			.trim()
			.min(1)
			.max(80)
			.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
		name: z.string().trim().min(1).max(120),
		order: z.number().int().positive(),
		entryGate: gateSchema,
		exitGate: gateSchema,
		cornerView: cornerViewSchema,
	})
	.strict()
	.superRefine((corner, context) => {
		nonDegenerateGate(
			corner.entryGate,
			'Entry gate must have two different points.',
			context,
		);
		nonDegenerateGate(
			corner.exitGate,
			'Exit gate must have two different points.',
			context,
		);
	});

export const trackMapDraftInputSchema = z
	.object({
		expectedStateVersion: z.number().int().positive(),
		corners: z.array(trackCornerInputSchema).max(100),
	})
	.strict()
	.superRefine((draft, context) => {
		const keys = new Set<string>();
		const orders = new Set<number>();
		for (const [index, corner] of draft.corners.entries()) {
			if (keys.has(corner.key))
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['corners', index, 'key'],
					message: 'Corner keys must be unique.',
				});
			keys.add(corner.key);
			if (orders.has(corner.order))
				context.addIssue({
					code: z.ZodIssueCode.custom,
					path: ['corners', index, 'order'],
					message: 'Corner orders must be unique.',
				});
			orders.add(corner.order);
		}
	});

export type TrackCornerInput = z.infer<typeof trackCornerInputSchema>;
export type TrackMapDraftInput = z.infer<typeof trackMapDraftInputSchema>;

export const trackLayoutCreateSchema = z
	.object({ name: z.string().trim().min(1).max(160) })
	.strict();
export const trackLayoutRenameSchema = trackLayoutCreateSchema;
export const trackMapVersionCreateSchema = z
	.object({ sourceVersionId: z.string().uuid().optional() })
	.strict();
export const trackMapVersionDecisionSchema = z
	.object({ expectedStateVersion: z.number().int().positive() })
	.strict();
