import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Scalar } from '@scalar/hono-api-reference';
import { createAuth } from './auth';
import { db } from './db';
import {
	car,
	component,
	driveSession,
	maintenancePlan,
	owner,
	photo,
	serviceRecord,
	setup,
	setupImportDraft,
} from './schema';
import {
	AppContext,
	AppEnv,
	carInput,
	carUpdateInput,
	componentInput,
	componentUpdateInput,
	driveSessionInput,
	driveSessionUpdateInput,
	maintenanceCompletionInput,
	maintenancePlanInput,
	maintenancePlanUpdateInput,
	photoReorderInput,
	photoUpdateInput,
	serviceRecordInput,
	serviceRecordUpdateInput,
	setupCopyInput,
	setupInput,
	setupUpdateInput,
	setupImportAcceptInput,
	setupImportDraftInput,
	setupImportDraftUpdateInput,
	type SetupInput,
	timezoneInput,
} from './types';
import {
	carListMode,
	canArchive,
	canRestore,
	canWrite,
	ownsCar,
} from './car-policy';
import { and, desc, eq, isNotNull, isNull, or } from 'drizzle-orm';
import {
	STANDARD_COMPONENT_SLOTS,
	canEditComponent,
	componentSlotType,
	normalizeComponentSlot,
} from './component-policy';
import {
	hasEmailDelivery,
	hasMagicLinkConfiguration,
	isAllowedOrigin,
	isConfiguredOwner,
	isLocalDevelopment,
	normalizeEmail,
} from './auth-policy';
import {
	canDeleteDriveSession,
	canEditDriveSession,
	isIanaTimezone,
	presentDateTime,
} from './drive-session-policy';
import {
	calculateMaintenanceDue,
	canTransitionMaintenance,
	type MaintenanceIntervalUnit,
	type MaintenanceStatus,
} from './maintenance-policy';
import {
	canDeleteServiceRecord,
	canEditServiceRecord,
	shouldRestoreBaseline,
} from './service-policy';
import {
	PHOTO_MAX_BYTES,
	isCompletePhotoOrder,
	normalizePhotoOrder,
	photoObjectKey,
	primaryAfterDelete,
	validatePhotoMetadata,
} from './photo-policy';
import {
	canWriteSetup,
	chooseCopySource,
	ownsSetup,
	shouldSelectCurrentSetup,
} from './setup-policy';
import {
	canonicalSetupImportUrl,
	defaultImportExtractor,
	resolveSetupImport,
	sourceKeyFor,
	type SetupImportExtraction,
	type SetupImportSource,
} from './setup-import-policy';

const app = new Hono<AppEnv>();

const required = <T>(value: T | null | undefined, message: string): T => {
	if (value == null) throw new Error(message);
	return value;
};

app.use('/api/*', async (c, next) =>
	cors({
		origin: (origin) => (isAllowedOrigin(origin, c.env) ? (origin ?? '') : ''),
		credentials: true,
	})(c, next),
);

app.get('/api/openapi.json', (c) => c.json(openApi));
app.get(
	'/api/docs',
	Scalar({ url: '/api/openapi.json', pageTitle: 'RC Mech API' }),
);
app.get('/docs', (c) => c.redirect('/api/docs'));

app.on(['GET', 'POST'], '/api/auth/*', async (c) => {
	if (
		c.req.path === '/api/auth/sign-in/magic-link' &&
		c.req.method === 'POST'
	) {
		const body = (await c.req.raw
			.clone()
			.json()
			.catch(() => null)) as { email?: unknown } | null;
		if (
			!isLocalDevelopment(c.env) &&
			(!hasMagicLinkConfiguration(c.env) || !hasEmailDelivery(c.env))
		) {
			return c.json({ error: 'Magic-link delivery is unavailable' }, 503);
		}
		if (
			typeof body?.email === 'string' &&
			!isConfiguredOwner(normalizeEmail(body.email), c.env)
		) {
			return c.json({ status: true });
		}
		if (typeof body?.email === 'string') {
			const headers = new Headers(c.req.raw.headers);
			headers.set('content-type', 'application/json');
			return createAuth(c.env).handler(
				new Request(c.req.raw, {
					body: JSON.stringify({ ...body, email: normalizeEmail(body.email) }),
					headers,
				}),
			);
		}
	}
	return createAuth(c.env).handler(c.req.raw);
});

app.use('/api/v1/*', async (c, next) => {
	if (c.req.path === '/api/v1/health') return next();
	const session = await createAuth(c.env).api.getSession({
		headers: c.req.raw.headers,
	});
	if (!session) return c.json({ error: 'Authentication required' }, 401);
	c.set('userId', session.user.id);
	return next();
});

app.get('/api/v1/health', (c) => c.json({ ok: true, service: 'rc-mech' }));

const ownedCar = async (c: AppContext, carId: string) => {
	const value = await db(c.env)
		.select()
		.from(car)
		.where(and(eq(car.id, carId), eq(car.ownerId, c.get('userId'))))
		.get();
	return value && ownsCar(value.ownerId, c.get('userId')) ? value : undefined;
};

const publicCar = (value: typeof car.$inferSelect) => {
	const { ownerId: _ownerId, ...result } = value;
	return result;
};

const jsonText = (value: unknown): string | null | undefined =>
	value === undefined
		? undefined
		: value === null
			? null
			: JSON.stringify(value);

const jsonValue = (value: string | null): unknown => {
	if (value === null) return null;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
};

const readLimitedText = async (response: Response, limit = 1_000_000) => {
	if (!response.body) return '';
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			size += next.value.byteLength;
			if (size > limit) throw new Error('Source page is too large');
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
};

const fetchSoDialedSource = async (url: URL): Promise<SetupImportSource> => {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 8_000);
	try {
		const response = await fetch(url, {
			redirect: 'manual',
			headers: { accept: 'text/html' },
			signal: controller.signal,
		});
		if (!response.ok || response.headers.has('location'))
			throw new Error('So Dialed setup page is unavailable');
		const canonicalUrl = canonicalSetupImportUrl(response.url);
		if (!canonicalUrl)
			throw new Error('So Dialed source redirected unexpectedly');
		return { canonicalUrl, html: await readLimitedText(response) };
	} finally {
		clearTimeout(timeout);
	}
};

const publicImportDraft = (value: typeof setupImportDraft.$inferSelect) => ({
	id: value.id,
	carId: value.carId,
	sourceUrl: value.sourceUrl,
	status: value.status,
	sourceIdentity: jsonValue(value.sourceIdentity),
	source: {
		url: value.sourceUrl,
		hasPdfReference: value.sourcePdfReference !== null,
		metadata: jsonValue(value.sourceMetadata),
	},
	knownValues: jsonValue(value.knownValues) ?? {},
	uncertainValues: jsonValue(value.uncertainValues) ?? {},
	rawValues: jsonValue(value.rawValues) ?? {},
	unmappedValues: jsonValue(value.unmappedValues) ?? {},
	error: value.error,
	acceptedSetupId: value.acceptedSetupId,
	createdAt: value.createdAt,
	updatedAt: value.updatedAt,
});

const draftValues = (value: SetupImportExtraction) => ({
	sourceIdentity: jsonText(value.sourceIdentity) ?? null,
	sourcePdfReference: value.sourcePdfReference ?? null,
	sourceMetadata: jsonText(value.sourceMetadata) ?? null,
	knownValues: jsonText(value.knownValues) ?? null,
	uncertainValues: jsonText(value.uncertainValues) ?? null,
	rawValues: jsonText(value.rawValues) ?? null,
	unmappedValues: jsonText(value.unmappedValues) ?? null,
});

const publicSetup = (value: typeof setup.$inferSelect, current = false) => {
	const sourceMetadata = jsonValue(value.sourceMetadata);
	const sourceObject =
		sourceMetadata && typeof sourceMetadata === 'object'
			? (sourceMetadata as { pdfUrl?: string; pdfPage?: number })
			: null;
	return {
		id: value.id,
		carId: value.carId,
		name: value.name,
		status: value.status,
		current,
		context: {
			recordedAt: value.setupDate,
			track: value.track,
			event: value.event,
			surface: value.surface,
			traction: value.traction,
			moisture: value.moisture,
			condition: value.condition,
			temperature: value.temperature,
		},
		sections: {
			vehicle: jsonValue(value.vehicle) ?? {},
			drivetrain: jsonValue(value.drivetrain) ?? {},
			electronics: jsonValue(value.electronics) ?? {},
			tires: jsonValue(value.tires) ?? {},
			shocks: jsonValue(value.shocks) ?? {},
			frontSuspension: jsonValue(value.frontSuspension) ?? {},
			rearSuspension: jsonValue(value.rearSuspension) ?? {},
			notes: value.notes ? { setupNotes: value.notes } : {},
		},
		notes: value.notes,
		source: {
			url: value.sourceUrl,
			pdfUrl: sourceObject?.pdfUrl ?? null,
			pdfTitle: value.sourcePdfReference,
			pdfPage: sourceObject?.pdfPage ?? null,
			metadata: sourceMetadata,
		},
		copiedFromSetupId: value.copiedFromId,
		rawValues: jsonValue(value.rawValues),
		unmappedValues: jsonValue(value.unmappedValues),
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
	};
};

const setupInsertValues = (
	id: string,
	carId: string,
	value: SetupInput,
	now: string,
	copiedFromId: string | null = null,
) => ({
	id,
	carId,
	name: value.name,
	status: value.status ?? 'active',
	setupDate: value.setupDate ? new Date(value.setupDate).toISOString() : null,
	track: value.track ?? null,
	event: value.event ?? null,
	surface: value.surface ?? null,
	traction: value.traction ?? null,
	moisture: value.moisture ?? null,
	condition: value.condition ?? null,
	temperature: value.temperature ?? null,
	vehicle: jsonText(value.vehicle) ?? null,
	drivetrain: jsonText(value.drivetrain) ?? null,
	electronics: jsonText(value.electronics) ?? null,
	tires: jsonText(value.tires) ?? null,
	shocks: jsonText(value.shocks) ?? null,
	frontSuspension: jsonText(value.frontSuspension) ?? null,
	rearSuspension: jsonText(value.rearSuspension) ?? null,
	notes: value.notes ?? null,
	sourceUrl: value.sourceUrl ?? null,
	sourcePdfReference: value.sourcePdfReference ?? null,
	sourceMetadata: jsonText(value.sourceMetadata) ?? null,
	copiedFromId,
	rawValues: jsonText(value.rawValues) ?? null,
	unmappedValues: jsonText(value.unmappedValues) ?? null,
	createdAt: now,
	updatedAt: now,
});

const setupCopyValue = (value: typeof setup.$inferSelect): SetupInput => ({
	name: value.name,
	status: value.status as SetupInput['status'],
	setupDate: value.setupDate ?? undefined,
	track: value.track ?? undefined,
	event: value.event ?? undefined,
	surface: value.surface ?? undefined,
	traction: value.traction ?? undefined,
	moisture: value.moisture ?? undefined,
	condition: value.condition ?? undefined,
	temperature: value.temperature ?? undefined,
	vehicle:
		(jsonValue(value.vehicle) as Record<string, unknown> | null) ?? undefined,
	drivetrain:
		(jsonValue(value.drivetrain) as Record<string, unknown> | null) ??
		undefined,
	electronics:
		(jsonValue(value.electronics) as Record<string, unknown> | null) ??
		undefined,
	tires:
		(jsonValue(value.tires) as Record<string, unknown> | null) ?? undefined,
	shocks:
		(jsonValue(value.shocks) as Record<string, unknown> | null) ?? undefined,
	frontSuspension:
		(jsonValue(value.frontSuspension) as Record<string, unknown> | null) ??
		undefined,
	rearSuspension:
		(jsonValue(value.rearSuspension) as Record<string, unknown> | null) ??
		undefined,
	notes: value.notes ?? undefined,
	sourceUrl: value.sourceUrl ?? undefined,
	sourcePdfReference: value.sourcePdfReference ?? undefined,
	sourceMetadata:
		(jsonValue(value.sourceMetadata) as Record<string, unknown> | null) ??
		undefined,
	rawValues:
		(jsonValue(value.rawValues) as Record<string, unknown> | null) ?? undefined,
	unmappedValues:
		(jsonValue(value.unmappedValues) as Record<string, unknown> | null) ??
		undefined,
});

const ownedSetup = async (c: AppContext, carId: string, setupId: string) => {
	const value = await db(c.env)
		.select()
		.from(setup)
		.where(and(eq(setup.id, setupId), eq(setup.carId, carId)))
		.get();
	return value && ownsSetup(value, carId) && (await ownedCar(c, carId))
		? value
		: undefined;
};

const publicComponent = (value: typeof component.$inferSelect) => value;

const ownerTimezone = async (c: AppContext): Promise<string> =>
	(
		await db(c.env)
			.select({ timezone: owner.timezone })
			.from(owner)
			.where(eq(owner.id, c.get('userId')))
			.get()
	)?.timezone ?? 'UTC';

const publicDriveSession = (
	value: typeof driveSession.$inferSelect,
	timezone: string,
) => ({
	...value,
	...presentDateTime(value.startedAt, timezone),
});

const driveSessionCount = async (c: AppContext, carId: string) => {
	const rows = await db(c.env)
		.select({ id: driveSession.id })
		.from(driveSession)
		.where(and(eq(driveSession.carId, carId), isNull(driveSession.deletedAt)));
	return rows.length;
};

const planSessionCount = driveSessionCount;

const planDue = (
	value: typeof maintenancePlan.$inferSelect,
	currentSessionCount: number,
	timezone: string,
	now = new Date().toISOString(),
) => {
	const intervalUnit = (value.intervalUnit ||
		(value.intervalDays ? 'days' : 'none')) as MaintenanceIntervalUnit;
	const intervalValue = value.intervalValue || value.intervalDays || 1;
	return {
		...value,
		intervalUnit,
		intervalValue: intervalUnit === 'none' ? null : intervalValue,
		currentSessionCount,
		timezone,
		...calculateMaintenanceDue({
			status: value.status as MaintenanceStatus,
			baselineAt: value.baselineAt,
			baselineSessionCount: value.baselineSessionCount,
			intervalUnit,
			intervalValue,
			intervalSessions: value.intervalSessions,
			currentSessionCount,
			now,
			timezone,
		}),
	};
};

const sessionCountsForCars = async (c: AppContext, carIds: string[]) => {
	if (!carIds.length) return new Map<string, number>();
	const rows = await db(c.env)
		.select({ carId: driveSession.carId })
		.from(driveSession)
		.where(
			and(
				isNull(driveSession.deletedAt),
				or(...carIds.map((carId) => eq(driveSession.carId, carId))),
			),
		);
	const counts = new Map<string, number>();
	for (const row of rows)
		counts.set(row.carId, (counts.get(row.carId) ?? 0) + 1);
	return counts;
};

const carPlan = async (c: AppContext, planId: string) => {
	const value = await db(c.env)
		.select()
		.from(maintenancePlan)
		.where(eq(maintenancePlan.id, planId))
		.get();
	return value && (await ownedCar(c, value.carId)) ? value : undefined;
};

const ownedComponent = async (
	c: AppContext,
	carId: string,
	componentId: string,
) =>
	db(c.env)
		.select()
		.from(component)
		.where(and(eq(component.id, componentId), eq(component.carId, carId)))
		.get();

const ownedPhoto = async (c: AppContext, photoId: string) => {
	const value = await db(c.env)
		.select()
		.from(photo)
		.where(eq(photo.id, photoId))
		.get();
	return value && (await ownedCar(c, value.carId)) ? value : undefined;
};

const publicPhoto = (value: typeof photo.$inferSelect) => ({
	id: value.id,
	carId: value.carId,
	fileName: value.fileName,
	contentType: value.contentType,
	byteSize: value.byteSize,
	sortOrder: value.sortOrder,
	isPrimary: value.isPrimary,
	createdAt: value.createdAt,
	url: `/api/v1/photos/${value.id}`,
});

const parsePhotoForm = async (c: AppContext) => {
	const body = await c.req.parseBody();
	const file = body.file;
	if (!(file instanceof File))
		return { error: 'A photo file is required' as const };
	const fileName = file.name.trim();
	const contentType = file.type.toLowerCase();
	const error = validatePhotoMetadata({
		contentType,
		fileName,
		byteSize: file.size,
	});
	if (error) return { error };
	return {
		file,
		fileName,
		contentType,
		sortOrder: body.sortOrder,
		primary: body.primary,
	};
};

const parseComponentSlot = (
	slot: string,
	requested?: 'standard' | 'custom',
) => {
	const slotType = componentSlotType(slot, requested);
	return slotType === 'invalid'
		? undefined
		: {
				slot:
					slotType === 'standard' ? normalizeComponentSlot(slot) : slot.trim(),
				slotType,
			};
};

app.get('/api/v1/cars', async (c) => {
	const database = db(c.env);
	const archived = c.req.query('archived');
	const listMode = carListMode(archived);
	if (listMode === 'invalid')
		return c.json({ error: 'archived must be true or all' }, 400);
	const ownerFilter = eq(car.ownerId, c.get('userId'));
	const where =
		listMode === 'archived'
			? and(ownerFilter, isNotNull(car.archivedAt))
			: listMode === 'all'
				? ownerFilter
				: and(ownerFilter, isNull(car.archivedAt));
	const cars = await database
		.select()
		.from(car)
		.where(where)
		.orderBy(desc(car.createdAt));
	return c.json({
		cars: cars.map(publicCar),
		archived: archived === 'true' || archived === 'all',
	});
});

app.post('/api/v1/cars', async (c) => {
	const parsed = carInput.safeParse(await c.req.json());
	if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const value = parsed.data;
	const database = db(c.env);
	await database.insert(car).values({
		id,
		ownerId: c.get('userId'),
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
	return c.json(
		{ car: publicCar(required(created, 'Created car could not be loaded')) },
		201,
	);
});

app.get('/api/v1/cars/:carId', async (c) => {
	const value = await ownedCar(c, c.req.param('carId'));
	if (!value) return c.json({ error: 'Car not found' }, 404);
	return c.json({ car: publicCar(value) });
});

app.patch('/api/v1/cars/:carId', async (c) => {
	const parsed = carUpdateInput.safeParse(await c.req.json());
	if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
	const existing = await ownedCar(c, c.req.param('carId'));
	if (!existing) return c.json({ error: 'Car not found' }, 404);
	await db(c.env)
		.update(car)
		.set(parsed.data)
		.where(and(eq(car.id, existing.id), eq(car.ownerId, c.get('userId'))));
	const updated = await ownedCar(c, existing.id);
	return c.json({
		car: publicCar(required(updated, 'Updated car could not be loaded')),
	});
});

app.post('/api/v1/cars/:carId/archive', async (c) => {
	const existing = await ownedCar(c, c.req.param('carId'));
	if (!existing) return c.json({ error: 'Car not found' }, 404);
	if (!canArchive(existing))
		return c.json({ error: 'Car is already archived' }, 409);
	const archivedAt = new Date().toISOString();
	const database = db(c.env);
	await database.batch([
		database
			.update(car)
			.set({ archivedAt })
			.where(and(eq(car.id, existing.id), eq(car.ownerId, c.get('userId')))),
		database
			.update(maintenancePlan)
			.set({ status: 'paused', pauseReason: 'car', pausedAt: archivedAt })
			.where(
				and(
					eq(maintenancePlan.carId, existing.id),
					eq(maintenancePlan.status, 'active'),
				),
			),
	]);
	const archived = await ownedCar(c, existing.id);
	return c.json({
		car: publicCar(required(archived, 'Archived car could not be loaded')),
	});
});

app.post('/api/v1/cars/:carId/restore', async (c) => {
	const existing = await ownedCar(c, c.req.param('carId'));
	if (!existing) return c.json({ error: 'Car not found' }, 404);
	if (!canRestore(existing))
		return c.json({ error: 'Car is already active' }, 409);
	const database = db(c.env);
	await database.batch([
		database
			.update(car)
			.set({ archivedAt: null })
			.where(and(eq(car.id, existing.id), eq(car.ownerId, c.get('userId')))),
		database
			.update(maintenancePlan)
			.set({ status: 'active', pauseReason: null, pausedAt: null })
			.where(
				and(
					eq(maintenancePlan.carId, existing.id),
					eq(maintenancePlan.status, 'paused'),
					eq(maintenancePlan.pauseReason, 'car'),
				),
			),
	]);
	const restored = await ownedCar(c, existing.id);
	return c.json({
		car: publicCar(required(restored, 'Restored car could not be loaded')),
	});
});

app.get('/api/v1/cars/:carId/setups/current', async (c) => {
	const parentCar = await ownedCar(c, c.req.param('carId'));
	if (!parentCar) return c.json({ error: 'Car not found' }, 404);
	if (!parentCar.currentSetupId) return c.json({ setup: null });
	const current = await ownedSetup(c, parentCar.id, parentCar.currentSetupId);
	return c.json({ setup: current ? publicSetup(current, true) : null });
});

app.get('/api/v1/cars/:carId/setups', async (c) => {
	const carId = c.req.param('carId');
	const parentCar = await ownedCar(c, carId);
	if (!parentCar) return c.json({ error: 'Car not found' }, 404);
	const values = await db(c.env)
		.select()
		.from(setup)
		.where(eq(setup.carId, carId))
		.orderBy(desc(setup.updatedAt), desc(setup.createdAt));
	return c.json({
		currentSetupId: parentCar.currentSetupId,
		setups: values.map((value) =>
			publicSetup(value, value.id === parentCar?.currentSetupId),
		),
	});
});

app.post('/api/v1/cars/:carId/setups', async (c) => {
	const carId = c.req.param('carId');
	const parentCar = await ownedCar(c, carId);
	if (!parentCar) return c.json({ error: 'Car not found' }, 404);
	if (!canWriteSetup(parentCar))
		return c.json(
			{ error: 'Car is archived; restore it before editing setups' },
			409,
		);
	const parsed = setupInput.safeParse(await c.req.json());
	if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const database = db(c.env);
	const value = setupInsertValues(id, carId, parsed.data, now);
	await database.batch([
		database.insert(setup).values(value),
		...(shouldSelectCurrentSetup(parsed.data.makeCurrent)
			? [
					database
						.update(car)
						.set({ currentSetupId: id })
						.where(eq(car.id, carId)),
				]
			: []),
	]);
	const created = await database
		.select()
		.from(setup)
		.where(eq(setup.id, id))
		.get();
	return c.json(
		{
			setup: publicSetup(
				required(created, 'Created setup could not be loaded'),
				parsed.data.makeCurrent === true,
			),
		},
		201,
	);
});

app.get('/api/v1/cars/:carId/setups/:setupId', async (c) => {
	const carId = c.req.param('carId');
	const value = await ownedSetup(c, carId, c.req.param('setupId'));
	if (!value) return c.json({ error: 'Setup not found' }, 404);
	const parentCar = await ownedCar(c, carId);
	return c.json({
		setup: publicSetup(value, value.id === parentCar?.currentSetupId),
	});
});

app.post('/api/v1/cars/:carId/setups/copy', async (c) => {
	const carId = c.req.param('carId');
	const parentCar = await ownedCar(c, carId);
	if (!parentCar) return c.json({ error: 'Car not found' }, 404);
	if (!canWriteSetup(parentCar))
		return c.json(
			{ error: 'Car is archived; restore it before copying setups' },
			409,
		);
	const parsed = setupCopyInput.safeParse(await c.req.json().catch(() => ({})));
	if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
	const candidates = await db(c.env)
		.select()
		.from(setup)
		.where(eq(setup.carId, carId))
		.orderBy(desc(setup.updatedAt), desc(setup.createdAt));
	const source = chooseCopySource(candidates, parentCar.currentSetupId);
	if (!source) return c.json({ error: 'No setup exists to copy' }, 404);
	const value = { ...setupCopyValue(source), ...parsed.data };
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const database = db(c.env);
	await database.batch([
		database
			.insert(setup)
			.values(setupInsertValues(id, carId, value, now, source.id)),
		...(shouldSelectCurrentSetup(parsed.data.makeCurrent)
			? [
					database
						.update(car)
						.set({ currentSetupId: id })
						.where(eq(car.id, carId)),
				]
			: []),
	]);
	const copied = await database
		.select()
		.from(setup)
		.where(eq(setup.id, id))
		.get();
	return c.json(
		{
			setup: publicSetup(
				required(copied, 'Copied setup could not be loaded'),
				parsed.data.makeCurrent === true,
			),
			sourceSetupId: source.id,
		},
		201,
	);
});

app.patch('/api/v1/cars/:carId/setups/:setupId', async (c) => {
	const carId = c.req.param('carId');
	const parentCar = await ownedCar(c, carId);
	if (!parentCar) return c.json({ error: 'Car not found' }, 404);
	if (!canWriteSetup(parentCar))
		return c.json(
			{ error: 'Car is archived; restore it before editing setups' },
			409,
		);
	const existing = await ownedSetup(c, carId, c.req.param('setupId'));
	if (!existing) return c.json({ error: 'Setup not found' }, 404);
	const parsed = setupUpdateInput.safeParse(await c.req.json());
	if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
	const value = parsed.data;
	await db(c.env)
		.update(setup)
		.set({
			name: value.name,
			status: value.status,
			setupDate:
				value.setupDate === undefined
					? undefined
					: value.setupDate === null
						? null
						: new Date(value.setupDate).toISOString(),
			track: value.track,
			event: value.event,
			surface: value.surface,
			traction: value.traction,
			moisture: value.moisture,
			condition: value.condition,
			temperature: value.temperature,
			vehicle: jsonText(value.vehicle),
			drivetrain: jsonText(value.drivetrain),
			electronics: jsonText(value.electronics),
			tires: jsonText(value.tires),
			shocks: jsonText(value.shocks),
			frontSuspension: jsonText(value.frontSuspension),
			rearSuspension: jsonText(value.rearSuspension),
			notes: value.notes,
			sourceUrl: value.sourceUrl,
			sourcePdfReference: value.sourcePdfReference,
			sourceMetadata: jsonText(value.sourceMetadata),
			rawValues: jsonText(value.rawValues),
			unmappedValues: jsonText(value.unmappedValues),
			updatedAt: new Date().toISOString(),
		})
		.where(eq(setup.id, existing.id));
	const updated = required(
		await ownedSetup(c, carId, existing.id),
		'Updated setup could not be loaded',
	);
	return c.json({
		setup: publicSetup(updated, updated.id === parentCar.currentSetupId),
	});
});

app.post('/api/v1/cars/:carId/setups/:setupId/copy', async (c) => {
	const carId = c.req.param('carId');
	const parentCar = await ownedCar(c, carId);
	if (!parentCar) return c.json({ error: 'Car not found' }, 404);
	if (!canWriteSetup(parentCar))
		return c.json(
			{ error: 'Car is archived; restore it before copying setups' },
			409,
		);
	const source = await ownedSetup(c, carId, c.req.param('setupId'));
	if (!source) return c.json({ error: 'Setup not found' }, 404);
	const parsed = setupCopyInput.safeParse(await c.req.json().catch(() => ({})));
	if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
	const sourceValue = setupCopyValue(source);
	const value = { ...sourceValue, ...parsed.data };
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const database = db(c.env);
	await database.batch([
		database
			.insert(setup)
			.values(setupInsertValues(id, carId, value, now, source.id)),
		...(shouldSelectCurrentSetup(parsed.data.makeCurrent)
			? [
					database
						.update(car)
						.set({ currentSetupId: id })
						.where(eq(car.id, carId)),
				]
			: []),
	]);
	const copied = await database
		.select()
		.from(setup)
		.where(eq(setup.id, id))
		.get();
	return c.json(
		{
			setup: publicSetup(
				required(copied, 'Copied setup could not be loaded'),
				parsed.data.makeCurrent === true,
			),
		},
		201,
	);
});

app.post('/api/v1/cars/:carId/setups/:setupId/current', async (c) => {
	const carId = c.req.param('carId');
	const parentCar = await ownedCar(c, carId);
	if (!parentCar) return c.json({ error: 'Car not found' }, 404);
	if (!canWriteSetup(parentCar))
		return c.json(
			{ error: 'Car is archived; restore it before selecting a setup' },
			409,
		);
	const value = await ownedSetup(c, carId, c.req.param('setupId'));
	if (!value) return c.json({ error: 'Setup not found' }, 404);
	await db(c.env)
		.update(car)
		.set({ currentSetupId: value.id })
		.where(eq(car.id, carId));
	return c.json({ setup: publicSetup(value, true) });
});

const ownedImportDraft = async (c: AppContext, draftId: string) =>
	db(c.env)
		.select()
		.from(setupImportDraft)
		.where(
			and(
				eq(setupImportDraft.id, draftId),
				eq(setupImportDraft.ownerId, c.get('userId')),
			),
		)
		.get();

const ownedImportedSetup = async (c: AppContext, sourceKey: string) => {
	const candidates = await db(c.env)
		.select()
		.from(setup)
		.where(eq(setup.sourceUrl, sourceKey));
	for (const candidate of candidates) {
		if (await ownedCar(c, candidate.carId)) return candidate;
	}
	return undefined;
};

const draftSetupInput = (
	draft: typeof setupImportDraft.$inferSelect,
	name?: string,
): SetupInput => {
	const known = jsonValue(draft.knownValues);
	const raw = jsonValue(draft.rawValues);
	const uncertain = jsonValue(draft.uncertainValues);
	const unmapped = jsonValue(draft.unmappedValues);
	const identity = jsonValue(draft.sourceIdentity);
	const candidate = {
		...(known && typeof known === 'object' ? known : {}),
		name:
			name ??
			(identity && typeof identity === 'object' && 'title' in identity
				? String(identity.title)
				: 'Imported setup'),
		status: 'reviewed' as const,
		sourceUrl: draft.sourceUrl,
		sourcePdfReference: draft.sourcePdfReference ?? undefined,
		sourceMetadata:
			(jsonValue(draft.sourceMetadata) as Record<string, unknown> | null) ??
			undefined,
		rawValues: {
			...(raw && typeof raw === 'object' ? raw : {}),
			uncertainValues: uncertain ?? {},
		},
		unmappedValues:
			unmapped && typeof unmapped === 'object'
				? (unmapped as Record<string, unknown>)
				: {},
	};
	const parsed = setupInput.safeParse(candidate);
	if (parsed.success) return parsed.data;
	return {
		name: candidate.name,
		status: 'reviewed',
		sourceUrl: draft.sourceUrl,
		sourcePdfReference: draft.sourcePdfReference ?? undefined,
		sourceMetadata:
			(jsonValue(draft.sourceMetadata) as Record<string, unknown> | null) ??
			undefined,
		rawValues: candidate.rawValues as Record<string, unknown>,
		unmappedValues: candidate.unmappedValues as Record<string, unknown>,
	};
};

app.post('/api/v1/setup-imports/drafts', async (c) => {
	const parsed = setupImportDraftInput.safeParse(await c.req.json());
	if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
	const sourceKey = sourceKeyFor(parsed.data.sourceUrl);
	if (!sourceKey)
		return c.json({ error: 'Unsupported So Dialed setup URL' }, 400);
	if (parsed.data.carId && !(await ownedCar(c, parsed.data.carId)))
		return c.json({ error: 'Car not found' }, 404);
	const existingSetup = await ownedImportedSetup(c, sourceKey);
	const existingDraft = await db(c.env)
		.select()
		.from(setupImportDraft)
		.where(
			and(
				eq(setupImportDraft.ownerId, c.get('userId')),
				eq(setupImportDraft.sourceKey, sourceKey),
				eq(setupImportDraft.status, 'draft'),
			),
		)
		.get();
	if (existingSetup || existingDraft)
		return c.json(
			{
				error: 'Source has already been imported',
				existingSetupId: existingSetup?.id ?? null,
				draft: existingDraft ? publicImportDraft(existingDraft) : null,
			},
			409,
		);

	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	let extraction: SetupImportExtraction;
	try {
		const resolved = await resolveSetupImport(
			sourceKey,
			fetchSoDialedSource,
			defaultImportExtractor,
		);
		extraction = resolved;
	} catch (error) {
		const message =
			error instanceof Error ? error.message : 'Source unavailable';
		await db(c.env)
			.insert(setupImportDraft)
			.values({
				id,
				ownerId: c.get('userId'),
				carId: parsed.data.carId ?? null,
				sourceUrl: sourceKey,
				sourceKey,
				status: 'error',
				error: message,
				createdAt: now,
				updatedAt: now,
			});
		const draft = await ownedImportDraft(c, id);
		return c.json(
			{
				error: message,
				draft: publicImportDraft(
					required(draft, 'Import draft could not be loaded'),
				),
			},
			422,
		);
	}
	try {
		await db(c.env)
			.insert(setupImportDraft)
			.values({
				id,
				ownerId: c.get('userId'),
				carId: parsed.data.carId ?? null,
				sourceUrl: sourceKey,
				sourceKey,
				status: 'draft',
				...draftValues(extraction),
				createdAt: now,
				updatedAt: now,
			});
	} catch (error) {
		if (!(error instanceof Error) || !error.message.includes('UNIQUE'))
			throw error;
		const concurrent = await db(c.env)
			.select()
			.from(setupImportDraft)
			.where(
				and(
					eq(setupImportDraft.ownerId, c.get('userId')),
					eq(setupImportDraft.sourceKey, sourceKey),
					eq(setupImportDraft.status, 'draft'),
				),
			)
			.get();
		return c.json(
			{
				error: 'An open draft already exists for this source',
				draft: concurrent ? publicImportDraft(concurrent) : null,
			},
			409,
		);
	}
	const draft = await ownedImportDraft(c, id);
	return c.json(
		{
			draft: publicImportDraft(
				required(draft, 'Import draft could not be loaded'),
			),
		},
		201,
	);
});

app.get('/api/v1/setup-imports/drafts', async (c) => {
	const drafts = await db(c.env)
		.select()
		.from(setupImportDraft)
		.where(eq(setupImportDraft.ownerId, c.get('userId')))
		.orderBy(desc(setupImportDraft.updatedAt));
	return c.json({ drafts: drafts.map(publicImportDraft) });
});

app.get('/api/v1/setup-imports/drafts/:draftId', async (c) => {
	const draft = await ownedImportDraft(c, c.req.param('draftId'));
	if (!draft) return c.json({ error: 'Import draft not found' }, 404);
	return c.json({ draft: publicImportDraft(draft) });
});

app.patch('/api/v1/setup-imports/drafts/:draftId', async (c) => {
	const draft = await ownedImportDraft(c, c.req.param('draftId'));
	if (!draft) return c.json({ error: 'Import draft not found' }, 404);
	if (draft.status !== 'draft')
		return c.json({ error: 'Only an open import draft can be edited' }, 409);
	const parsed = setupImportDraftUpdateInput.safeParse(await c.req.json());
	if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
	if (parsed.data.carId && !(await ownedCar(c, parsed.data.carId)))
		return c.json({ error: 'Car not found' }, 404);
	const value = parsed.data;
	await db(c.env)
		.update(setupImportDraft)
		.set({
			carId: value.carId === undefined ? undefined : value.carId,
			knownValues: jsonText(value.knownValues),
			uncertainValues: jsonText(value.uncertainValues),
			rawValues: jsonText(value.rawValues),
			unmappedValues: jsonText(value.unmappedValues),
			sourceMetadata: jsonText(value.sourceMetadata),
			updatedAt: new Date().toISOString(),
		})
		.where(eq(setupImportDraft.id, draft.id));
	const updated = await ownedImportDraft(c, draft.id);
	return c.json({
		draft: publicImportDraft(
			required(updated, 'Import draft could not be loaded'),
		),
	});
});

app.post('/api/v1/setup-imports/drafts/:draftId/cancel', async (c) => {
	const draft = await ownedImportDraft(c, c.req.param('draftId'));
	if (!draft) return c.json({ error: 'Import draft not found' }, 404);
	if (draft.status !== 'draft' && draft.status !== 'error')
		return c.json({ error: 'Import draft is already closed' }, 409);
	await db(c.env)
		.update(setupImportDraft)
		.set({ status: 'cancelled', updatedAt: new Date().toISOString() })
		.where(eq(setupImportDraft.id, draft.id));
	return c.json({ ok: true });
});

app.post('/api/v1/setup-imports/drafts/:draftId/accept', async (c) => {
	const draft = await ownedImportDraft(c, c.req.param('draftId'));
	if (!draft) return c.json({ error: 'Import draft not found' }, 404);
	if (draft.status !== 'draft')
		return c.json({ error: 'Only an open import draft can be accepted' }, 409);
	const parsed = setupImportAcceptInput.safeParse(await c.req.json());
	if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
	const parentCar = await ownedCar(c, parsed.data.carId);
	if (!parentCar) return c.json({ error: 'Car not found' }, 404);
	if (!canWriteSetup(parentCar))
		return c.json(
			{ error: 'Car is archived; restore it before accepting imports' },
			409,
		);
	const sourceSetup = await ownedImportedSetup(c, draft.sourceKey);
	if (sourceSetup)
		return c.json(
			{
				error: 'Source has already been imported',
				existingSetupId: sourceSetup.id,
			},
			409,
		);
	const setupId = crypto.randomUUID();
	const now = new Date().toISOString();
	const value = draftSetupInput(draft, parsed.data.name);
	const database = db(c.env);
	await database.batch([
		database
			.insert(setup)
			.values(setupInsertValues(setupId, parsed.data.carId, value, now)),
		database
			.update(setupImportDraft)
			.set({
				status: 'accepted',
				acceptedSetupId: setupId,
				carId: parsed.data.carId,
				updatedAt: now,
			})
			.where(eq(setupImportDraft.id, draft.id)),
		...(shouldSelectCurrentSetup(parsed.data.makeCurrent)
			? [
					database
						.update(car)
						.set({ currentSetupId: setupId })
						.where(eq(car.id, parsed.data.carId)),
				]
			: []),
	]);
	const created = await database
		.select()
		.from(setup)
		.where(eq(setup.id, setupId))
		.get();
	return c.json(
		{
			setup: publicSetup(
				required(created, 'Imported setup could not be loaded'),
			),
		},
		201,
	);
});

app.get('/api/v1/cars/:carId/photos', async (c) => {
	const { carId } = c.req.param();
	if (!(await ownedCar(c, carId)))
		return c.json({ error: 'Car not found' }, 404);
	const photos = await db(c.env)
		.select()
		.from(photo)
		.where(eq(photo.carId, carId));
	return c.json({ photos: normalizePhotoOrder(photos).map(publicPhoto) });
});

app.patch('/api/v1/cars/:carId/photos/reorder', async (c) => {
	const { carId } = c.req.param();
	const parentCar = await ownedCar(c, carId);
	if (!parentCar) return c.json({ error: 'Car not found' }, 404);
	if (!canWrite(parentCar))
		return c.json(
			{ error: 'Car is archived; restore it before reordering photos' },
			409,
		);
	const parsed = photoReorderInput.safeParse(await c.req.json());
	if (!parsed.success)
		return c.json({ error: 'photoIds must be an array of photo IDs' }, 400);
	const database = db(c.env);
	const existing = await database
		.select()
		.from(photo)
		.where(eq(photo.carId, carId));
	if (!isCompletePhotoOrder(existing, parsed.data.photoIds))
		return c.json(
			{ error: 'photoIds must contain every photo exactly once' },
			400,
		);
	if (existing.length > 0) {
		const statements = parsed.data.photoIds.map((photoId, sortOrder) =>
			database
				.update(photo)
				.set({ sortOrder })
				.where(and(eq(photo.id, photoId), eq(photo.carId, carId))),
		);
		await database.batch(
			statements as unknown as Parameters<typeof database.batch>[0],
		);
	}
	const reordered = await database
		.select()
		.from(photo)
		.where(eq(photo.carId, carId));
	return c.json({ photos: normalizePhotoOrder(reordered).map(publicPhoto) });
});

app.post('/api/v1/cars/:carId/photos', async (c) => {
	const { carId } = c.req.param();
	const parentCar = await ownedCar(c, carId);
	if (!parentCar) return c.json({ error: 'Car not found' }, 404);
	if (!canWrite(parentCar))
		return c.json(
			{ error: 'Car is archived; restore it before adding photos' },
			409,
		);
	const parsed = await parsePhotoForm(c);
	if ('error' in parsed)
		return c.json({ error: parsed.error, maxBytes: PHOTO_MAX_BYTES }, 400);
	const database = db(c.env);
	const existing = await database
		.select()
		.from(photo)
		.where(eq(photo.carId, carId));
	const id = crypto.randomUUID();
	const objectKey = photoObjectKey(carId, id);
	const requestedPrimary = parsed.primary === 'true' || parsed.primary === '1';
	const sortOrderValue =
		typeof parsed.sortOrder === 'string'
			? Number(parsed.sortOrder)
			: existing.length;
	const sortOrder =
		Number.isInteger(sortOrderValue) &&
		sortOrderValue >= 0 &&
		sortOrderValue <= 10000
			? sortOrderValue
			: undefined;
	if (sortOrder === undefined)
		return c.json({ error: 'sortOrder must be a non-negative integer' }, 400);
	const isPrimary =
		requestedPrimary || !existing.some((value) => value.isPrimary);
	await c.env.PHOTOS.put(objectKey, parsed.file.stream(), {
		httpMetadata: { contentType: parsed.contentType },
	});
	try {
		const insert = database.insert(photo).values({
			id,
			carId,
			objectKey,
			contentType: parsed.contentType,
			fileName: parsed.fileName,
			byteSize: parsed.file.size,
			sortOrder,
			isPrimary,
			createdAt: new Date().toISOString(),
		});
		if (isPrimary) {
			await database.batch([
				database
					.update(photo)
					.set({ isPrimary: false })
					.where(eq(photo.carId, carId)),
				insert,
			]);
		} else {
			await database.batch([insert]);
		}
	} catch (_error) {
		try {
			await c.env.PHOTOS.delete(objectKey);
		} catch (compensationError) {
			console.error('photo upload R2 compensation failed', {
				objectKey,
				compensationError,
			});
		}
		throw _error;
	}
	const created = await database
		.select()
		.from(photo)
		.where(eq(photo.id, id))
		.get();
	return c.json(
		{
			photo: publicPhoto(
				required(created, 'Created photo could not be loaded'),
			),
		},
		201,
	);
});

app.patch('/api/v1/photos/:photoId', async (c) => {
	const existing = await ownedPhoto(c, c.req.param('photoId'));
	if (!existing) return c.json({ error: 'Photo not found' }, 404);
	const parentCar = await ownedCar(c, existing.carId);
	if (!parentCar) return c.json({ error: 'Photo not found' }, 404);
	if (!canWrite(parentCar))
		return c.json(
			{ error: 'Car is archived; restore it before editing photos' },
			409,
		);
	const parsed = photoUpdateInput.safeParse(await c.req.json());
	if (!parsed.success)
		return c.json(
			{ error: 'Invalid photo update', details: parsed.error.flatten() },
			400,
		);
	const database = db(c.env);
	const updates =
		parsed.data.sortOrder === undefined
			? {}
			: { sortOrder: parsed.data.sortOrder };
	if (parsed.data.isPrimary === true) {
		await database.batch([
			database
				.update(photo)
				.set({ isPrimary: false })
				.where(eq(photo.carId, existing.carId)),
			database
				.update(photo)
				.set({ ...updates, isPrimary: true })
				.where(eq(photo.id, existing.id)),
		]);
	} else if (parsed.data.isPrimary === false && existing.isPrimary) {
		const others = normalizePhotoOrder(
			(
				await database
					.select()
					.from(photo)
					.where(eq(photo.carId, existing.carId))
			).filter((value) => value.id !== existing.id),
		);
		const replacement = others[0];
		await database.batch([
			database
				.update(photo)
				.set({ ...updates, isPrimary: false })
				.where(eq(photo.id, existing.id)),
			...(replacement
				? [
						database
							.update(photo)
							.set({ isPrimary: true })
							.where(eq(photo.id, replacement.id)),
					]
				: []),
		]);
	} else {
		await database.update(photo).set(updates).where(eq(photo.id, existing.id));
	}
	const updated = await database
		.select()
		.from(photo)
		.where(eq(photo.id, existing.id))
		.get();
	return c.json({
		photo: publicPhoto(required(updated, 'Updated photo could not be loaded')),
	});
});

const replacePhoto = async (c: AppContext) => {
	const existing = await ownedPhoto(c, c.req.param('photoId'));
	if (!existing) return c.json({ error: 'Photo not found' }, 404);
	const parentCar = await ownedCar(c, existing.carId);
	if (!parentCar) return c.json({ error: 'Photo not found' }, 404);
	if (!canWrite(parentCar))
		return c.json(
			{ error: 'Car is archived; restore it before replacing photos' },
			409,
		);
	const parsed = await parsePhotoForm(c);
	if ('error' in parsed)
		return c.json({ error: parsed.error, maxBytes: PHOTO_MAX_BYTES }, 400);
	const previous = await c.env.PHOTOS.get(existing.objectKey);
	const previousBytes = previous ? await previous.arrayBuffer() : undefined;
	await c.env.PHOTOS.put(existing.objectKey, parsed.file.stream(), {
		httpMetadata: { contentType: parsed.contentType },
	});
	let updated: typeof existing;
	try {
		updated = await db(c.env)
			.update(photo)
			.set({
				contentType: parsed.contentType,
				fileName: parsed.fileName,
				byteSize: parsed.file.size,
			})
			.where(eq(photo.id, existing.id))
			.returning()
			.get();
	} catch (error) {
		try {
			if (previousBytes) {
				await c.env.PHOTOS.put(existing.objectKey, previousBytes, {
					httpMetadata: previous?.httpMetadata,
				});
			} else {
				await c.env.PHOTOS.delete(existing.objectKey);
			}
		} catch (compensationError) {
			console.error('photo replace R2 compensation failed', {
				objectKey: existing.objectKey,
				compensationError,
			});
		}
		throw error;
	}
	return c.json({
		photo: publicPhoto(required(updated, 'Replaced photo could not be loaded')),
	});
};

app.post('/api/v1/photos/:photoId/replace', replacePhoto);

app.put('/api/v1/photos/:photoId', async (c) => {
	return replacePhoto(c);
});

const deletePhoto = async (c: AppContext) => {
	const existing = await ownedPhoto(c, c.req.param('photoId'));
	if (!existing) return c.json({ error: 'Photo not found' }, 404);
	const parentCar = await ownedCar(c, existing.carId);
	if (!parentCar) return c.json({ error: 'Photo not found' }, 404);
	if (!canWrite(parentCar))
		return c.json(
			{ error: 'Car is archived; restore it before deleting photos' },
			409,
		);
	const database = db(c.env);
	const others = normalizePhotoOrder(
		(
			await database.select().from(photo).where(eq(photo.carId, existing.carId))
		).filter((value) => value.id !== existing.id),
	);
	const replacement = existing.isPrimary
		? others.find(
				(value) =>
					value.id === primaryAfterDelete([existing, ...others], existing.id),
			)
		: undefined;
	const previous = await c.env.PHOTOS.get(existing.objectKey);
	const previousBytes = previous ? await previous.arrayBuffer() : undefined;
	try {
		await c.env.PHOTOS.delete(existing.objectKey);
	} catch (_error) {
		return c.json(
			{
				error: 'Photo storage is temporarily unavailable; nothing was deleted',
			},
			503,
		);
	}
	try {
		await database.batch([
			database.delete(photo).where(eq(photo.id, existing.id)),
			...(replacement
				? [
						database
							.update(photo)
							.set({ isPrimary: true })
							.where(eq(photo.id, replacement.id)),
					]
				: []),
		]);
	} catch (error) {
		try {
			if (previousBytes)
				await c.env.PHOTOS.put(existing.objectKey, previousBytes, {
					httpMetadata: previous?.httpMetadata,
				});
		} catch (compensationError) {
			console.error('photo delete R2 compensation failed', {
				objectKey: existing.objectKey,
				compensationError,
			});
		}
		throw error;
	}
	return c.json({ deleted: true, primaryPhotoId: replacement?.id ?? null });
};

app.delete('/api/v1/photos/:photoId', deletePhoto);

app.get('/api/v1/photos/:photoId', async (c) => {
	const metadata = await ownedPhoto(c, c.req.param('photoId'));
	if (!metadata) return c.json({ error: 'Photo not found' }, 404);
	const object = await c.env.PHOTOS.get(metadata.objectKey);
	if (!object) return c.json({ error: 'Photo not found' }, 404);
	return new Response(object.body, {
		headers: {
			'Content-Type': metadata.contentType,
			'Content-Length': String(metadata.byteSize),
			'Cache-Control': 'private, max-age=300',
			'Content-Disposition': `inline; filename="${metadata.fileName.replace(/["\\\r\n]/g, '_')}"`,
			'X-Content-Type-Options': 'nosniff',
		},
	});
});

// Keep the car-scoped shape used by the car API alongside the photo-id routes.
const delegateCarPhotoRoute = async (c: AppContext, suffix = '') => {
	const metadata = await ownedPhoto(c, c.req.param('photoId'));
	if (!metadata || metadata.carId !== c.req.param('carId'))
		return c.json({ error: 'Photo not found' }, 404);
	const target = new URL(`/api/v1/photos/${metadata.id}${suffix}`, c.req.url);
	return app.fetch(new Request(target, c.req.raw), c.env, c.executionCtx);
};

app.patch('/api/v1/cars/:carId/photos/:photoId', (c) =>
	delegateCarPhotoRoute(c),
);
app.post('/api/v1/cars/:carId/photos/:photoId/replace', (c) =>
	delegateCarPhotoRoute(c, '/replace'),
);
app.delete('/api/v1/cars/:carId/photos/:photoId', (c) =>
	delegateCarPhotoRoute(c),
);

app.post('/api/v1/cars/:carId/components', async (c) => {
	const parsed = componentInput.safeParse(await c.req.json());
	if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
	const { carId } = c.req.param();
	const parentCar = await ownedCar(c, carId);
	if (!parentCar) return c.json({ error: 'Car not found' }, 404);
	if (!canWrite(parentCar))
		return c.json(
			{ error: 'Car is archived; restore it before recording new work' },
			409,
		);
	const slot = parseComponentSlot(parsed.data.slot, parsed.data.slotType);
	if (!slot)
		return c.json({ error: 'slotType does not match the selected slot' }, 400);
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const value = parsed.data;
	const database = db(c.env);
	const previous = await database
		.select()
		.from(component)
		.where(
			and(
				eq(component.carId, carId),
				eq(component.slot, slot.slot),
				isNull(component.removedAt),
			),
		)
		.get();
	const sessionCount = await planSessionCount(c, carId);
	await database.batch([
		database
			.update(component)
			.set({ removedAt: now })
			.where(
				and(
					eq(component.carId, carId),
					eq(component.slot, slot.slot),
					isNull(component.removedAt),
				),
			),
		...(previous
			? [
					database
						.update(maintenancePlan)
						.set({
							componentId: id,
							baselineAt: value.installedAt ?? now,
							baselineSessionCount: sessionCount,
							status: 'active',
							pauseReason: null,
							pausedAt: null,
						})
						.where(
							and(
								eq(maintenancePlan.componentId, previous.id),
								or(
									eq(maintenancePlan.status, 'active'),
									eq(maintenancePlan.pauseReason, 'component'),
								),
							),
						),
				]
			: []),
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
	return c.json(
		{
			component: publicComponent(
				required(created, 'Created component could not be loaded'),
			),
		},
		201,
	);
});

app.get('/api/v1/component-slots', (c) =>
	c.json({ standard: STANDARD_COMPONENT_SLOTS }),
);

app.get('/api/v1/cars/:carId/components', async (c) => {
	const { carId } = c.req.param();
	if (!(await ownedCar(c, carId)))
		return c.json({ error: 'Car not found' }, 404);
	const history = c.req.query('history') === 'true';
	const where = history
		? eq(component.carId, carId)
		: and(eq(component.carId, carId), isNull(component.removedAt));
	const components = await db(c.env)
		.select()
		.from(component)
		.where(where)
		.orderBy(desc(component.installedAt));
	return c.json({ components: components.map(publicComponent), history });
});

app.get('/api/v1/cars/:carId/components/:componentId', async (c) => {
	const { carId, componentId } = c.req.param();
	if (!(await ownedCar(c, carId)))
		return c.json({ error: 'Car not found' }, 404);
	const value = await ownedComponent(c, carId, componentId);
	if (!value) return c.json({ error: 'Component not found' }, 404);
	return c.json({ component: publicComponent(value) });
});

app.patch('/api/v1/cars/:carId/components/:componentId', async (c) => {
	const parsed = componentUpdateInput.safeParse(await c.req.json());
	if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
	const { carId, componentId } = c.req.param();
	const parentCar = await ownedCar(c, carId);
	if (!parentCar) return c.json({ error: 'Car not found' }, 404);
	if (!canWrite(parentCar))
		return c.json(
			{ error: 'Car is archived; restore it before recording new work' },
			409,
		);
	const existing = await ownedComponent(c, carId, componentId);
	if (!existing) return c.json({ error: 'Component not found' }, 404);
	if (!canEditComponent(existing.removedAt))
		return c.json(
			{ error: 'Historical component installations are immutable' },
			409,
		);
	await db(c.env)
		.update(component)
		.set({
			name: parsed.data.name,
			manufacturer: parsed.data.manufacturer,
			model: parsed.data.model,
			serialNumber: parsed.data.serialNumber,
			notes: parsed.data.notes,
			installedAt: parsed.data.installedAt,
		})
		.where(and(eq(component.id, componentId), eq(component.carId, carId)));
	const updated = await ownedComponent(c, carId, componentId);
	return c.json({
		component: publicComponent(
			required(updated, 'Updated component could not be loaded'),
		),
	});
});

app.post('/api/v1/cars/:carId/components/:componentId/replace', async (c) => {
	const parsed = componentInput.safeParse(await c.req.json());
	if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
	const { carId, componentId } = c.req.param();
	const parentCar = await ownedCar(c, carId);
	if (!parentCar) return c.json({ error: 'Car not found' }, 404);
	if (!canWrite(parentCar))
		return c.json(
			{ error: 'Car is archived; restore it before recording new work' },
			409,
		);
	const previous = await ownedComponent(c, carId, componentId);
	if (!previous) return c.json({ error: 'Component not found' }, 404);
	if (previous.removedAt !== null)
		return c.json({ error: 'Component is no longer current' }, 409);
	const slot = parseComponentSlot(parsed.data.slot, parsed.data.slotType);
	if (!slot)
		return c.json({ error: 'slotType does not match the selected slot' }, 400);
	const previousSlot =
		previous.slotType === 'standard'
			? normalizeComponentSlot(previous.slot)
			: previous.slot.trim();
	if (slot.slot !== previousSlot)
		return c.json(
			{ error: 'Replacement must use the existing component slot' },
			400,
		);
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const database = db(c.env);
	const sessionCount = await planSessionCount(c, carId);
	await database.batch([
		database
			.update(component)
			.set({ removedAt: now })
			.where(
				and(
					eq(component.id, previous.id),
					eq(component.carId, carId),
					isNull(component.removedAt),
				),
			),
		database
			.update(maintenancePlan)
			.set({
				componentId: id,
				baselineAt: parsed.data.installedAt ?? now,
				baselineSessionCount: sessionCount,
				status: 'active',
				pauseReason: null,
				pausedAt: null,
			})
			.where(
				and(
					eq(maintenancePlan.componentId, previous.id),
					or(
						eq(maintenancePlan.status, 'active'),
						eq(maintenancePlan.pauseReason, 'component'),
					),
				),
			),
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
	return c.json(
		{
			previous: publicComponent({ ...previous, removedAt: now }),
			component: publicComponent(
				required(replacement, 'Replacement component could not be loaded'),
			),
		},
		201,
	);
});

app.post('/api/v1/cars/:carId/components/:componentId/remove', async (c) => {
	const { carId, componentId } = c.req.param();
	const parentCar = await ownedCar(c, carId);
	if (!parentCar) return c.json({ error: 'Car not found' }, 404);
	if (!canWrite(parentCar))
		return c.json(
			{ error: 'Car is archived; restore it before recording new work' },
			409,
		);
	const existing = await ownedComponent(c, carId, componentId);
	if (!existing) return c.json({ error: 'Component not found' }, 404);
	if (existing.removedAt !== null)
		return c.json({ error: 'Component is no longer current' }, 409);
	const removedAt = new Date().toISOString();
	const database = db(c.env);
	await database.batch([
		database
			.update(component)
			.set({ removedAt })
			.where(
				and(
					eq(component.id, componentId),
					eq(component.carId, carId),
					isNull(component.removedAt),
				),
			),
		database
			.update(maintenancePlan)
			.set({ status: 'paused', pauseReason: 'component', pausedAt: removedAt })
			.where(
				and(
					eq(maintenancePlan.componentId, componentId),
					eq(maintenancePlan.status, 'active'),
				),
			),
	]);
	return c.json({ component: publicComponent({ ...existing, removedAt }) });
});

app.get('/api/v1/preferences/timezone', async (c) =>
	c.json({ timezone: await ownerTimezone(c) }),
);

app.patch('/api/v1/preferences/timezone', async (c) => {
	const parsed = timezoneInput.safeParse(await c.req.json());
	if (
		!parsed.success ||
		!isIanaTimezone(parsed.success ? parsed.data.timezone : '')
	) {
		return c.json(
			{
				error: parsed.success
					? 'timezone must be a valid IANA timezone'
					: parsed.error.flatten(),
			},
			400,
		);
	}
	await db(c.env)
		.update(owner)
		.set({ timezone: parsed.data.timezone })
		.where(eq(owner.id, c.get('userId')));
	return c.json({ timezone: parsed.data.timezone });
});

app.get('/api/v1/cars/:carId/drives/count', async (c) => {
	if (!(await ownedCar(c, c.req.param('carId'))))
		return c.json({ error: 'Car not found' }, 404);
	return c.json({ count: await driveSessionCount(c, c.req.param('carId')) });
});

app.get('/api/v1/cars/:carId/drives', async (c) => {
	const { carId } = c.req.param();
	if (!(await ownedCar(c, carId)))
		return c.json({ error: 'Car not found' }, 404);
	const history = c.req.query('history') === 'true';
	const where = history
		? eq(driveSession.carId, carId)
		: and(eq(driveSession.carId, carId), isNull(driveSession.deletedAt));
	const timezone = await ownerTimezone(c);
	const sessions = await db(c.env)
		.select()
		.from(driveSession)
		.where(where)
		.orderBy(desc(driveSession.startedAt));
	return c.json({
		driveSessions: sessions.map((value) => publicDriveSession(value, timezone)),
		count: sessions.filter((value) => value.deletedAt === null).length,
		history,
		timezone,
	});
});

app.post('/api/v1/cars/:carId/drives', async (c) => {
	const carId = c.req.param('carId');
	const parsed = driveSessionInput.safeParse(await c.req.json());
	if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
	const parentCar = await ownedCar(c, carId);
	if (!parentCar) return c.json({ error: 'Car not found' }, 404);
	if (!canWrite(parentCar))
		return c.json(
			{ error: 'Car is archived; restore it before recording new work' },
			409,
		);
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
	const created = await database
		.select()
		.from(driveSession)
		.where(and(eq(driveSession.id, id), eq(driveSession.carId, carId)))
		.get();
	return c.json(
		{
			driveSession: publicDriveSession(
				required(created, 'Created drive session could not be loaded'),
				await ownerTimezone(c),
			),
		},
		201,
	);
});

app.patch('/api/v1/cars/:carId/drives/:driveId', async (c) => {
	const { carId, driveId } = c.req.param();
	const parentCar = await ownedCar(c, carId);
	if (!parentCar) return c.json({ error: 'Car not found' }, 404);
	if (!canWrite(parentCar))
		return c.json(
			{ error: 'Car is archived; restore it before editing drive history' },
			409,
		);
	const existing = await db(c.env)
		.select()
		.from(driveSession)
		.where(and(eq(driveSession.id, driveId), eq(driveSession.carId, carId)))
		.get();
	if (!existing) return c.json({ error: 'Drive session not found' }, 404);
	if (!canEditDriveSession(existing))
		return c.json({ error: 'Deleted drive sessions are immutable' }, 409);
	const parsed = driveSessionUpdateInput.safeParse(await c.req.json());
	if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
	await db(c.env)
		.update(driveSession)
		.set({
			startedAt: parsed.data.startedAt
				? new Date(parsed.data.startedAt).toISOString()
				: undefined,
			durationMinutes: parsed.data.durationMinutes,
			conditions: parsed.data.conditions,
			notes: parsed.data.notes,
		})
		.where(
			and(
				eq(driveSession.id, driveId),
				eq(driveSession.carId, carId),
				isNull(driveSession.deletedAt),
			),
		);
	const updated = await db(c.env)
		.select()
		.from(driveSession)
		.where(
			and(
				eq(driveSession.id, driveId),
				eq(driveSession.carId, carId),
				isNull(driveSession.deletedAt),
			),
		)
		.get();
	if (!updated)
		return c.json({ error: 'Drive session is no longer editable' }, 409);
	return c.json({
		driveSession: publicDriveSession(
			required(updated, 'Updated drive session could not be loaded'),
			await ownerTimezone(c),
		),
	});
});

app.delete('/api/v1/cars/:carId/drives/:driveId', async (c) => {
	const { carId, driveId } = c.req.param();
	const parentCar = await ownedCar(c, carId);
	if (!parentCar) return c.json({ error: 'Car not found' }, 404);
	if (!canWrite(parentCar))
		return c.json(
			{ error: 'Car is archived; restore it before deleting drive history' },
			409,
		);
	const existing = await db(c.env)
		.select()
		.from(driveSession)
		.where(and(eq(driveSession.id, driveId), eq(driveSession.carId, carId)))
		.get();
	if (!existing) return c.json({ error: 'Drive session not found' }, 404);
	if (!canDeleteDriveSession(existing))
		return c.json({ error: 'Drive session is already deleted' }, 409);
	const deletedAt = new Date().toISOString();
	await db(c.env)
		.update(driveSession)
		.set({ deletedAt })
		.where(
			and(
				eq(driveSession.id, driveId),
				eq(driveSession.carId, carId),
				isNull(driveSession.deletedAt),
			),
		);
	const deleted = { ...existing, deletedAt };
	return c.json({
		driveSession: publicDriveSession(deleted, await ownerTimezone(c)),
	});
});

app.post('/api/v1/cars/:carId/service-records', async (c) => {
	const parsed = serviceRecordInput.safeParse({
		...(await c.req.json()),
		carId: c.req.param('carId'),
	});
	if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
	const parentCar = await ownedCar(c, parsed.data.carId);
	if (!parentCar) return c.json({ error: 'Car not found' }, 404);
	if (!canWrite(parentCar))
		return c.json(
			{ error: 'Car is archived; restore it before recording new work' },
			409,
		);
	if (
		parsed.data.componentId &&
		!(await ownedComponent(c, parsed.data.carId, parsed.data.componentId))
	)
		return c.json({ error: 'Component not found' }, 404);
	const id = crypto.randomUUID();
	const value = parsed.data;
	const baselineAt = value.baselineAt ?? value.performedAt;
	const database = db(c.env);
	await database.insert(serviceRecord).values({
		id,
		carId: value.carId,
		componentId: value.componentId ?? null,
		performedAt: value.performedAt,
		description: value.description ?? value.notes ?? '',
		notes: value.notes ?? null,
		cost: value.cost ?? null,
		currency: value.currency ?? null,
		baselineAt,
		baselineSessionCount: null,
		previousBaselineAt: null,
		previousBaselineSessionCount: null,
		deletedAt: null,
	});
	const created = await database
		.select()
		.from(serviceRecord)
		.where(eq(serviceRecord.id, id))
		.get();
	return c.json({ serviceRecord: created }, 201);
});

app.post('/api/v1/maintenance-plans', async (c) => {
	const parsed = maintenancePlanInput.safeParse(await c.req.json());
	if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
	const parentCar = await ownedCar(c, parsed.data.carId);
	if (!parentCar) return c.json({ error: 'Car not found' }, 404);
	if (!canWrite(parentCar))
		return c.json(
			{ error: 'Car is archived; restore it before recording new work' },
			409,
		);
	const id = crypto.randomUUID();
	const now = new Date().toISOString();
	const value = parsed.data;
	const intervalUnit =
		value.intervalUnit ?? (value.intervalDays !== undefined ? 'days' : 'none');
	const intervalValue = value.intervalValue ?? value.intervalDays ?? 1;
	if (value.componentId !== undefined) {
		if (!value.componentId)
			return c.json({ error: 'componentId must not be empty' }, 400);
		const target = await ownedComponent(c, value.carId, value.componentId);
		if (!target || target.removedAt !== null)
			return c.json(
				{ error: 'Maintenance plans require a current component' },
				409,
			);
	}
	const database = db(c.env);
	const baselineAt = value.baselineAt
		? new Date(value.baselineAt).toISOString()
		: now;
	const baselineSessionCount =
		value.baselineSessionCount ?? (await planSessionCount(c, value.carId));
	await database.insert(maintenancePlan).values({
		id,
		carId: value.carId,
		componentId: value.componentId,
		name: value.name,
		intervalDays: value.intervalDays ?? null,
		intervalSessions: value.intervalSessions ?? null,
		intervalUnit,
		intervalValue,
		baselineAt,
		baselineSessionCount,
		status: 'active',
		pauseReason: null,
		pausedAt: null,
	});
	const created = await database
		.select()
		.from(maintenancePlan)
		.where(eq(maintenancePlan.id, id))
		.get();
	return c.json(
		{
			maintenancePlan: planDue(
				required(created, 'Created maintenance plan could not be loaded'),
				baselineSessionCount,
				await ownerTimezone(c),
			),
		},
		201,
	);
});

app.get('/api/v1/maintenance-plans', async (c) => {
	const plans = await db(c.env)
		.select()
		.from(maintenancePlan)
		.innerJoin(car, eq(maintenancePlan.carId, car.id))
		.where(eq(car.ownerId, c.get('userId')));
	const timezone = await ownerTimezone(c);
	const values = plans.map(({ maintenance_plan: value }) => value);
	const counts = await sessionCountsForCars(c, [
		...new Set(values.map((value) => value.carId)),
	]);
	const maintenancePlans = values.map((value) =>
		planDue(value, counts.get(value.carId) ?? 0, timezone),
	);
	const records = await db(c.env)
		.select()
		.from(serviceRecord)
		.innerJoin(car, eq(serviceRecord.carId, car.id))
		.where(
			and(eq(car.ownerId, c.get('userId')), isNull(serviceRecord.deletedAt)),
		)
		.orderBy(desc(serviceRecord.performedAt))
		.limit(20);
	const activity = records.map(({ service_record: value }) => ({
		id: value.id,
		planId: value.planId,
		action: 'completed',
		occurredAt: value.performedAt,
		note: value.description,
	}));
	return c.json({ maintenancePlans, activity });
});

app.get('/api/v1/cars/:carId/maintenance-plans', async (c) => {
	const carId = c.req.param('carId');
	if (!(await ownedCar(c, carId)))
		return c.json({ error: 'Car not found' }, 404);
	const plans = await db(c.env)
		.select()
		.from(maintenancePlan)
		.where(eq(maintenancePlan.carId, carId));
	const timezone = await ownerTimezone(c);
	const count = await planSessionCount(c, carId);
	return c.json({
		maintenancePlans: plans.map((value) => planDue(value, count, timezone)),
	});
});

app.get('/api/v1/cars/:carId/maintenance-cockpit', async (c) => {
	const carId = c.req.param('carId');
	if (!(await ownedCar(c, carId)))
		return c.json({ error: 'Car not found' }, 404);
	const plans = await db(c.env)
		.select()
		.from(maintenancePlan)
		.where(eq(maintenancePlan.carId, carId));
	const timezone = await ownerTimezone(c);
	const count = await planSessionCount(c, carId);
	const enriched = plans.map((value) => planDue(value, count, timezone));
	return c.json({
		upcoming: enriched.filter((value) => value.dueStatus === 'upcoming'),
		due: enriched.filter((value) => value.dueStatus === 'due'),
		overdue: enriched.filter((value) => value.dueStatus === 'overdue'),
		paused: enriched.filter((value) => value.dueStatus === 'paused'),
		archived: enriched.filter((value) => value.dueStatus === 'archived'),
		recentActivity: await db(c.env)
			.select()
			.from(serviceRecord)
			.where(
				and(eq(serviceRecord.carId, carId), isNull(serviceRecord.deletedAt)),
			)
			.orderBy(desc(serviceRecord.performedAt))
			.limit(20),
	});
});

app.get('/api/v1/maintenance-cockpit', async (c) => {
	const cars = await db(c.env)
		.select({ id: car.id })
		.from(car)
		.where(eq(car.ownerId, c.get('userId')));
	const values = await db(c.env)
		.select({ plan: maintenancePlan })
		.from(maintenancePlan)
		.innerJoin(car, eq(maintenancePlan.carId, car.id))
		.where(eq(car.ownerId, c.get('userId')));
	const timezone = await ownerTimezone(c);
	const counts = await sessionCountsForCars(
		c,
		cars.map(({ id }) => id),
	);
	const plans = values.map(({ plan }) =>
		planDue(plan, counts.get(plan.carId) ?? 0, timezone),
	);
	return c.json({
		upcoming: plans.filter((value) => value.dueStatus === 'upcoming'),
		due: plans.filter((value) => value.dueStatus === 'due'),
		overdue: plans.filter((value) => value.dueStatus === 'overdue'),
		paused: plans.filter((value) => value.dueStatus === 'paused'),
		archived: plans.filter((value) => value.dueStatus === 'archived'),
	});
});

app.patch('/api/v1/maintenance-plans/:planId', async (c) => {
	const existing = await carPlan(c, c.req.param('planId'));
	if (!existing) return c.json({ error: 'Maintenance plan not found' }, 404);
	const parsed = maintenancePlanUpdateInput.safeParse(await c.req.json());
	if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
	const intervalDays =
		parsed.data.intervalUnit === 'none'
			? null
			: parsed.data.intervalDays === null
				? null
				: (parsed.data.intervalDays ??
					(parsed.data.intervalUnit === 'days'
						? parsed.data.intervalValue
						: undefined));
	await db(c.env)
		.update(maintenancePlan)
		.set({
			name: parsed.data.name,
			intervalDays,
			intervalUnit:
				parsed.data.intervalUnit ??
				(intervalDays !== undefined ? 'days' : existing.intervalUnit),
			intervalValue:
				parsed.data.intervalValue ??
				(parsed.data.intervalUnit === 'none'
					? 1
					: (intervalDays ?? existing.intervalValue)),
			intervalSessions: parsed.data.intervalSessions,
		})
		.where(eq(maintenancePlan.id, existing.id));
	const updated = required(
		await carPlan(c, existing.id),
		'Updated maintenance plan could not be loaded',
	);
	return c.json({
		maintenancePlan: planDue(
			updated,
			await planSessionCount(c, updated.carId),
			await ownerTimezone(c),
		),
	});
});

const transitionMaintenancePlan = async (c: AppContext) => {
	const existing = await carPlan(c, c.req.param('planId'));
	if (!existing) return c.json({ error: 'Maintenance plan not found' }, 404);
	const action = c.req.path.split('/').pop() ?? '';
	if (action !== 'pause' && action !== 'resume' && action !== 'archive')
		return c.json({ error: 'Unknown maintenance plan action' }, 404);
	if (
		!canTransitionMaintenance(
			existing.status as MaintenanceStatus,
			action === 'pause'
				? 'paused'
				: action === 'resume'
					? 'active'
					: 'archived',
		)
	)
		return c.json({ error: 'Invalid maintenance plan state' }, 409);
	const nextStatus =
		action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'archived';
	try {
		await db(c.env)
			.update(maintenancePlan)
			.set({
				status: nextStatus,
				pauseReason: action === 'pause' ? 'manual' : null,
				pausedAt: action === 'pause' ? new Date().toISOString() : null,
			})
			.where(eq(maintenancePlan.id, existing.id));
		const updated = required(
			await carPlan(c, existing.id),
			'Updated maintenance plan could not be loaded',
		);
		return c.json({
			maintenancePlan: planDue(
				updated,
				await planSessionCount(c, updated.carId),
				await ownerTimezone(c),
			),
		});
	} catch (error) {
		console.error('maintenance plan transition failed', error);
		return c.json({ error: 'Maintenance plan transition failed' }, 500);
	}
};
app.post('/api/v1/maintenance-plans/:planId/pause', transitionMaintenancePlan);
app.post('/api/v1/maintenance-plans/:planId/resume', transitionMaintenancePlan);
app.post(
	'/api/v1/maintenance-plans/:planId/archive',
	transitionMaintenancePlan,
);

app.post('/api/v1/maintenance-plans/:planId/complete', async (c) => {
	const existing = await carPlan(c, c.req.param('planId'));
	if (!existing) return c.json({ error: 'Maintenance plan not found' }, 404);
	const parentCar = await ownedCar(c, existing.carId);
	if (!parentCar) return c.json({ error: 'Car not found' }, 404);
	if (!canWrite(parentCar))
		return c.json(
			{ error: 'Car is archived; restore it before recording new work' },
			409,
		);
	if (existing.status !== 'active')
		return c.json(
			{ error: 'Only active maintenance plans can be completed' },
			409,
		);
	const parsed = maintenanceCompletionInput.safeParse(await c.req.json());
	if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
	const performedAt = parsed.data.performedAt
		? new Date(parsed.data.performedAt).toISOString()
		: new Date().toISOString();
	const description =
		parsed.data.description ??
		parsed.data.notes ??
		'Completed maintenance plan';
	const baselineSessionCount = await planSessionCount(c, existing.carId);
	const id = crypto.randomUUID();
	const database = db(c.env);
	await database.batch([
		database.insert(serviceRecord).values({
			id,
			carId: existing.carId,
			componentId: existing.componentId,
			planId: existing.id,
			performedAt,
			description,
			notes: parsed.data.notes ?? undefined,
			cost: parsed.data.cost ?? null,
			currency: parsed.data.currency ?? null,
			baselineAt: performedAt,
			baselineSessionCount,
			previousBaselineAt: existing.baselineAt,
			previousBaselineSessionCount: existing.baselineSessionCount,
			deletedAt: null,
		}),
		database
			.update(maintenancePlan)
			.set({ baselineAt: performedAt, baselineSessionCount })
			.where(eq(maintenancePlan.id, existing.id)),
	]);
	const updatedPlan = required(
		await carPlan(c, existing.id),
		'Updated maintenance plan could not be loaded',
	);
	return c.json(
		{
			serviceRecord: {
				id,
				planId: existing.id,
				performedAt,
				description,
				baselineAt: performedAt,
				baselineSessionCount,
			},
			maintenancePlan: planDue(
				updatedPlan,
				baselineSessionCount,
				await ownerTimezone(c),
			),
		},
		201,
	);
});

app.get('/api/v1/cars/:carId/service-records', async (c) => {
	const carId = c.req.param('carId');
	if (!(await ownedCar(c, carId)))
		return c.json({ error: 'Car not found' }, 404);
	const history = c.req.query('history') === 'true';
	const records = await db(c.env)
		.select()
		.from(serviceRecord)
		.where(
			history
				? eq(serviceRecord.carId, carId)
				: and(eq(serviceRecord.carId, carId), isNull(serviceRecord.deletedAt)),
		)
		.orderBy(desc(serviceRecord.performedAt));
	return c.json({ serviceRecords: records });
});

app.patch('/api/v1/service-records/:recordId', async (c) => {
	const record = await db(c.env)
		.select()
		.from(serviceRecord)
		.where(eq(serviceRecord.id, c.req.param('recordId')))
		.get();
	const parentCar = record ? await ownedCar(c, record.carId) : undefined;
	if (!record || !parentCar)
		return c.json({ error: 'Service record not found' }, 404);
	if (!canWrite(parentCar))
		return c.json(
			{ error: 'Car is archived; restore it before editing service history' },
			409,
		);
	if (!canEditServiceRecord(record))
		return c.json({ error: 'Deleted service records are immutable' }, 409);
	const parsed = serviceRecordUpdateInput.safeParse(await c.req.json());
	if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
	const nextPerformedAt = parsed.data.performedAt
		? new Date(parsed.data.performedAt).toISOString()
		: record.performedAt;
	const nextDescription = parsed.data.description ?? record.description;
	const nextNotes =
		parsed.data.notes === undefined ? record.notes : parsed.data.notes;
	const nextCost =
		parsed.data.cost === undefined ? record.cost : parsed.data.cost;
	const nextCurrency =
		parsed.data.currency === undefined ? record.currency : parsed.data.currency;
	if ((nextCost === null) !== (nextCurrency === null))
		return c.json(
			{ error: 'Cost and currency must be supplied together' },
			400,
		);
	const database = db(c.env);
	const plan = record.planId
		? await database
				.select()
				.from(maintenancePlan)
				.where(eq(maintenancePlan.id, record.planId))
				.get()
		: undefined;
	const baselineIsCurrent = shouldRestoreBaseline(record, plan);
	const nextBaselineAt =
		baselineIsCurrent && parsed.data.performedAt
			? nextPerformedAt
			: record.baselineAt;
	await database.batch([
		database
			.update(serviceRecord)
			.set({
				performedAt: nextPerformedAt,
				description: nextDescription,
				notes: nextNotes,
				cost: nextCost,
				currency: nextCurrency,
				baselineAt: nextBaselineAt,
			})
			.where(
				and(eq(serviceRecord.id, record.id), isNull(serviceRecord.deletedAt)),
			),
		...(baselineIsCurrent && parsed.data.performedAt && plan
			? [
					database
						.update(maintenancePlan)
						.set({ baselineAt: nextPerformedAt })
						.where(
							and(
								eq(maintenancePlan.id, plan.id),
								eq(maintenancePlan.baselineAt, record.baselineAt),
							),
						),
				]
			: []),
	]);
	return c.json({
		serviceRecord: await database
			.select()
			.from(serviceRecord)
			.where(eq(serviceRecord.id, record.id))
			.get(),
	});
});

app.delete('/api/v1/service-records/:recordId', async (c) => {
	const record = await db(c.env)
		.select()
		.from(serviceRecord)
		.where(eq(serviceRecord.id, c.req.param('recordId')))
		.get();
	const parentCar = record ? await ownedCar(c, record.carId) : undefined;
	if (!record || !parentCar)
		return c.json({ error: 'Service record not found' }, 404);
	if (!canWrite(parentCar))
		return c.json(
			{ error: 'Car is archived; restore it before deleting service history' },
			409,
		);
	if (!canDeleteServiceRecord(record))
		return c.json({ error: 'Service record is already deleted' }, 409);
	const database = db(c.env);
	const plan = record.planId
		? await db(c.env)
				.select()
				.from(maintenancePlan)
				.where(eq(maintenancePlan.id, record.planId))
				.get()
		: undefined;
	const deletedAt = new Date().toISOString();
	await database.batch([
		database
			.update(serviceRecord)
			.set({ deletedAt })
			.where(
				and(eq(serviceRecord.id, record.id), isNull(serviceRecord.deletedAt)),
			),
		...(shouldRestoreBaseline(record, plan) && plan
			? [
					database
						.update(maintenancePlan)
						.set({
							baselineAt: required(
								record.previousBaselineAt,
								'Previous service baseline is missing',
							),
							baselineSessionCount: record.previousBaselineSessionCount ?? 0,
						})
						.where(
							and(
								eq(maintenancePlan.id, plan.id),
								eq(maintenancePlan.baselineAt, record.baselineAt),
							),
						),
				]
			: []),
	]);
	return c.json({
		serviceRecord: { ...record, deletedAt },
		maintenancePlan: plan
			? await db(c.env)
					.select()
					.from(maintenancePlan)
					.where(eq(maintenancePlan.id, plan.id))
					.get()
			: undefined,
	});
});

app.post('/api/v1/service-records/:recordId/restore', async (c) => {
	const record = await db(c.env)
		.select()
		.from(serviceRecord)
		.where(eq(serviceRecord.id, c.req.param('recordId')))
		.get();
	const parentCar = record ? await ownedCar(c, record.carId) : undefined;
	if (!record || !parentCar)
		return c.json({ error: 'Service record not found' }, 404);
	if (!canWrite(parentCar))
		return c.json(
			{ error: 'Car is archived; restore it before restoring service history' },
			409,
		);
	if (record.deletedAt === null)
		return c.json({ error: 'Service record is already active' }, 409);
	const database = db(c.env);
	const plan = record.planId
		? await database
				.select()
				.from(maintenancePlan)
				.where(eq(maintenancePlan.id, record.planId))
				.get()
		: undefined;
	await database.batch([
		database
			.update(serviceRecord)
			.set({ deletedAt: null })
			.where(
				and(
					eq(serviceRecord.id, record.id),
					isNotNull(serviceRecord.deletedAt),
				),
			),
		...(plan &&
		record.previousBaselineAt &&
		plan.baselineAt === record.previousBaselineAt
			? [
					database
						.update(maintenancePlan)
						.set({
							baselineAt: record.baselineAt,
							baselineSessionCount: record.baselineSessionCount ?? 0,
						})
						.where(
							and(
								eq(maintenancePlan.id, plan.id),
								eq(maintenancePlan.baselineAt, record.previousBaselineAt),
							),
						),
				]
			: []),
	]);
	return c.json({
		serviceRecord: await database
			.select()
			.from(serviceRecord)
			.where(eq(serviceRecord.id, record.id))
			.get(),
		maintenancePlan: plan
			? await database
					.select()
					.from(maintenancePlan)
					.where(eq(maintenancePlan.id, plan.id))
					.get()
			: undefined,
	});
});

app.all('/api', (c) => c.json({ error: 'Not found' }, 404));
app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));
app.all('*', async (c) => {
	const response = await c.env.ASSETS.fetch(c.req.raw);
	if (
		response.status !== 404 ||
		c.req.method !== 'GET' ||
		!c.req.header('Accept')?.includes('text/html')
	)
		return response;
	return c.env.ASSETS.fetch(new Request(new URL('/', c.req.url), c.req.raw));
});
export default app;

const carProperties = {
	name: { type: 'string', maxLength: 120 },
	make: { type: 'string', maxLength: 120 },
	model: { type: 'string', maxLength: 120 },
	scale: { type: 'string', maxLength: 20 },
	vehicleType: { type: 'string', maxLength: 80 },
	powerType: { type: 'string', maxLength: 80 },
	notes: { type: 'string', maxLength: 4000 },
};
const componentProperties = {
	slot: {
		type: 'string',
		description: 'A standard slot name or an owner-defined custom slot.',
	},
	slotType: { type: 'string', enum: ['standard', 'custom'] },
	name: { type: 'string', maxLength: 160 },
	manufacturer: { type: 'string', maxLength: 120 },
	model: { type: 'string', maxLength: 120 },
	serialNumber: { type: 'string', maxLength: 120 },
	notes: { type: 'string', maxLength: 4000 },
	installedAt: { type: 'string', format: 'date-time' },
	removedAt: { type: 'string', format: 'date-time', nullable: true },
};

const serviceRecordSchema = {
	type: 'object',
	required: ['performedAt'],
	anyOf: [{ required: ['description'] }, { required: ['notes'] }],
	properties: {
		performedAt: { type: 'string', format: 'date-time' },
		description: { type: 'string' },
		notes: { type: 'string' },
		componentId: { type: 'string' },
		cost: { type: 'number', minimum: 0 },
		currency: { type: 'string', pattern: '^[A-Za-z]{3}$' },
	},
	allOf: [
		{
			oneOf: [
				{
					not: { anyOf: [{ required: ['cost'] }, { required: ['currency'] }] },
				},
				{ required: ['cost', 'currency'] },
			],
		},
	],
};
const serviceRecordPatchSchema = {
	type: 'object',
	minProperties: 1,
	anyOf: [
		{ required: ['description'] },
		{ required: ['notes'] },
		{ required: ['performedAt'] },
		{ required: ['cost', 'currency'] },
	],
	properties: {
		...serviceRecordSchema.properties,
		notes: { type: 'string', nullable: true },
		cost: { type: 'number', minimum: 0, nullable: true },
		currency: { type: 'string', pattern: '^[A-Za-z]{3}$', nullable: true },
	},
	allOf: serviceRecordSchema.allOf,
};
const serviceCompletionSchema = {
	type: 'object',
	properties: serviceRecordSchema.properties,
	allOf: serviceRecordSchema.allOf,
};
const openApi = {
	openapi: '3.1.0',
	info: { title: 'RC Mech API', version: '0.1.0' },
	paths: {
		'/api/v1/cars': {
			get: {
				summary: "List the authenticated owner's cars",
				parameters: [
					{
						name: 'archived',
						in: 'query',
						required: false,
						schema: { type: 'string', enum: ['true', 'all'] },
						description:
							'Omit for active cars; true lists archived cars; all lists both.',
					},
				],
				responses: {
					200: { description: 'Cars visible to the authenticated owner' },
					401: { description: 'Authentication required' },
				},
			},
			post: {
				summary: 'Create an active car for the authenticated owner',
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['name'],
								properties: carProperties,
							},
						},
					},
				},
				responses: {
					201: { description: 'Car created' },
					400: { description: 'Invalid car' },
				},
			},
		},
		'/api/v1/cars/{carId}': {
			parameters: [
				{
					name: 'carId',
					in: 'path',
					required: true,
					schema: { type: 'string' },
				},
			],
			get: {
				summary: 'Inspect an owned car, including archived cars',
				responses: {
					200: { description: 'Owned car' },
					404: { description: 'Car not found' },
				},
			},
			patch: {
				summary: 'Edit an owned car',
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: { type: 'object', properties: carProperties },
						},
					},
				},
				responses: {
					200: { description: 'Car updated' },
					400: { description: 'Invalid car' },
					404: { description: 'Car not found' },
				},
			},
		},
		'/api/v1/cars/{carId}/archive': {
			post: {
				summary: 'Archive an owned car; it leaves the active list',
				responses: {
					200: { description: 'Car archived' },
					404: { description: 'Car not found' },
					409: { description: 'Already archived' },
				},
			},
		},
		'/api/v1/cars/{carId}/restore': {
			post: {
				summary: 'Restore an owned archived car to the active list',
				responses: {
					200: { description: 'Car restored' },
					404: { description: 'Car not found' },
					409: { description: 'Already active' },
				},
			},
		},
		'/api/v1/cars/{carId}/photos': {
			get: {
				summary:
					"List the authenticated owner's private car photos in explicit order",
				responses: {
					200: { description: 'Private car photo metadata' },
					404: { description: 'Car not found' },
				},
			},
			post: {
				summary: 'Upload a private car photo',
				requestBody: {
					required: true,
					content: {
						'multipart/form-data': {
							schema: {
								type: 'object',
								required: ['file'],
								properties: {
									file: { type: 'string', format: 'binary' },
									sortOrder: { type: 'integer', minimum: 0 },
									primary: { type: 'boolean' },
								},
							},
						},
					},
				},
				responses: {
					201: { description: 'Photo uploaded' },
					400: { description: 'Unsupported, empty, or oversized photo' },
					404: { description: 'Car not found' },
					409: { description: 'Car is archived' },
				},
			},
		},
		'/api/v1/cars/{carId}/photos/reorder': {
			patch: {
				summary:
					'Atomically replace the explicit order of every photo on an owned car',
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['photoIds'],
								properties: {
									photoIds: { type: 'array', items: { type: 'string' } },
								},
							},
						},
					},
				},
				responses: {
					200: { description: 'Reordered private photo metadata' },
					400: { description: 'Every photo ID must appear exactly once' },
					404: { description: 'Car not found' },
					409: { description: 'Car is archived' },
				},
			},
		},
		'/api/v1/cars/{carId}/photos/{photoId}': {
			parameters: [
				{
					name: 'carId',
					in: 'path',
					required: true,
					schema: { type: 'string' },
				},
				{
					name: 'photoId',
					in: 'path',
					required: true,
					schema: { type: 'string' },
				},
			],
			patch: {
				summary: 'Designate an owned car photo as primary or update its order',
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								minProperties: 1,
								properties: {
									sortOrder: { type: 'integer', minimum: 0 },
									isPrimary: { type: 'boolean' },
								},
							},
						},
					},
				},
				responses: {
					200: { description: 'Photo metadata updated' },
					400: { description: 'Invalid photo update' },
					404: { description: 'Photo not found' },
					409: { description: 'Car is archived' },
				},
			},
			delete: {
				summary: 'Delete an owned car photo',
				responses: {
					200: { description: 'Photo deleted' },
					404: { description: 'Photo not found' },
					409: { description: 'Car is archived' },
				},
			},
		},
		'/api/v1/cars/{carId}/photos/{photoId}/replace': {
			parameters: [
				{
					name: 'carId',
					in: 'path',
					required: true,
					schema: { type: 'string' },
				},
				{
					name: 'photoId',
					in: 'path',
					required: true,
					schema: { type: 'string' },
				},
			],
			post: {
				summary: "Replace an owned car photo's bytes and metadata",
				requestBody: {
					required: true,
					content: {
						'multipart/form-data': {
							schema: {
								type: 'object',
								required: ['file'],
								properties: { file: { type: 'string', format: 'binary' } },
							},
						},
					},
				},
				responses: {
					200: { description: 'Photo replaced' },
					400: { description: 'Unsupported, empty, or oversized photo' },
					404: { description: 'Photo not found' },
					409: { description: 'Car is archived' },
				},
			},
		},
		'/api/v1/photos/{photoId}': {
			parameters: [
				{
					name: 'photoId',
					in: 'path',
					required: true,
					schema: { type: 'string' },
				},
			],
			get: {
				summary: 'Stream an owned private photo',
				responses: {
					200: { description: 'Private photo bytes' },
					404: { description: 'Photo not found' },
				},
			},
			patch: {
				summary: 'Reorder or designate an owned photo as primary',
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								minProperties: 1,
								properties: {
									sortOrder: { type: 'integer', minimum: 0 },
									isPrimary: { type: 'boolean' },
								},
							},
						},
					},
				},
				responses: {
					200: { description: 'Photo metadata updated' },
					400: { description: 'Invalid photo update' },
					404: { description: 'Photo not found' },
					409: { description: 'Car is archived' },
				},
			},
			put: {
				summary: "Replace an owned photo's bytes and metadata",
				requestBody: {
					required: true,
					content: {
						'multipart/form-data': {
							schema: {
								type: 'object',
								required: ['file'],
								properties: { file: { type: 'string', format: 'binary' } },
							},
						},
					},
				},
				responses: {
					200: { description: 'Photo replaced' },
					400: { description: 'Unsupported, empty, or oversized photo' },
					404: { description: 'Photo not found' },
					409: { description: 'Car is archived' },
				},
			},
			delete: {
				summary: 'Delete an owned photo',
				responses: {
					200: { description: 'Photo deleted' },
					404: { description: 'Photo not found' },
					409: { description: 'Car is archived' },
				},
			},
		},
		'/api/v1/photos/{photoId}/replace': {
			parameters: [
				{
					name: 'photoId',
					in: 'path',
					required: true,
					schema: { type: 'string' },
				},
			],
			post: {
				summary: "Replace an owned private photo's bytes and metadata",
				requestBody: {
					required: true,
					content: {
						'multipart/form-data': {
							schema: {
								type: 'object',
								required: ['file'],
								properties: { file: { type: 'string', format: 'binary' } },
							},
						},
					},
				},
				responses: {
					200: { description: 'Photo replaced' },
					400: { description: 'Unsupported, empty, or oversized photo' },
					404: { description: 'Photo not found' },
					409: { description: 'Car is archived' },
				},
			},
		},
		'/api/v1/component-slots': {
			get: {
				summary: 'List standard component slots',
				responses: {
					200: {
						description: 'Standard slots; custom slots may also be supplied',
					},
				},
			},
		},
		'/api/v1/cars/{carId}/components': {
			parameters: [
				{
					name: 'carId',
					in: 'path',
					required: true,
					schema: { type: 'string' },
				},
			],
			get: {
				summary:
					'List current components, or replacement history with history=true',
				parameters: [
					{ name: 'history', in: 'query', schema: { type: 'boolean' } },
				],
				responses: {
					200: { description: 'Owned car components' },
					404: { description: 'Car not found' },
				},
			},
			post: {
				summary:
					'Install a component; an existing current component in the slot is closed',
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['slot', 'name'],
								properties: componentProperties,
							},
						},
					},
				},
				responses: {
					201: { description: 'Component installed' },
					400: { description: 'Invalid component or slot' },
					404: { description: 'Car not found' },
					409: { description: 'Car is archived' },
				},
			},
		},
		'/api/v1/cars/{carId}/components/{componentId}': {
			parameters: [
				{
					name: 'carId',
					in: 'path',
					required: true,
					schema: { type: 'string' },
				},
				{
					name: 'componentId',
					in: 'path',
					required: true,
					schema: { type: 'string' },
				},
			],
			get: {
				summary: 'Get an owned component installation',
				responses: {
					200: { description: 'Component detail' },
					404: { description: 'Component not found' },
				},
			},
			patch: {
				summary: 'Edit an owned component',
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: { type: 'object', properties: componentProperties },
						},
					},
				},
				responses: {
					200: { description: 'Component updated' },
					400: { description: 'Invalid component' },
					404: { description: 'Component not found' },
					409: { description: 'Car is archived' },
				},
			},
		},
		'/api/v1/cars/{carId}/components/{componentId}/replace': {
			post: {
				summary: 'Replace the current component and preserve its history',
				parameters: [
					{
						name: 'carId',
						in: 'path',
						required: true,
						schema: { type: 'string' },
					},
					{
						name: 'componentId',
						in: 'path',
						required: true,
						schema: { type: 'string' },
					},
				],
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['slot', 'name'],
								properties: componentProperties,
							},
						},
					},
				},
				responses: {
					201: { description: 'Replacement installed' },
					400: { description: 'Invalid component or slot' },
					404: { description: 'Component not found' },
					409: { description: 'Component is not current or car is archived' },
				},
			},
		},
		'/api/v1/preferences/timezone': {
			get: {
				summary: "Get the authenticated owner's IANA timezone",
				responses: { 200: { description: 'Timezone preference' } },
			},
			patch: {
				summary: "Set the authenticated owner's IANA timezone",
				responses: {
					200: { description: 'Timezone preference updated' },
					400: { description: 'Invalid IANA timezone' },
				},
			},
		},
		'/api/v1/cars/{carId}/drives': {
			parameters: [
				{
					name: 'carId',
					in: 'path',
					required: true,
					schema: { type: 'string' },
				},
				{
					name: 'history',
					in: 'query',
					required: false,
					schema: { type: 'boolean' },
				},
			],
			get: {
				summary:
					"List an owned car's drive sessions; history=true includes soft-deleted sessions",
				responses: {
					200: { description: 'Drive session history' },
					404: { description: 'Car not found' },
				},
			},
			post: {
				summary: 'Record a drive session for an active owned car',
				responses: {
					201: { description: 'Drive recorded' },
					404: { description: 'Car not found' },
					409: { description: 'Car is archived' },
				},
			},
		},
		'/api/v1/cars/{carId}/drives/count': {
			parameters: [
				{
					name: 'carId',
					in: 'path',
					required: true,
					schema: { type: 'string' },
				},
			],
			get: {
				summary: 'Count non-deleted drive sessions for an owned car',
				responses: {
					200: { description: 'Drive session count' },
					404: { description: 'Car not found' },
				},
			},
		},
		'/api/v1/cars/{carId}/drives/{driveId}': {
			parameters: [
				{
					name: 'carId',
					in: 'path',
					required: true,
					schema: { type: 'string' },
				},
				{
					name: 'driveId',
					in: 'path',
					required: true,
					schema: { type: 'string' },
				},
			],
			patch: {
				summary: 'Edit an active drive session',
				responses: {
					200: { description: 'Drive session updated' },
					404: { description: 'Drive session not found' },
					409: { description: 'Deleted session' },
				},
			},
			delete: {
				summary: 'Soft-delete a drive session',
				responses: {
					200: { description: 'Drive session deleted' },
					404: { description: 'Drive session not found' },
					409: { description: 'Already deleted' },
				},
			},
		},
		'/api/v1/cars/{carId}/service-records': {
			get: {
				summary: 'List service records for an owned car',
				parameters: [
					{ name: 'history', in: 'query', schema: { type: 'boolean' } },
				],
				responses: {
					200: { description: 'Service history' },
					404: { description: 'Car not found' },
				},
			},
			post: {
				summary: 'Record ad hoc service for an active owned car',
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['performedAt'],
								properties: {
									performedAt: { type: 'string', format: 'date-time' },
									componentId: { type: 'string' },
									description: { type: 'string' },
									notes: { type: 'string' },
									cost: { type: 'number', minimum: 0 },
									currency: { type: 'string', pattern: '^[A-Za-z]{3}$' },
								},
							},
						},
					},
				},
				responses: {
					201: { description: 'Service recorded' },
					400: { description: 'Invalid service record or cost data' },
					404: { description: 'Car or component not found' },
					409: { description: 'Car is archived' },
				},
			},
		},
		'/api/v1/service-records/{recordId}': {
			patch: {
				summary: 'Edit an active service record',
				responses: {
					200: { description: 'Service record updated' },
					404: { description: 'Service record not found' },
					409: { description: 'Car is archived or record is deleted' },
				},
			},
			delete: {
				summary:
					'Soft-delete a service record and restore its prior plan baseline when still current',
				responses: {
					200: { description: 'Service record deleted' },
					404: { description: 'Service record not found' },
					409: { description: 'Car is archived or record is already deleted' },
				},
			},
		},
		'/api/v1/service-records/{recordId}/restore': {
			post: {
				summary: 'Restore a soft-deleted service record',
				responses: {
					200: { description: 'Service record restored' },
					404: { description: 'Service record not found' },
					409: { description: 'Car is archived or record is already active' },
				},
			},
		},
		'/api/v1/maintenance-plans': {
			post: {
				summary:
					'Create a maintenance plan for an owned car or current component',
				responses: {
					201: { description: 'Maintenance plan created' },
					404: { description: 'Car not found' },
					409: { description: 'Car, component, or lifecycle conflict' },
				},
			},
		},
		'/api/v1/maintenance-plans/{planId}': {
			patch: {
				summary: 'Edit a maintenance plan',
				responses: {
					200: { description: 'Maintenance plan updated' },
					404: { description: 'Plan not found' },
					400: { description: 'Invalid plan' },
				},
			},
		},
		'/api/v1/maintenance-plans/{planId}/pause': {
			post: {
				summary: 'Pause a maintenance plan',
				responses: {
					200: { description: 'Plan paused' },
					409: { description: 'Invalid lifecycle transition' },
				},
			},
		},
		'/api/v1/maintenance-plans/{planId}/resume': {
			post: {
				summary: 'Resume a paused maintenance plan',
				responses: {
					200: { description: 'Plan resumed' },
					409: { description: 'Invalid lifecycle transition' },
				},
			},
		},
		'/api/v1/maintenance-plans/{planId}/archive': {
			post: {
				summary: 'Archive a maintenance plan',
				responses: {
					200: { description: 'Plan archived' },
					409: { description: 'Invalid lifecycle transition' },
				},
			},
		},
		'/api/v1/cars/{carId}/maintenance-plans': {
			get: {
				summary: 'List plans with due calculations for an owned car',
				responses: {
					200: { description: 'Maintenance plans and due state' },
					404: { description: 'Car not found' },
				},
			},
		},
		'/api/v1/cars/{carId}/maintenance-cockpit': {
			get: {
				summary:
					'Maintenance cockpit grouped by upcoming, due, overdue, and lifecycle state',
				responses: {
					200: { description: 'Maintenance cockpit' },
					404: { description: 'Car not found' },
				},
			},
		},
		'/api/v1/maintenance-cockpit': {
			get: {
				summary: "Maintenance cockpit for the authenticated owner's garage",
				responses: { 200: { description: 'Maintenance cockpit' } },
			},
		},
		'/api/v1/maintenance-plans/{planId}/complete': {
			post: {
				summary:
					'Complete exactly one plan, create one service record, and reset its baseline transactionally',
				requestBody: {
					content: {
						'application/json': {
							schema: {
								type: 'object',
								properties: {
									performedAt: { type: 'string', format: 'date-time' },
									description: { type: 'string' },
									notes: { type: 'string' },
									cost: { type: 'number', minimum: 0 },
									currency: { type: 'string', pattern: '^[A-Za-z]{3}$' },
								},
							},
						},
					},
				},
				responses: {
					201: { description: 'Service completion and updated plan' },
					400: { description: 'Invalid completion or cost data' },
					409: { description: 'Plan or car is not writable' },
				},
			},
		},
	},
};

const setupPaths = openApi.paths as Record<string, unknown>;
const setupSchema = {
	type: 'object',
	required: ['name'],
	properties: {
		name: { type: 'string' },
		status: { type: 'string', enum: ['draft', 'reviewed', 'active'] },
		setupDate: { type: 'string', format: 'date-time' },
		track: { type: 'string' },
		event: { type: 'string' },
		surface: { type: 'string' },
		traction: { type: 'string' },
		moisture: { type: 'string' },
		condition: { type: 'string' },
		temperature: { type: 'string' },
		vehicle: { type: 'object', additionalProperties: true },
		drivetrain: { type: 'object', additionalProperties: true },
		electronics: { type: 'object', additionalProperties: true },
		tires: { type: 'object', additionalProperties: true },
		shocks: { type: 'object', additionalProperties: true },
		frontSuspension: { type: 'object', additionalProperties: true },
		rearSuspension: { type: 'object', additionalProperties: true },
		notes: { type: 'string' },
		sourceUrl: { type: 'string', format: 'uri' },
		sourcePdfReference: { type: 'string' },
		sourceMetadata: { type: 'object', additionalProperties: true },
		rawValues: { type: 'object', additionalProperties: true },
		unmappedValues: { type: 'object', additionalProperties: true },
		makeCurrent: { type: 'boolean' },
	},
};
const setupResponseSchema = {
	type: 'object',
	required: [
		'id',
		'carId',
		'name',
		'status',
		'current',
		'context',
		'sections',
		'notes',
		'source',
		'copiedFromSetupId',
		'rawValues',
		'unmappedValues',
		'createdAt',
		'updatedAt',
	],
	properties: {
		id: { type: 'string' },
		carId: { type: 'string' },
		name: { type: 'string' },
		status: { type: 'string' },
		current: { type: 'boolean' },
		context: { type: 'object', additionalProperties: true },
		sections: { type: 'object', additionalProperties: true },
		notes: { type: 'string', nullable: true },
		source: { type: 'object', nullable: true, additionalProperties: true },
		copiedFromSetupId: { type: 'string', nullable: true },
		rawValues: { type: 'object', nullable: true, additionalProperties: true },
		unmappedValues: {
			type: 'object',
			nullable: true,
			additionalProperties: true,
		},
		createdAt: { type: 'string', format: 'date-time' },
		updatedAt: { type: 'string', format: 'date-time' },
	},
};
const setupResponse = {
	type: 'object',
	required: ['setup'],
	properties: { setup: setupResponseSchema },
};
const nullableSetupResponse = {
	...setupResponse,
	properties: {
		...setupResponse.properties,
		setup: { ...setupResponseSchema, nullable: true },
	},
};
const setupListResponse = {
	type: 'object',
	required: ['currentSetupId', 'setups'],
	properties: {
		currentSetupId: { type: 'string', nullable: true },
		setups: { type: 'array', items: setupResponseSchema },
	},
};
const setupIdParameter = {
	name: 'setupId',
	in: 'path',
	required: true,
	schema: { type: 'string' },
};
const carIdParameter = {
	name: 'carId',
	in: 'path',
	required: true,
	schema: { type: 'string' },
};
Object.assign(setupPaths, {
	'/api/v1/cars/{carId}/setups': {
		parameters: [carIdParameter],
		get: {
			summary: 'List setup snapshots for an owned car',
			responses: {
				200: {
					description: 'Setup snapshots',
					content: { 'application/json': { schema: setupListResponse } },
				},
				404: { description: 'Car not found' },
			},
		},
		post: {
			summary: 'Create an owned-car setup snapshot',
			requestBody: {
				required: true,
				content: { 'application/json': { schema: setupSchema } },
			},
			responses: {
				201: {
					description: 'Created setup snapshot',
					content: { 'application/json': { schema: setupResponse } },
				},
				400: { description: 'Invalid setup' },
				409: { description: 'Archived car' },
			},
		},
	},
	'/api/v1/cars/{carId}/setups/current': {
		parameters: [carIdParameter],
		get: {
			summary: 'Read the current setup selected for an owned car',
			responses: {
				200: {
					description: 'Current setup',
					content: { 'application/json': { schema: nullableSetupResponse } },
				},
				404: { description: 'Car not found' },
			},
		},
	},
	'/api/v1/cars/{carId}/setups/{setupId}': {
		parameters: [carIdParameter, setupIdParameter],
		get: {
			summary: 'Read an owned-car setup snapshot',
			responses: {
				200: {
					description: 'Setup snapshot',
					content: { 'application/json': { schema: setupResponse } },
				},
				404: { description: 'Setup not found' },
			},
		},
		patch: {
			summary: 'Edit an owned-car setup snapshot',
			requestBody: {
				required: true,
				content: {
					'application/json': { schema: { ...setupSchema, required: [] } },
				},
			},
			responses: {
				200: {
					description: 'Updated setup snapshot',
					content: { 'application/json': { schema: setupResponse } },
				},
				400: { description: 'Invalid setup' },
				404: { description: 'Setup not found' },
				409: { description: 'Archived car' },
			},
		},
	},
	'/api/v1/cars/{carId}/setups/copy': {
		parameters: [carIdParameter],
		post: {
			summary: 'Copy the current setup, or newest setup when none is current',
			requestBody: {
				content: {
					'application/json': { schema: { ...setupSchema, required: [] } },
				},
			},
			responses: {
				201: {
					description: 'Copied setup snapshot',
					content: {
						'application/json': {
							schema: {
								...setupResponse,
								properties: {
									...setupResponse.properties,
									sourceSetupId: { type: 'string' },
								},
							},
						},
					},
				},
				404: { description: 'Car or source setup not found' },
				409: { description: 'Archived car' },
			},
		},
	},
	'/api/v1/cars/{carId}/setups/{setupId}/copy': {
		parameters: [carIdParameter, setupIdParameter],
		post: {
			summary: 'Copy an owned-car setup snapshot',
			requestBody: {
				content: {
					'application/json': { schema: { ...setupSchema, required: [] } },
				},
			},
			responses: {
				201: {
					description: 'Copied setup snapshot',
					content: { 'application/json': { schema: setupResponse } },
				},
				404: { description: 'Setup not found' },
				409: { description: 'Archived car' },
			},
		},
	},
	'/api/v1/cars/{carId}/setups/{setupId}/current': {
		parameters: [carIdParameter, setupIdParameter],
		post: {
			summary: 'Select an owned-car setup as current',
			responses: {
				200: {
					description: 'Current setup selected',
					content: { 'application/json': { schema: setupResponse } },
				},
				404: { description: 'Setup not found' },
				409: { description: 'Archived car' },
			},
		},
	},
});

Object.assign(setupPaths, {
	'/api/v1/setup-imports/drafts': {
		post: {
			summary:
				'Resolve a supported So Dialed URL into an owner-scoped review draft',
			requestBody: {
				required: true,
				content: {
					'application/json': {
						schema: {
							type: 'object',
							required: ['sourceUrl'],
							properties: {
								sourceUrl: { type: 'string', format: 'uri' },
								carId: { type: 'string' },
							},
						},
					},
				},
			},
			responses: {
				201: { description: 'Created import review draft' },
				400: { description: 'Malformed or unsupported source URL' },
				409: { description: 'Source has already been imported' },
				422: { description: 'Source could not be resolved' },
			},
		},
		get: {
			summary: 'List import drafts for the authenticated owner',
			responses: { 200: { description: 'Owner-scoped import drafts' } },
		},
	},
	'/api/v1/setup-imports/drafts/{draftId}': {
		parameters: [
			{
				name: 'draftId',
				in: 'path',
				required: true,
				schema: { type: 'string' },
			},
		],
		get: {
			summary: 'Read an owner-scoped import review draft',
			responses: {
				200: { description: 'Import review draft' },
				404: { description: 'Draft not found' },
			},
		},
		patch: {
			summary: 'Edit an open import review draft',
			requestBody: {
				required: true,
				content: {
					'application/json': {
						schema: {
							type: 'object',
							minProperties: 1,
							additionalProperties: true,
						},
					},
				},
			},
			responses: {
				200: { description: 'Updated import draft' },
				400: { description: 'Invalid draft edit' },
				409: { description: 'Draft is closed' },
			},
		},
	},
	'/api/v1/setup-imports/drafts/{draftId}/cancel': {
		parameters: [
			{
				name: 'draftId',
				in: 'path',
				required: true,
				schema: { type: 'string' },
			},
		],
		post: {
			summary: 'Cancel an owner-scoped import draft',
			responses: {
				200: { description: 'Draft cancelled' },
				404: { description: 'Draft not found' },
			},
		},
	},
	'/api/v1/setup-imports/drafts/{draftId}/accept': {
		parameters: [
			{
				name: 'draftId',
				in: 'path',
				required: true,
				schema: { type: 'string' },
			},
		],
		post: {
			summary: 'Accept a reviewed draft as a new setup snapshot',
			requestBody: {
				required: true,
				content: {
					'application/json': {
						schema: {
							type: 'object',
							required: ['carId'],
							properties: {
								carId: { type: 'string' },
								name: { type: 'string' },
								makeCurrent: { type: 'boolean' },
							},
						},
					},
				},
			},
			responses: {
				201: { description: 'New setup snapshot created' },
				404: { description: 'Draft or car not found' },
				409: { description: 'Duplicate source or archived car' },
			},
		},
	},
});

const serviceRecordPaths = openApi.paths as unknown as Record<
	string,
	{ post: { requestBody: unknown }; patch: { requestBody: unknown } }
>;
serviceRecordPaths['/api/v1/cars/{carId}/service-records'].post.requestBody = {
	required: true,
	content: { 'application/json': { schema: serviceRecordSchema } },
};
serviceRecordPaths['/api/v1/service-records/{recordId}'].patch.requestBody = {
	required: true,
	content: { 'application/json': { schema: serviceRecordPatchSchema } },
};
serviceRecordPaths[
	'/api/v1/maintenance-plans/{planId}/complete'
].post.requestBody = {
	content: { 'application/json': { schema: serviceCompletionSchema } },
};
