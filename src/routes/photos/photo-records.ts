import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { validatePhotoMetadata } from '../../photo-policy';
import { photo } from '../../schema';
import type { AppContext } from '../../types';
import { ownedCar } from '../cars/car-records';

export const ownedPhoto = async (c: AppContext, photoId: string) => {
	const value = await db(c.env)
		.select()
		.from(photo)
		.where(eq(photo.id, photoId))
		.get();
	return value && (await ownedCar(c, value.carId)) ? value : undefined;
};

export const publicPhoto = (value: typeof photo.$inferSelect) => ({
	id: value.id,
	carId: value.carId,
	fileName: value.fileName,
	contentType: value.contentType,
	byteSize: value.byteSize,
	sortOrder: value.sortOrder,
	isPrimary: value.isPrimary,
	createdAt: value.createdAt,
	url: `/api/v1/photos/${value.id}`,
});

export const parsePhotoForm = async (c: AppContext) => {
	const requestContentType = c.req.header('content-type') ?? '';
	const boundary = /(?:^|;)\s*boundary\s*=\s*(?:"([^"]*)"|([^;\s]*))/i.exec(
		requestContentType,
	);
	const rejectMultipart = () => {
		console.error('photo multipart parsing failed', {
			route: c.req.path,
			contentType: requestContentType,
			requestId:
				c.req.header('cf-ray') ?? c.req.header('x-request-id') ?? 'unknown',
		});
		return {
			error: 'Photo upload must include a valid multipart boundary' as const,
		};
	};
	if (
		!/^multipart\/form-data(?:\s*;|$)/i.test(requestContentType) ||
		(!boundary?.[1] && !boundary?.[2])
	)
		return rejectMultipart();
	let body: Record<string, string | File>;
	try {
		body = await c.req.parseBody();
	} catch (_error) {
		return rejectMultipart();
	}
	const file = body.file;
	if (!(file instanceof File))
		return { error: 'A photo file is required' as const };
	const fileName = file.name.trim();
	const contentType = file.type.toLowerCase();
	const error = validatePhotoMetadata({
		contentType,
		fileName,
		byteSize: file.size,
	});
	if (error) return { error };
	return {
		file,
		fileName,
		contentType,
		sortOrder: body.sortOrder,
		primary: body.primary,
	};
};
