export const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export const PHOTO_CONTENT_TYPES = ["image/jpeg", "image/png", "image/webp", "image/avif"] as const;

export type PhotoMetadata = {
	contentType: string;
	fileName: string;
	byteSize: number;
};

export const isSupportedPhotoType = (contentType: string): boolean =>
	(PHOTO_CONTENT_TYPES as readonly string[]).includes(contentType.toLowerCase());

export const validatePhotoMetadata = (value: PhotoMetadata): string | undefined => {
	if (!isSupportedPhotoType(value.contentType)) return "Unsupported photo type";
	if (!Number.isInteger(value.byteSize) || value.byteSize <= 0) return "Photo must not be empty";
	if (value.byteSize > PHOTO_MAX_BYTES) return "Photo exceeds the 10 MB limit";
	if (!value.fileName.trim() || value.fileName.length > 255) return "Invalid photo file name";
	return undefined;
};

export const photoObjectKey = (carId: string, photoId: string): string => `cars/${carId}/photos/${photoId}`;

export const normalizePhotoOrder = <T extends { sortOrder: number; createdAt: string; id: string }>(photos: T[]): T[] =>
	[...photos].sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

export const isCompletePhotoOrder = <T extends { id: string }>(photos: T[], orderedIds: string[]): boolean => {
	if (photos.length !== orderedIds.length) return false;
	const expected = new Set(photos.map((value) => value.id));
	return new Set(orderedIds).size === orderedIds.length && orderedIds.every((id) => expected.has(id));
};

export const primaryAfterDelete = <T extends { id: string; sortOrder: number; createdAt: string }>(photos: T[], deletedId: string): string | undefined =>
	normalizePhotoOrder(photos.filter((value) => value.id !== deletedId))[0]?.id;
