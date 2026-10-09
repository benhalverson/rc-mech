import type { CarPhoto } from '../car.models';

export type PhotoCapture = Readonly<{
	ownerKey: string;
	operationId: string;
	carId: string;
	fileName: string;
	blob: Blob;
	photo: CarPhoto;
	status: 'pending' | 'needs-attention';
	feedback?: string;
}>;
export type PhotoMedia = Readonly<{
	ownerKey: string;
	photoId: string;
	blob: Blob;
}>;
export type PhotoView = Readonly<{
	photos: readonly CarPhoto[];
	captures: readonly PhotoCapture[];
}>;
export type PhotoCaptureOutcome =
	| Readonly<{ operationId: string; outcome: 'applied'; photo: CarPhoto }>
	| Readonly<{ operationId: string; outcome: 'rejected'; error: string }>;
export const materializePhotos = (
	photos: readonly CarPhoto[],
	captures: readonly PhotoCapture[],
): readonly CarPhoto[] => {
	const result = new Map(photos.map((photo) => [photo.id, photo]));
	for (const capture of captures) result.set(capture.photo.id, capture.photo);
	return [...result.values()];
};
