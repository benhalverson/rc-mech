import { Hono } from "hono";
import { cors } from "hono/cors";
import { Scalar } from "@scalar/hono-api-reference";
import { z } from "zod";
import { createAuth } from "./auth";
import { db } from "./db";
import { car, component, driveSession, maintenancePlan, serviceRecord } from "./schema";
import { carInput, componentInput, driveSessionInput, maintenancePlanInput, serviceRecordInput } from "./types";
import { and, desc, eq, isNull } from "drizzle-orm";

const app = new Hono<{ Bindings: Env }>();

app.use("/api/*", cors({ origin: (origin) => origin ?? "", credentials: true }));

app.get("/api/openapi.json", (c) => c.json(openApi));
app.get("/api/docs", Scalar({ url: "/api/openapi.json", pageTitle: "RC Mech API" }));
app.get("/docs", (c) => c.redirect("/api/docs"));

app.on(["GET", "POST"], "/api/auth/*", async (c) => createAuth(c.env).handler(c.req.raw));

app.use("/api/v1/*", async (c, next) => {
	if (c.req.path === "/api/v1/health") return next();
	const session = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers });
	if (!session) return c.json({ error: "Authentication required" }, 401);
	return next();
});

app.get("/api/v1/health", (c) => c.json({ ok: true, service: "rc-mech" }));

app.get("/api/v1/cars", async (c) => {
	const database = db(c.env);
	const cars = await database.select().from(car).where(isNull(car.archivedAt)).orderBy(desc(car.createdAt));
	return c.json({ cars });
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
		name: value.name,
		manufacturer: value.manufacturer ?? null,
		model: value.model ?? null,
		scale: value.scale ?? null,
		notes: value.notes ?? null,
		createdAt: now,
	});
	return c.json({ car: { id, ...value, createdAt: now } }, 201);
});

app.post("/api/v1/cars/:carId/components", async (c) => {
	const parsed = componentInput.safeParse(await c.req.json());
	if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
	const { carId } = c.req.param();
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

const openApi = { openapi: "3.1.0", info: { title: "RC Mech API", version: "0.1.0" }, paths: { "/api/v1/cars": { get: { summary: "List active cars" }, post: { summary: "Add a car" } }, "/api/v1/cars/{carId}/components": { post: { summary: "Install or replace a component" } }, "/api/v1/cars/{carId}/drives": { post: { summary: "Record a drive session" } }, "/api/v1/cars/{carId}/service-records": { post: { summary: "Record service" } }, "/api/v1/maintenance-plans": { post: { summary: "Create a maintenance plan" } } } };
