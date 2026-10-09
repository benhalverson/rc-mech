import { z } from 'zod';
export const photoChangeInput = z
	.strictObject({
		type: z.literal('photo.change'),
		carId: z.uuid(),
		action: z.enum(['replace', 'delete', 'primary', 'reorder']),
		photoId: z.uuid().nullable(),
		order: z.array(z.uuid()).max(1000),
		base: z
			.array(z.strictObject({ id: z.uuid(), revision: z.int().positive() }))
			.max(1000),
		replacement: z
			.strictObject({
				fileName: z.string().min(1).max(255),
				contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
				byteSize: z
					.int()
					.positive()
					.max(10 * 1024 * 1024),
			})
			.nullable(),
	})
	.superRefine((value, context) => {
		const ids = value.base.map((row) => row.id);
		if (
			new Set(ids).size !== ids.length ||
			(value.action === 'reorder'
				? value.photoId !== null ||
					value.order.length !== ids.length ||
					new Set(value.order).size !== ids.length ||
					value.order.some((id) => !ids.includes(id))
				: value.photoId === null ||
					!ids.includes(value.photoId) ||
					value.order.length !== 0) ||
			(value.action === 'replace') !== (value.replacement !== null)
		)
			context.addIssue({
				code: 'custom',
				message: 'Photo change identities do not match its action.',
			});
	});
