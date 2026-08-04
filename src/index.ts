import { Hono } from "hono";
import { cors } from "hono/cors";
import { Scalar } from "@scalar/hono-api-reference";
import { z } from "zod";
import { createAuth } from "./auth";
import { db } from "./db";
import { car, component, driveSession, maintenancePlan, serviceRecord } from "./schema";
import { AppContext, AppEnv, carInput, carUpdateInput, componentInput, driveSessionInput, maintenancePlanInput, serviceRecordInput } from "./types";
import { carListMode, canArchive, canRestore, canWrite, ownsCar } from "./car-policy";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { hasEmailDelivery, hasMagicLinkConfiguration, isAllowedOrigin, isConfiguredOwner, isLocalDevelopment, normalizeEmail } from "./auth-policy";

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
	const value = await db(c.env).select().from(car).where(eq(car.id, carId)).get();
	return value && ownsCar(value.ownerId, c.get("userId")) ? value : undefined;
};

const publicCar = (value: typeof car.$inferSelect) => {
	const { ownerId: _ownerId, ...result } = value;
	return result;
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
	return c.json({ cars: cars.map(publicCar), archived: listMode === "archived" });
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
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const value = parsed.data;
	const database = db(c.env);
	await database.update(component).set({ removedAt: now }).where(and(eq(component.carId, carId), eq(component.slot, value.slot), isNull(component.removedAt)));
	await database.insert(component).values({
		id,
		carId,
		slot: value.slot,
		name: value.name,
		serialNumber: value.serialNumber ?? null,
		notes: value.notes ?? null,
		installedAt: now,
	});
	return c.json({ component: { id, carId, ...value, installedAt: now } }, 201);
});

app.post("/api/v1/cars/:carId/drives", async (c) => {
	const parsed = driveSessionInput.safeParse({ ...(await c.req.json()), carId: c.req.param("carId") });
	if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
	const parentCar = await ownedCar(c, parsed.data.carId);
	if (!parentCar) return c.json({ error: "Car not found" }, 404);
	if (!canWrite(parentCar)) return c.json({ error: "Car is archived; restore it before recording new work" }, 409);
	const id = crypto.randomUUID();
	const value = parsed.data;
	const database = db(c.env);
	await database.insert(driveSession).values({
		id,
		carId: value.carId,
		startedAt: value.startedAt,
		durationMinutes: value.durationMinutes ?? null,
		conditions: value.conditions ?? null,
		notes: value.notes ?? null,
	});
	return c.json({ driveSession: { id, ...value } }, 201);
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
		"/api/v1/cars/{carId}/components": { post: { summary: "Install or replace a component on an owned car", responses: { 201: { description: "Component installed" }, 404: { description: "Car not found" }, 409: { description: "Car is archived" } } } },
		"/api/v1/cars/{carId}/drives": { post: { summary: "Record a drive session for an owned car", responses: { 201: { description: "Drive recorded" }, 404: { description: "Car not found" }, 409: { description: "Car is archived" } } } },
		"/api/v1/cars/{carId}/service-records": { post: { summary: "Record service for an owned car", responses: { 201: { description: "Service recorded" }, 404: { description: "Car not found" }, 409: { description: "Car is archived" } } } },
		"/api/v1/maintenance-plans": { post: { summary: "Create a maintenance plan for an owned car", responses: { 201: { description: "Maintenance plan created" }, 404: { description: "Car not found" }, 409: { description: "Car is archived" } } } },
	},
};
