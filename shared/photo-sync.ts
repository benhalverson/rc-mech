export type PhotoRecord = Readonly<{
	id: string;
	carId: string;
	revision?: number;
	contentType: string;
	createdAt: string;
	fileName?: string;
	byteSize?: number;
	sortOrder?: number;
	isPrimary?: boolean;
}>;
export type PhotoChange = Readonly<{
	type: 'photo.change';
	carId: string;
	action: 'replace' | 'delete' | 'primary' | 'reorder';
	photoId: string | null;
	order: readonly string[];
	base: readonly Readonly<{ id: string; revision: number }>[];
	replacement: Readonly<{
		fileName: string;
		contentType: string;
		byteSize: number;
	}> | null;
}>;
export const photoBase = (photos: readonly PhotoRecord[]) =>
	photos
		.map((value) => ({ id: value.id, revision: value.revision ?? 1 }))
		.sort((a, b) => a.id.localeCompare(b.id));
export const photoChangeBase = (
	change: Pick<PhotoChange, 'action' | 'photoId'>,
	photos: readonly PhotoRecord[],
) =>
	photoBase(
		change.action === 'replace' || change.action === 'delete'
			? photos.filter((value) => value.id === change.photoId)
			: photos,
	);
export const photoBaseMatches = (
	change: PhotoChange,
	photos: readonly PhotoRecord[],
): boolean =>
	JSON.stringify([...change.base].sort((a, b) => a.id.localeCompare(b.id))) ===
	JSON.stringify(photoChangeBase(change, photos));
export const applyPhotoChange = <T extends PhotoRecord>(
	photos: readonly T[],
	change: PhotoChange,
): readonly T[] => {
	const remaining =
		change.action === 'delete'
			? photos.filter((value) => value.id !== change.photoId)
			: photos;
	const deletedPrimary =
		change.action === 'delete' &&
		photos.some((value) => value.id === change.photoId && value.isPrimary);
	const primaryId = deletedPrimary
		? [...remaining].sort(
				(a, b) =>
					(a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id.localeCompare(b.id),
			)[0]?.id
		: change.photoId;
	return remaining.map((value) => {
		let update: Partial<T> = {};
		if (
			change.action === 'replace' &&
			value.id === change.photoId &&
			change.replacement
		)
			update = { ...change.replacement } as Partial<T>;
		if (change.action === 'reorder')
			update = { sortOrder: change.order.indexOf(value.id) } as Partial<T>;
		if (change.action === 'primary' || deletedPrimary)
			update = { isPrimary: value.id === primaryId } as Partial<T>;
		const changed =
			Object.entries(update).some(
				([key, entry]) => value[key as keyof T] !== entry,
			) ||
			(change.action === 'replace' &&
				value.id === change.photoId &&
				change.replacement !== null);
		return changed
			? { ...value, ...update, revision: (value.revision ?? 1) + 1 }
			: value;
	});
};

export const photoChangeTouchesGallery = (
	change: Pick<PhotoChange, 'action'>,
): boolean => change.action === 'primary' || change.action === 'reorder';
export const photoChangesOverlap = (
	left: PhotoChange,
	right: PhotoChange,
): boolean =>
	photoChangeTouchesGallery(left) ||
	photoChangeTouchesGallery(right) ||
	left.photoId === right.photoId;
