import { Hono } from "hono";
import { cors } from "hono/cors";
import { Scalar } from "@scalar/hono-api-reference";
import { z } from "zod";
import { createAuth } from "./auth";
import { db } from "./db";
import { car, component, driveSession, maintenancePlan, owner, serviceRecord } from "./schema";
import { AppContext, AppEnv, carInput, carUpdateInput, componentInput, componentUpdateInput, driveSessionInput, driveSessionUpdateInput, maintenancePlanInput, serviceRecordInput, timezoneInput } from "./types";
import { carListMode, canArchive, canRestore, canWrite, ownsCar } from "./car-policy";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { STANDARD_COMPONENT_SLOTS, canEditComponent, componentSlotType, normalizeComponentSlot } from "./component-policy";
import { hasEmailDelivery, hasMagicLinkConfiguration, isAllowedOrigin, isConfiguredOwner, isLocalDevelopment, normalizeEmail } from "./auth-policy";
import { canDeleteDriveSession, canEditDriveSession, isIanaTimezone, presentDateTime } from "./drive-session-policy";

const app = new Hono<AppEnv>();

app.use("/api/*", async (c, next) => cors({ origin: (origin) => isAllowedOrigin(origin, c.env) ? origin! : "", credentials: true })(c, next));

app.get("/api/openapi.json", (c) => c.json(openApi));
app.get("/api/docs", Scalar({ url: "/api/openapi.json", pageTitle: "RC Mech API" }));
app.get("/docs", (c) => c.redirect("/api/docs"));

app.on(["GET", "POST"], "/api/auth/*", async (c) => {
	if (c.req.path === "/api/auth/sign-in/magic-link" && c.req.method === "POST") {
		const body = await c.req.raw.clone().json().catch(() => null) as { email?: unknown } | null;
		if (!isLocalDevelopment(c.env) && (!hasMagicLinkConfiguration(c.env) || !hasEmailDelivery(c.env))) {
			return c.json({ error: "Magic-link delivery is unavailable" }, 503);
		}
		if (typeof body?.email === "string" && !isConfiguredOwner(normalizeEmail(body.email), c.env)) {
			return c.json({ status: true });
		}
		if (typeof body?.email === "string") {
			const headers = new Headers(c.req.raw.headers);
			headers.set("content-type", "application/json");
			return createAuth(c.env).handler(new Request(c.req.raw, { body: JSON.stringify({ ...body, email: normalizeEmail(body.email) }), headers }));
		}
	}
	return createAuth(c.env).handler(c.req.raw);
});

app.use("/api/v1/*", async (c, next) => {
	if (c.req.path === "/api/v1/health") return next();
	const session = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers });
	if (!session) return c.json({ error: "Authentication required" }, 401);
	c.set("userId", session.user.id);
	return next();
});

app.get("/api/v1/health", (c) => c.json({ ok: true, service: "rc-mech" }));

const ownedCar = async (c: AppContext, carId: string) => {
	const value = await db(c.env).select().from(car).where(and(eq(car.id, carId), eq(car.ownerId, c.get("userId")))).get();
	return value && ownsCar(value.ownerId, c.get("userId")) ? value : undefined;
};

const publicCar = (value: typeof car.$inferSelect) => {
	const { ownerId: _ownerId, ...result } = value;
	return result;
};

const publicComponent = (value: typeof component.$inferSelect) => value;

const ownerTimezone = async (c: AppContext): Promise<string> =>
	(await db(c.env).select({ timezone: owner.timezone }).from(owner).where(eq(owner.id, c.get("userId"))).get())?.timezone ?? "UTC";

const publicDriveSession = (value: typeof driveSession.$inferSelect, timezone: string) => ({
	...value,
	...presentDateTime(value.startedAt, timezone),
});

const driveSessionCount = async (c: AppContext, carId: string) => {
	const rows = await db(c.env).select({ id: driveSession.id }).from(driveSession).where(and(eq(driveSession.carId, carId), isNull(driveSession.deletedAt)));
	return rows.length;
};

const ownedComponent = async (c: AppContext, carId: string, componentId: string) =>
	db(c.env).select().from(component).where(and(eq(component.id, componentId), eq(component.carId, carId))).get();

const parseComponentSlot = (slot: string, requested?: "standard" | "custom") => {
	const slotType = componentSlotType(slot, requested);
	return slotType === "invalid" ? undefined : { slot: slotType === "standard" ? normalizeComponentSlot(slot) : slot.trim(), slotType };
};

app.get("/api/v1/cars", async (c) => {
	const database = db(c.env);
	const archived = c.req.query("archived");
	const listMode = carListMode(archived);
	if (listMode === "invalid") return c.json({ error: "archived must be true or all" }, 400);
	const ownerFilter = eq(car.ownerId, c.get("userId"));
	const where = listMode === "archived"
		? and(ownerFilter, isNotNull(car.archivedAt))
		: listMode === "all"
			? ownerFilter
			: and(ownerFilter, isNull(car.archivedAt));
	const cars = await database.select().from(car).where(where).orderBy(desc(car.createdAt));
	return c.json({ cars: cars.map(publicCar), archived: archived === "true" || archived === "all" });
});

app.post("/api/v1/cars", async (c) => {
	const parsed = carInput.safeParse(await c.req.json());
	if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const value = parsed.data;
	const database = db(c.env);
	await database.insert(car).values({
		id,
		ownerId: c.get("userId"),
		name: value.name,
		make: value.make ?? null,
		model: value.model ?? null,
		scale: value.scale ?? null,
		vehicleType: value.vehicleType ?? null,
		powerType: value.powerType ?? null,
		notes: value.notes ?? null,
		createdAt: now,
	});
	const created = await ownedCar(c, id);
	return c.json({ car: publicCar(created!) }, 201);
});

app.get("/api/v1/cars/:carId", async (c) => {
	const value = await ownedCar(c, c.req.param("carId"));
	if (!value) return c.json({ error: "Car not found" }, 404);
	return c.json({ car: publicCar(value) });
});

app.patch("/api/v1/cars/:carId", async (c) => {
	const parsed = carUpdateInput.safeParse(await c.req.json());
	if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
	const existing = await ownedCar(c, c.req.param("carId"));
	if (!existing) return c.json({ error: "Car not found" }, 404);
	await db(c.env).update(car).set(parsed.data).where(and(eq(car.id, existing.id), eq(car.ownerId, c.get("userId"))));
	const updated = await ownedCar(c, existing.id);
	return c.json({ car: publicCar(updated!) });
});

app.post("/api/v1/cars/:carId/archive", async (c) => {
	const existing = await ownedCar(c, c.req.param("carId"));
	if (!existing) return c.json({ error: "Car not found" }, 404);
	if (!canArchive(existing)) return c.json({ error: "Car is already archived" }, 409);
	await db(c.env).update(car).set({ archivedAt: new Date().toISOString() }).where(and(eq(car.id, existing.id), eq(car.ownerId, c.get("userId"))));
	const archived = await ownedCar(c, existing.id);
	return c.json({ car: publicCar(archived!) });
});

app.post("/api/v1/cars/:carId/restore", async (c) => {
	const existing = await ownedCar(c, c.req.param("carId"));
	if (!existing) return c.json({ error: "Car not found" }, 404);
	if (!canRestore(existing)) return c.json({ error: "Car is already active" }, 409);
	await db(c.env).update(car).set({ archivedAt: null }).where(and(eq(car.id, existing.id), eq(car.ownerId, c.get("userId"))));
	const restored = await ownedCar(c, existing.id);
	return c.json({ car: publicCar(restored!) });
});

app.post("/api/v1/cars/:carId/components", async (c) => {
	const parsed = componentInput.safeParse(await c.req.json());
	if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
	const { carId } = c.req.param();
	const parentCar = await ownedCar(c, carId);
	if (!parentCar) return c.json({ error: "Car not found" }, 404);
	if (!canWrite(parentCar)) return c.json({ error: "Car is archived; restore it before recording new work" }, 409);
	const slot = parseComponentSlot(parsed.data.slot, parsed.data.slotType);
	if (!slot) return c.json({ error: "slotType does not match the selected slot" }, 400);
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const value = parsed.data;
	const database = db(c.env);
	await database.batch([
		database.update(component).set({ removedAt: now }).where(and(eq(component.carId, carId), eq(component.slot, slot.slot), isNull(component.removedAt))),
		database.insert(component).values({
			id,
			carId,
			slot: slot.slot,
			slotType: slot.slotType,
			name: value.name,
			manufacturer: value.manufacturer ?? null,
			model: value.model ?? null,
			serialNumber: value.serialNumber ?? null,
			notes: value.notes ?? null,
			installedAt: value.installedAt ?? now,
			removedAt: null,
		}),
	]);
	const created = await ownedComponent(c, carId, id);
	return c.json({ component: publicComponent(created!) }, 201);
});

app.get("/api/v1/component-slots", (c) => c.json({ standard: STANDARD_COMPONENT_SLOTS }));

app.get("/api/v1/cars/:carId/components", async (c) => {
	const { carId } = c.req.param();
	if (!await ownedCar(c, carId)) return c.json({ error: "Car not found" }, 404);
	const history = c.req.query("history") === "true";
	const where = history ? eq(component.carId, carId) : and(eq(component.carId, carId), isNull(component.removedAt));
	const components = await db(c.env).select().from(component).where(where).orderBy(desc(component.installedAt));
	return c.json({ components: components.map(publicComponent), history });
});

app.get("/api/v1/cars/:carId/components/:componentId", async (c) => {
	const { carId, componentId } = c.req.param();
	if (!await ownedCar(c, carId)) return c.json({ error: "Car not found" }, 404);
	const value = await ownedComponent(c, carId, componentId);
	if (!value) return c.json({ error: "Component not found" }, 404);
	return c.json({ component: publicComponent(value) });
});

app.patch("/api/v1/cars/:carId/components/:componentId", async (c) => {
	const parsed = componentUpdateInput.safeParse(await c.req.json());
	if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
	const { carId, componentId } = c.req.param();
	const parentCar = await ownedCar(c, carId);
	if (!parentCar) return c.json({ error: "Car not found" }, 404);
	if (!canWrite(parentCar)) return c.json({ error: "Car is archived; restore it before recording new work" }, 409);
	const existing = await ownedComponent(c, carId, componentId);
	if (!existing) return c.json({ error: "Component not found" }, 404);
	if (!canEditComponent(existing.removedAt)) return c.json({ error: "Historical component installations are immutable" }, 409);
	await db(c.env).update(component).set({
		name: parsed.data.name,
		manufacturer: parsed.data.manufacturer,
		model: parsed.data.model,
		serialNumber: parsed.data.serialNumber,
		notes: parsed.data.notes,
		installedAt: parsed.data.installedAt,
	}).where(and(eq(component.id, componentId), eq(component.carId, carId)));
	const updated = await ownedComponent(c, carId, componentId);
	return c.json({ component: publicComponent(updated!) });
});

app.post("/api/v1/cars/:carId/components/:componentId/replace", async (c) => {
	const parsed = componentInput.safeParse(await c.req.json());
	if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
	const { carId, componentId } = c.req.param();
	const parentCar = await ownedCar(c, carId);
	if (!parentCar) return c.json({ error: "Car not found" }, 404);
	if (!canWrite(parentCar)) return c.json({ error: "Car is archived; restore it before recording new work" }, 409);
	const previous = await ownedComponent(c, carId, componentId);
	if (!previous) return c.json({ error: "Component not found" }, 404);
	if (previous.removedAt !== null) return c.json({ error: "Component is no longer current" }, 409);
	const slot = parseComponentSlot(parsed.data.slot, parsed.data.slotType);
	if (!slot) return c.json({ error: "slotType does not match the selected slot" }, 400);
	const previousSlot = previous.slotType === "standard" ? normalizeComponentSlot(previous.slot) : previous.slot.trim();
	if (slot.slot !== previousSlot) return c.json({ error: "Replacement must use the existing component slot" }, 400);
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const database = db(c.env);
	await database.batch([
		database.update(component).set({ removedAt: now }).where(and(eq(component.id, previous.id), eq(component.carId, carId), isNull(component.removedAt))),
		database.insert(component).values({
			id,
			carId,
			slot: previous.slot,
			slotType: previous.slotType,
			name: parsed.data.name,
			manufacturer: parsed.data.manufacturer ?? null,
			model: parsed.data.model ?? null,
			serialNumber: parsed.data.serialNumber ?? null,
			notes: parsed.data.notes ?? null,
			installedAt: parsed.data.installedAt ?? now,
			removedAt: null,
		}),
	]);
	const replacement = await ownedComponent(c, carId, id);
	return c.json({ previous: publicComponent({ ...previous, removedAt: now }), component: publicComponent(replacement!) }, 201);
});

app.get("/api/v1/preferences/timezone", async (c) => c.json({ timezone: await ownerTimezone(c) }));

app.patch("/api/v1/preferences/timezone", async (c) => {
	const parsed = timezoneInput.safeParse(await c.req.json());
	if (!parsed.success || !isIanaTimezone(parsed.success ? parsed.data.timezone : "")) {
		return c.json({ error: parsed.success ? "timezone must be a valid IANA timezone" : parsed.error.flatten() }, 400);
	}
	await db(c.env).update(owner).set({ timezone: parsed.data.timezone }).where(eq(owner.id, c.get("userId")));
	return c.json({ timezone: parsed.data.timezone });
});

app.get("/api/v1/cars/:carId/drives/count", async (c) => {
	if (!await ownedCar(c, c.req.param("carId"))) return c.json({ error: "Car not found" }, 404);
	return c.json({ count: await driveSessionCount(c, c.req.param("carId")) });
});

app.get("/api/v1/cars/:carId/drives", async (c) => {
	const { carId } = c.req.param();
	if (!await ownedCar(c, carId)) return c.json({ error: "Car not found" }, 404);
	const history = c.req.query("history") === "true";
	const where = history ? eq(driveSession.carId, carId) : and(eq(driveSession.carId, carId), isNull(driveSession.deletedAt));
	const timezone = await ownerTimezone(c);
	const sessions = await db(c.env).select().from(driveSession).where(where).orderBy(desc(driveSession.startedAt));
	return c.json({ driveSessions: sessions.map((value) => publicDriveSession(value, timezone)), count: sessions.filter((value) => value.deletedAt === null).length, history, timezone });
});

app.post("/api/v1/cars/:carId/drives", async (c) => {
	const carId = c.req.param("carId");
	const parsed = driveSessionInput.safeParse(await c.req.json());
	if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
	const parentCar = await ownedCar(c, carId);
	if (!parentCar) return c.json({ error: "Car not found" }, 404);
	if (!canWrite(parentCar)) return c.json({ error: "Car is archived; restore it before recording new work" }, 409);
	const id = crypto.randomUUID();
	const value = parsed.data;
	const database = db(c.env);
	await database.insert(driveSession).values({
		id,
		carId,
		startedAt: new Date(value.startedAt).toISOString(),
		durationMinutes: value.durationMinutes ?? null,
		conditions: value.conditions ?? null,
		notes: value.notes ?? null,
		deletedAt: null,
	});
	const created = await database.select().from(driveSession).where(and(eq(driveSession.id, id), eq(driveSession.carId, carId))).get();
	return c.json({ driveSession: publicDriveSession(created!, await ownerTimezone(c)) }, 201);
});

app.patch("/api/v1/cars/:carId/drives/:driveId", async (c) => {
	const { carId, driveId } = c.req.param();
	const parentCar = await ownedCar(c, carId);
	if (!parentCar) return c.json({ error: "Car not found" }, 404);
	if (!canWrite(parentCar)) return c.json({ error: "Car is archived; restore it before editing drive history" }, 409);
	const existing = await db(c.env).select().from(driveSession).where(and(eq(driveSession.id, driveId), eq(driveSession.carId, carId))).get();
	if (!existing) return c.json({ error: "Drive session not found" }, 404);
	if (!canEditDriveSession(existing)) return c.json({ error: "Deleted drive sessions are immutable" }, 409);
	const parsed = driveSessionUpdateInput.safeParse(await c.req.json());
	if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
	await db(c.env).update(driveSession).set({
		startedAt: parsed.data.startedAt ? new Date(parsed.data.startedAt).toISOString() : undefined,
		durationMinutes: parsed.data.durationMinutes,
		conditions: parsed.data.conditions,
		notes: parsed.data.notes,
	}).where(and(eq(driveSession.id, driveId), eq(driveSession.carId, carId), isNull(driveSession.deletedAt)));
	const updated = await db(c.env).select().from(driveSession).where(and(eq(driveSession.id, driveId), eq(driveSession.carId, carId), isNull(driveSession.deletedAt))).get();
	if (!updated) return c.json({ error: "Drive session is no longer editable" }, 409);
	return c.json({ driveSession: publicDriveSession(updated!, await ownerTimezone(c)) });
});

app.delete("/api/v1/cars/:carId/drives/:driveId", async (c) => {
	const { carId, driveId } = c.req.param();
	const parentCar = await ownedCar(c, carId);
	if (!parentCar) return c.json({ error: "Car not found" }, 404);
	if (!canWrite(parentCar)) return c.json({ error: "Car is archived; restore it before deleting drive history" }, 409);
	const existing = await db(c.env).select().from(driveSession).where(and(eq(driveSession.id, driveId), eq(driveSession.carId, carId))).get();
	if (!existing) return c.json({ error: "Drive session not found" }, 404);
	if (!canDeleteDriveSession(existing)) return c.json({ error: "Drive session is already deleted" }, 409);
	const deletedAt = new Date().toISOString();
	await db(c.env).update(driveSession).set({ deletedAt }).where(and(eq(driveSession.id, driveId), eq(driveSession.carId, carId), isNull(driveSession.deletedAt)));
	const deleted = { ...existing, deletedAt };
	return c.json({ driveSession: publicDriveSession(deleted, await ownerTimezone(c)) });
});

app.post("/api/v1/cars/:carId/service-records", async (c) => {
	const parsed = serviceRecordInput.safeParse({ ...(await c.req.json()), carId: c.req.param("carId") });
	if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
	const parentCar = await ownedCar(c, parsed.data.carId);
	if (!parentCar) return c.json({ error: "Car not found" }, 404);
	if (!canWrite(parentCar)) return c.json({ error: "Car is archived; restore it before recording new work" }, 409);
	const id = crypto.randomUUID();
	const value = parsed.data;
	const baselineAt = value.baselineAt ?? value.performedAt;
	const database = db(c.env);
	await database.insert(serviceRecord).values({
		id,
		carId: value.carId,
		componentId: value.componentId ?? null,
		performedAt: value.performedAt,
		description: value.description,
		baselineAt,
	});
	return c.json({ serviceRecord: { id, ...value, baselineAt } }, 201);
});

app.post("/api/v1/maintenance-plans", async (c) => {
	const parsed = maintenancePlanInput.safeParse(await c.req.json());
	if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
	const parentCar = await ownedCar(c, parsed.data.carId);
	if (!parentCar) return c.json({ error: "Car not found" }, 404);
	if (!canWrite(parentCar)) return c.json({ error: "Car is archived; restore it before recording new work" }, 409);
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const value = parsed.data;
	const database = db(c.env);
	await database.insert(maintenancePlan).values({
		id,
		carId: value.carId,
		componentId: value.componentId,
		name: value.name,
		intervalDays: value.intervalDays ?? null,
		intervalSessions: value.intervalSessions ?? null,
		baselineAt: now,
		status: "active",
	});
	return c.json({ maintenancePlan: { id, ...value, baselineAt: now, status: "active" } }, 201);
});

app.get("/api/v1/photos/:key{.+}", async (c) => {
	const object = await c.env.PHOTOS?.get(c.req.param("key"));
	if (!object) return c.json({ error: "Photo not found" }, 404);
	return new Response(object.body, { headers: { "Content-Type": object.httpMetadata?.contentType ?? "image/jpeg", "Cache-Control": "private, max-age=300" } });
});

app.all("/api", (c) => c.json({ error: "Not found" }, 404));
app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));
app.all("*", async (c) => {
	const response = await c.env.ASSETS.fetch(c.req.raw);
	if (response.status !== 404 || c.req.method !== "GET" || !c.req.header("Accept")?.includes("text/html")) return response;
	return c.env.ASSETS.fetch(new Request(new URL("/", c.req.url), c.req.raw));
});
export default app;

const carProperties = {
	name: { type: "string", maxLength: 120 },
	make: { type: "string", maxLength: 120 },
	model: { type: "string", maxLength: 120 },
	scale: { type: "string", maxLength: 20 },
	vehicleType: { type: "string", maxLength: 80 },
	powerType: { type: "string", maxLength: 80 },
	notes: { type: "string", maxLength: 4000 },
};
const componentProperties = {
	slot: { type: "string", description: "A standard slot name or an owner-defined custom slot." },
	slotType: { type: "string", enum: ["standard", "custom"] },
	name: { type: "string", maxLength: 160 },
	manufacturer: { type: "string", maxLength: 120 },
	model: { type: "string", maxLength: 120 },
	serialNumber: { type: "string", maxLength: 120 },
	notes: { type: "string", maxLength: 4000 },
	installedAt: { type: "string", format: "date-time" },
	removedAt: { type: "string", format: "date-time", nullable: true },
};
const openApi = {
	openapi: "3.1.0",
	info: { title: "RC Mech API", version: "0.1.0" },
	paths: {
		"/api/v1/cars": {
			get: {
				summary: "List the authenticated owner's cars",
				parameters: [{ name: "archived", in: "query", required: false, schema: { type: "string", enum: ["true", "all"] }, description: "Omit for active cars; true lists archived cars; all lists both." }],
				responses: { 200: { description: "Cars visible to the authenticated owner" }, 401: { description: "Authentication required" } },
			},
			post: {
				summary: "Create an active car for the authenticated owner",
				requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["name"], properties: carProperties } } } },
				responses: { 201: { description: "Car created" }, 400: { description: "Invalid car" } },
			},
		},
		"/api/v1/cars/{carId}": {
			parameters: [{ name: "carId", in: "path", required: true, schema: { type: "string" } }],
			get: { summary: "Inspect an owned car, including archived cars", responses: { 200: { description: "Owned car" }, 404: { description: "Car not found" } } },
			patch: { summary: "Edit an owned car", requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: carProperties } } } }, responses: { 200: { description: "Car updated" }, 400: { description: "Invalid car" }, 404: { description: "Car not found" } } },
		},
		"/api/v1/cars/{carId}/archive": { post: { summary: "Archive an owned car; it leaves the active list", responses: { 200: { description: "Car archived" }, 404: { description: "Car not found" }, 409: { description: "Already archived" } } } },
		"/api/v1/cars/{carId}/restore": { post: { summary: "Restore an owned archived car to the active list", responses: { 200: { description: "Car restored" }, 404: { description: "Car not found" }, 409: { description: "Already active" } } } },
		"/api/v1/component-slots": { get: { summary: "List standard component slots", responses: { 200: { description: "Standard slots; custom slots may also be supplied" } } } },
		"/api/v1/cars/{carId}/components": {
			parameters: [{ name: "carId", in: "path", required: true, schema: { type: "string" } }],
			get: { summary: "List current components, or replacement history with history=true", parameters: [{ name: "history", in: "query", schema: { type: "boolean" } }], responses: { 200: { description: "Owned car components" }, 404: { description: "Car not found" } } },
			post: { summary: "Install a component; an existing current component in the slot is closed", requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["slot", "name"], properties: componentProperties } } } }, responses: { 201: { description: "Component installed" }, 400: { description: "Invalid component or slot" }, 404: { description: "Car not found" }, 409: { description: "Car is archived" } } },
		},
		"/api/v1/cars/{carId}/components/{componentId}": {
			parameters: [{ name: "carId", in: "path", required: true, schema: { type: "string" } }, { name: "componentId", in: "path", required: true, schema: { type: "string" } }],
			get: { summary: "Get an owned component installation", responses: { 200: { description: "Component detail" }, 404: { description: "Component not found" } } },
			patch: { summary: "Edit an owned component", requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: componentProperties } } } }, responses: { 200: { description: "Component updated" }, 400: { description: "Invalid component" }, 404: { description: "Component not found" }, 409: { description: "Car is archived" } } },
		},
		"/api/v1/cars/{carId}/components/{componentId}/replace": { post: { summary: "Replace the current component and preserve its history", parameters: [{ name: "carId", in: "path", required: true, schema: { type: "string" } }, { name: "componentId", in: "path", required: true, schema: { type: "string" } }], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["slot", "name"], properties: componentProperties } } } }, responses: { 201: { description: "Replacement installed" }, 400: { description: "Invalid component or slot" }, 404: { description: "Component not found" }, 409: { description: "Component is not current or car is archived" } } } },
		"/api/v1/preferences/timezone": {
			get: { summary: "Get the authenticated owner's IANA timezone", responses: { 200: { description: "Timezone preference" } } },
			patch: { summary: "Set the authenticated owner's IANA timezone", responses: { 200: { description: "Timezone preference updated" }, 400: { description: "Invalid IANA timezone" } } },
		},
		"/api/v1/cars/{carId}/drives": {
			parameters: [{ name: "carId", in: "path", required: true, schema: { type: "string" } }, { name: "history", in: "query", required: false, schema: { type: "boolean" } }],
			get: { summary: "List an owned car's drive sessions; history=true includes soft-deleted sessions", responses: { 200: { description: "Drive session history" }, 404: { description: "Car not found" } } },
			post: { summary: "Record a drive session for an active owned car", responses: { 201: { description: "Drive recorded" }, 404: { description: "Car not found" }, 409: { description: "Car is archived" } } },
		},
		"/api/v1/cars/{carId}/drives/count": { parameters: [{ name: "carId", in: "path", required: true, schema: { type: "string" } }], get: { summary: "Count non-deleted drive sessions for an owned car", responses: { 200: { description: "Drive session count" }, 404: { description: "Car not found" } } } },
		"/api/v1/cars/{carId}/drives/{driveId}": {
			parameters: [{ name: "carId", in: "path", required: true, schema: { type: "string" } }, { name: "driveId", in: "path", required: true, schema: { type: "string" } }],
			patch: { summary: "Edit an active drive session", responses: { 200: { description: "Drive session updated" }, 404: { description: "Drive session not found" }, 409: { description: "Deleted session" } } },
			delete: { summary: "Soft-delete a drive session", responses: { 200: { description: "Drive session deleted" }, 404: { description: "Drive session not found" }, 409: { description: "Already deleted" } } },
		},
		"/api/v1/cars/{carId}/service-records": { post: { summary: "Record service for an owned car", responses: { 201: { description: "Service recorded" }, 404: { description: "Car not found" }, 409: { description: "Car is archived" } } } },
		"/api/v1/maintenance-plans": { post: { summary: "Create a maintenance plan for an owned car", responses: { 201: { description: "Maintenance plan created" }, 404: { description: "Car not found" }, 409: { description: "Car is archived" } } } },
	},
};
