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
	const body = await c.req.parseBody();
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
