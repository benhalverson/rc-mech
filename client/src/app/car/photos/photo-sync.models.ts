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
	revision?: number;
	blob: Blob;
}>;
export type PhotoView = Readonly<{
	photos: readonly CarPhoto[];
	captures: readonly PhotoCapture[];
	changes: readonly PhotoChangeOperation[];
}>;
export type PhotoCaptureOutcome =
	| Readonly<{ operationId: string; outcome: 'applied'; photo: CarPhoto }>
	| Readonly<{ operationId: string; outcome: 'rejected'; error: string }>;
/**
 * Overlays retained captures on server metadata by stable photo ID for the local
 * gallery; an acknowledged capture therefore appears once during refresh/replay.
 */
export const materializePhotos = (
	photos: readonly CarPhoto[],
	captures: readonly PhotoCapture[],
): readonly CarPhoto[] => {
	const result = new Map(photos.map((photo) => [photo.id, photo]));
	for (const capture of captures) result.set(capture.photo.id, capture.photo);
	return [...result.values()];
};

export type PhotoChangeOperation = Readonly<{
	ownerKey: string;
	operationId: string;
	carId: string;
	createdAt: number;
	command: import('../../../../../shared/photo-sync').PhotoChange;
	dependencies: readonly string[];
	blob?: Blob;
	status: 'pending' | 'conflict' | 'needs-attention';
	feedback?: Readonly<{ code: string; message: string }>;
	remote?: readonly CarPhoto[];
}>;
export type PhotoChangeOutcome =
	| Readonly<{
			operationId: string;
			outcome: 'applied';
			photos: readonly CarPhoto[];
	  }>
	| Readonly<{
			operationId: string;
			outcome: 'rejected' | 'conflict';
			error: Readonly<{ code: string; message: string }>;
			remote?: readonly CarPhoto[];
	  }>;
