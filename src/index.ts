import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { createAuth } from "./auth";
import { db } from "./db";
import { carInput, componentInput, driveSessionInput, maintenancePlanInput, serviceRecordInput } from "./types";

const app = new Hono<{ Bindings: Env }>();

app.use("/api/*", cors({ origin: (origin) => origin ?? "", credentials: true }));

app.get("/api/openapi.json", (c) => c.json(openApi));
app.get("/api/docs", (c) => c.html(docsHtml));

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
	if (!database) return c.json({ cars: [] });
	const cars = await database.prepare("SELECT * FROM car WHERE archived_at IS NULL ORDER BY created_at DESC").all();
	return c.json({ cars: cars.results });
});

app.post("/api/v1/cars", async (c) => {
	const parsed = carInput.safeParse(await c.req.json());
	if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const value = parsed.data;
	const database = db(c.env);
	if (!database) return c.json({ car: { id, ...value, createdAt: now } }, 201);
	await database.prepare("INSERT INTO car (id, name, manufacturer, model, scale, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, value.name, value.manufacturer ?? null, value.model ?? null, value.scale ?? null, value.notes ?? null, now).run();
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
	if (database) {
		await database.prepare("UPDATE component SET removed_at = ? WHERE car_id = ? AND slot = ? AND removed_at IS NULL").bind(now, carId, value.slot).run();
		await database.prepare("INSERT INTO component (id, car_id, slot, name, serial_number, notes, installed_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, carId, value.slot, value.name, value.serialNumber ?? null, value.notes ?? null, now).run();
	}
	return c.json({ component: { id, carId, ...value, installedAt: now } }, 201);
});

app.post("/api/v1/cars/:carId/drives", async (c) => {
	const parsed = driveSessionInput.safeParse({ ...(await c.req.json()), carId: c.req.param("carId") });
	if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
	const id = crypto.randomUUID();
	const database = db(c.env);
	if (database) await database.prepare("INSERT INTO drive_session (id, car_id, started_at, duration_minutes, conditions, notes) VALUES (?, ?, ?, ?, ?, ?)").bind(id, parsed.data.carId, parsed.data.startedAt, parsed.data.durationMinutes ?? null, parsed.data.conditions ?? null, parsed.data.notes ?? null).run();
	return c.json({ driveSession: { id, ...parsed.data } }, 201);
});

app.post("/api/v1/cars/:carId/service-records", async (c) => {
	const parsed = serviceRecordInput.safeParse({ ...(await c.req.json()), carId: c.req.param("carId") });
	if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
	const id = crypto.randomUUID();
	const database = db(c.env);
	if (database) await database.prepare("INSERT INTO service_record (id, car_id, component_id, performed_at, description, baseline_at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, parsed.data.carId, parsed.data.componentId ?? null, parsed.data.performedAt, parsed.data.description, parsed.data.baselineAt ?? parsed.data.performedAt).run();
	return c.json({ serviceRecord: { id, ...parsed.data } }, 201);
});

app.post("/api/v1/maintenance-plans", async (c) => {
	const parsed = maintenancePlanInput.safeParse(await c.req.json());
	if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const database = db(c.env);
	if (database) await database.prepare("INSERT INTO maintenance_plan (id, car_id, component_id, name, interval_days, interval_sessions, baseline_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')").bind(id, parsed.data.carId, parsed.data.componentId, parsed.data.name, parsed.data.intervalDays ?? null, parsed.data.intervalSessions ?? null, now).run();
	return c.json({ maintenancePlan: { id, ...parsed.data, baselineAt: now, status: "active" } }, 201);
});

app.get("/api/v1/photos/:key{.+}", async (c) => {
	const object = await c.env.PHOTOS?.get(c.req.param("key"));
	if (!object) return c.json({ error: "Photo not found" }, 404);
	return new Response(object.body, { headers: { "Content-Type": object.httpMetadata?.contentType ?? "image/jpeg", "Cache-Control": "private, max-age=300" } });
});

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));
export default app;

const openApi = { openapi: "3.1.0", info: { title: "RC Mech API", version: "0.1.0" }, paths: { "/api/v1/cars": { get: { summary: "List active cars" }, post: { summary: "Add a car" } }, "/api/v1/cars/{carId}/components": { post: { summary: "Install or replace a component" } }, "/api/v1/cars/{carId}/drives": { post: { summary: "Record a drive session" } }, "/api/v1/cars/{carId}/service-records": { post: { summary: "Record service" } }, "/api/v1/maintenance-plans": { post: { summary: "Create a maintenance plan" } } } };
const docsHtml = `<!doctype html><html><head><title>RC Mech API</title></head><body><h1>RC Mech API</h1><p>Authenticated garage, component, drive-session, maintenance, service, and private-photo endpoints.</p><p><a href="/api/openapi.json">OpenAPI JSON</a></p></body></html>`;
