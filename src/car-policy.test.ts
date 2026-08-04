import assert from "node:assert/strict";
import test from "node:test";
import { carListMode, canArchive, canRestore, canWrite, ownsCar } from "./car-policy.ts";

test("car ownership is scoped to the authenticated owner and fails closed", () => {
	assert.equal(ownsCar("owner-a", "owner-a"), true);
	assert.equal(ownsCar("owner-a", "owner-b"), false);
	assert.equal(ownsCar(null, "owner-a"), false);
	assert.equal(ownsCar(undefined, "owner-a"), false);
});

test("active is the default list and archived records have explicit list modes", () => {
	assert.equal(carListMode(undefined), "active");
	assert.equal(carListMode("true"), "archived");
	assert.equal(carListMode("all"), "all");
	assert.equal(carListMode("false"), "invalid");
	assert.equal(carListMode("TRUE"), "invalid");
});

test("archive and restore are inverse lifecycle transitions", () => {
	assert.equal(canArchive({ archivedAt: null }), true);
	assert.equal(canArchive({ archivedAt: "2026-08-03T00:00:00.000Z" }), false);
	assert.equal(canRestore({ archivedAt: "2026-08-03T00:00:00.000Z" }), true);
	assert.equal(canRestore({ archivedAt: null }), false);
	assert.equal(canWrite({ archivedAt: null }), true);
	assert.equal(canWrite({ archivedAt: "2026-08-03T00:00:00.000Z" }), false);
});
