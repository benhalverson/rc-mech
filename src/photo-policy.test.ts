import assert from "node:assert/strict";
import test from "node:test";
import { PHOTO_MAX_BYTES, isCompletePhotoOrder, isSupportedPhotoType, normalizePhotoOrder, photoObjectKey, primaryAfterDelete, validatePhotoMetadata } from "./photo-policy.ts";

test("photo validation accepts supported images and rejects unsafe metadata", () => {
	assert.equal(isSupportedPhotoType("image/jpeg"), true);
	assert.equal(isSupportedPhotoType("image/svg+xml"), false);
	assert.equal(validatePhotoMetadata({ contentType: "image/png", fileName: "car.png", byteSize: 10 }), undefined);
	assert.equal(validatePhotoMetadata({ contentType: "image/png", fileName: "car.png", byteSize: PHOTO_MAX_BYTES + 1 }), "Photo exceeds the 10 MB limit");
	assert.equal(validatePhotoMetadata({ contentType: "image/svg+xml", fileName: "car.svg", byteSize: 10 }), "Unsupported photo type");
	assert.equal(validatePhotoMetadata({ contentType: "image/png", fileName: "", byteSize: 10 }), "Invalid photo file name");
});

test("photo keys are scoped and ordering is deterministic", () => {
	assert.equal(photoObjectKey("car-1", "photo-1"), "cars/car-1/photos/photo-1");
	const ordered = normalizePhotoOrder([
		{ id: "b", sortOrder: 1, createdAt: "2026-01-01T00:00:00.000Z" },
		{ id: "a", sortOrder: 1, createdAt: "2026-01-01T00:00:00.000Z" },
		{ id: "c", sortOrder: 0, createdAt: "2026-01-02T00:00:00.000Z" },
	]);
	assert.deepEqual(ordered.map((photo) => photo.id), ["c", "a", "b"]);
	assert.equal(isCompletePhotoOrder(ordered, ["c", "a", "b"]), true);
	assert.equal(isCompletePhotoOrder(ordered, ["c", "a"]), false);
	assert.equal(isCompletePhotoOrder(ordered, ["c", "a", "a"]), false);
	assert.equal(primaryAfterDelete(ordered, "c"), "a");
	assert.equal(primaryAfterDelete(ordered, "a"), "c");
});
