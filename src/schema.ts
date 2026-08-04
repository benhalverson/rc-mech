import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

const id = (name: string) => text(name).primaryKey();
export const car = sqliteTable("car", {
	id: id("id"),
	ownerId: text("owner_id"),
	name: text("name").notNull(),
	make: text("make"),
	model: text("model"),
	scale: text("scale"),
	vehicleType: text("vehicle_type"),
	powerType: text("power_type"),
	notes: text("notes"),
	createdAt: text("created_at").notNull(),
	archivedAt: text("archived_at"),
});
export const component = sqliteTable("component", {
	id: id("id"),
	carId: text("car_id").notNull(),
	slot: text("slot").notNull(),
	slotType: text("slot_type").notNull().default("custom"),
	name: text("name").notNull(),
	manufacturer: text("manufacturer"),
	model: text("model"),
	serialNumber: text("serial_number"),
	notes: text("notes"),
	installedAt: text("installed_at").notNull(),
	removedAt: text("removed_at"),
});
export const driveSession = sqliteTable("drive_session", {
	id: id("id"),
	carId: text("car_id").notNull(),
	startedAt: text("started_at").notNull(),
	durationMinutes: integer("duration_minutes"),
	conditions: text("conditions"),
	notes: text("notes"),
	deletedAt: text("deleted_at"),
});
export const maintenancePlan = sqliteTable("maintenance_plan", { id: id("id"), carId: text("car_id").notNull(), componentId: text("component_id"), name: text("name").notNull(), intervalDays: integer("interval_days"), intervalSessions: integer("interval_sessions"), intervalUnit: text("interval_unit").notNull().default("days"), intervalValue: integer("interval_value").notNull().default(1), baselineAt: text("baseline_at").notNull(), baselineSessionCount: integer("baseline_session_count").notNull().default(0), status: text("status").notNull(), pauseReason: text("pause_reason"), pausedAt: text("paused_at") });
export const serviceRecord = sqliteTable("service_record", { id: id("id"), carId: text("car_id").notNull(), componentId: text("component_id"), planId: text("plan_id"), performedAt: text("performed_at").notNull(), description: text("description").notNull(), notes: text("notes"), cost: real("cost"), currency: text("currency"), baselineAt: text("baseline_at").notNull(), baselineSessionCount: integer("baseline_session_count"), previousBaselineAt: text("previous_baseline_at"), previousBaselineSessionCount: integer("previous_baseline_session_count"), deletedAt: text("deleted_at") });
export const photo = sqliteTable("photo", {
	id: id("id"),
	carId: text("car_id").notNull(),
	objectKey: text("object_key").notNull().unique(),
	contentType: text("content_type").notNull(),
	fileName: text("file_name").notNull().default("photo"),
	byteSize: integer("byte_size").notNull().default(0),
	sortOrder: integer("sort_order").notNull().default(0),
	isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
	createdAt: text("created_at").notNull(),
});

export const owner = sqliteTable("owner", {
	id: id("id"),
	name: text("name").notNull(),
	email: text("email").notNull().unique(),
	emailVerified: integer("email_verified", { mode: "boolean" }).notNull(),
	image: text("image"),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
	timezone: text("timezone").notNull().default("UTC"),
});

export const session = sqliteTable("session", {
	id: id("id"),
	expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
	token: text("token").notNull().unique(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
	ipAddress: text("ip_address"),
	userAgent: text("user_agent"),
	userId: text("user_id").notNull(),
});

export const account = sqliteTable("account", {
	id: id("id"),
	accountId: text("account_id").notNull(),
	providerId: text("provider_id").notNull(),
	userId: text("user_id").notNull(),
	accessToken: text("access_token"),
	refreshToken: text("refresh_token"),
	idToken: text("id_token"),
	accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
	refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
	scope: text("scope"),
	password: text("password"),
	createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const verification = sqliteTable("verification", {
	id: id("id"),
	identifier: text("identifier").notNull(),
	value: text("value").notNull(),
	expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
	createdAt: integer("created_at", { mode: "timestamp_ms" }),
	updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
});

export const passkey = sqliteTable("passkey", {
	id: id("id"),
	name: text("name"),
	publicKey: text("public_key").notNull(),
	userId: text("user_id").notNull(),
	credentialID: text("credential_id").notNull().unique(),
	counter: integer("counter").notNull().default(0),
	deviceType: text("device_type"),
	backedUp: integer("backed_up", { mode: "boolean" }).notNull().default(false),
	transports: text("transports"),
	createdAt: integer("created_at", { mode: "timestamp_ms" }),
	aaguid: text("aaguid"),
});
