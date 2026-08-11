import {
	index,
	integer,
	primaryKey,
	real,
	sqliteTable,
	text,
} from 'drizzle-orm/sqlite-core';

const id = (name: string) => text(name).primaryKey();
export const car = sqliteTable('car', {
	id: id('id'),
	ownerId: text('owner_id'),
	name: text('name').notNull(),
	make: text('make'),
	model: text('model'),
	scale: text('scale'),
	vehicleType: text('vehicle_type'),
	powerType: text('power_type'),
	notes: text('notes'),
	currentSetupId: text('current_setup_id'),
	currentSetupVersion: integer('current_setup_version').notNull().default(0),
	currentSetupOperationId: text('current_setup_operation_id'),
	createdAt: text('created_at').notNull(),
	archivedAt: text('archived_at'),
	version: integer('version').notNull().default(1),
	lastOperationId: text('last_operation_id'),
});
export const syncOperation = sqliteTable(
	'sync_operation',
	{
		ownerId: text('owner_id').notNull(),
		operationId: text('operation_id').notNull(),
		contractVersion: integer('contract_version').notNull(),
		kind: text('kind').notNull(),
		entityType: text('entity_type').notNull(),
		entityId: text('entity_id').notNull(),
		requestHash: text('request_hash').notNull(),
		outcome: text('outcome').notNull(),
		httpStatus: integer('http_status'),
		responseJson: text('response_json'),
		createdAt: text('created_at').notNull(),
		completedAt: text('completed_at'),
	},
	(table) => [
		primaryKey({ columns: [table.ownerId, table.operationId] }),
		index('sync_operation_owner_entity_idx').on(
			table.ownerId,
			table.entityType,
			table.entityId,
			table.createdAt,
		),
	],
);
export const setup = sqliteTable('setup', {
	id: id('id'),
	carId: text('car_id').notNull(),
	name: text('name').notNull().default('Untitled setup'),
	status: text('status').notNull().default('active'),
	setupDate: text('setup_date'),
	track: text('track'),
	event: text('event'),
	surface: text('surface'),
	traction: text('traction'),
	moisture: text('moisture'),
	condition: text('condition'),
	temperature: text('temperature'),
	vehicle: text('vehicle'),
	drivetrain: text('drivetrain'),
	electronics: text('electronics'),
	tires: text('tires'),
	shocks: text('shocks'),
	frontSuspension: text('front_suspension'),
	rearSuspension: text('rear_suspension'),
	notes: text('notes'),
	sourceUrl: text('source_url'),
	sourcePdfReference: text('source_pdf_reference'),
	sourceMetadata: text('source_metadata'),
	copiedFromId: text('copied_from_id'),
	rawValues: text('raw_values'),
	unmappedValues: text('unmapped_values'),
	createdAt: text('created_at').notNull(),
	updatedAt: text('updated_at').notNull(),
	version: integer('version').notNull().default(1),
	lastOperationId: text('last_operation_id'),
});
export const setupImportDraft = sqliteTable('setup_import_draft', {
	id: id('id'),
	ownerId: text('owner_id')
		.notNull()
		.references(() => owner.id),
	carId: text('car_id').references(() => car.id),
	sourceUrl: text('source_url').notNull(),
	sourceKey: text('source_key').notNull(),
	status: text('status').notNull().default('draft'),
	sourceIdentity: text('source_identity'),
	sourcePdfReference: text('source_pdf_reference'),
	sourceMetadata: text('source_metadata'),
	knownValues: text('known_values'),
	uncertainValues: text('uncertain_values'),
	rawValues: text('raw_values'),
	unmappedValues: text('unmapped_values'),
	error: text('error'),
	acceptedSetupId: text('accepted_setup_id').references(() => setup.id),
	createdAt: text('created_at').notNull(),
	updatedAt: text('updated_at').notNull(),
});
export const consumableMaintenanceEntry = sqliteTable(
	'consumable_maintenance_entry',
	{
		id: id('id'),
		carId: text('car_id')
			.notNull()
			.references(() => car.id),
		kind: text('kind').notNull(),
		performedAt: text('performed_at').notNull(),
		fluidArea: text('fluid_area'),
		customFluidArea: text('custom_fluid_area'),
		frontDetails: text('front_details'),
		frontCost: real('front_cost'),
		frontCurrency: text('front_currency'),
		rearDetails: text('rear_details'),
		rearCost: real('rear_cost'),
		rearCurrency: text('rear_currency'),
		cost: real('cost'),
		currency: text('currency'),
		notes: text('notes'),
		prefilledFromSetupId: text('prefilled_from_setup_id').references(
			() => setup.id,
		),
		archivedAt: text('archived_at'),
		createdAt: text('created_at').notNull(),
		updatedAt: text('updated_at').notNull(),
	},
);
export const component = sqliteTable('component', {
	id: id('id'),
	carId: text('car_id').notNull(),
	slot: text('slot').notNull(),
	slotType: text('slot_type').notNull().default('custom'),
	name: text('name').notNull(),
	manufacturer: text('manufacturer'),
	model: text('model'),
	serialNumber: text('serial_number'),
	notes: text('notes'),
	installedAt: text('installed_at').notNull(),
	removedAt: text('removed_at'),
});
export const driveSession = sqliteTable('drive_session', {
	id: id('id'),
	carId: text('car_id').notNull(),
	startedAt: text('started_at').notNull(),
	durationMinutes: integer('duration_minutes'),
	conditions: text('conditions'),
	notes: text('notes'),
	deletedAt: text('deleted_at'),
});
export const maintenancePlan = sqliteTable('maintenance_plan', {
	id: id('id'),
	carId: text('car_id').notNull(),
	componentId: text('component_id'),
	name: text('name').notNull(),
	intervalDays: integer('interval_days'),
	intervalSessions: integer('interval_sessions'),
	intervalUnit: text('interval_unit').notNull().default('days'),
	intervalValue: integer('interval_value').notNull().default(1),
	baselineAt: text('baseline_at').notNull(),
	baselineSessionCount: integer('baseline_session_count').notNull().default(0),
	status: text('status').notNull(),
	pauseReason: text('pause_reason'),
	pausedAt: text('paused_at'),
});
export const serviceRecord = sqliteTable('service_record', {
	id: id('id'),
	carId: text('car_id').notNull(),
	componentId: text('component_id'),
	planId: text('plan_id'),
	performedAt: text('performed_at').notNull(),
	description: text('description').notNull(),
	notes: text('notes'),
	cost: real('cost'),
	currency: text('currency'),
	baselineAt: text('baseline_at').notNull(),
	baselineSessionCount: integer('baseline_session_count'),
	previousBaselineAt: text('previous_baseline_at'),
	previousBaselineSessionCount: integer('previous_baseline_session_count'),
	deletedAt: text('deleted_at'),
});
export const photo = sqliteTable('photo', {
	id: id('id'),
	carId: text('car_id').notNull(),
	objectKey: text('object_key').notNull().unique(),
	contentType: text('content_type').notNull(),
	fileName: text('file_name').notNull().default('photo'),
	byteSize: integer('byte_size').notNull().default(0),
	sortOrder: integer('sort_order').notNull().default(0),
	isPrimary: integer('is_primary', { mode: 'boolean' })
		.notNull()
		.default(false),
	createdAt: text('created_at').notNull(),
});

export const voiceUpdate = sqliteTable('voice_update', {
	id: id('id'),
	ownerId: text('owner_id')
		.notNull()
		.references(() => owner.id),
	carId: text('car_id')
		.notNull()
		.references(() => car.id),
	driveSessionId: text('drive_session_id').references(() => driveSession.id),
	objectKey: text('object_key').unique(),
	contentType: text('content_type'),
	fileName: text('file_name'),
	byteSize: integer('byte_size').notNull().default(0),
	status: text('status').notNull().default('pending'),
	transcript: text('transcript'),
	draftJson: text('draft_json'),
	correctionsJson: text('corrections_json'),
	clarificationPrompt: text('clarification_prompt'),
	error: text('error'),
	confirmedAt: text('confirmed_at'),
	artifactDeletedAt: text('artifact_deleted_at'),
	createdAt: text('created_at').notNull(),
	updatedAt: text('updated_at').notNull(),
});

export const voiceProblemNote = sqliteTable('voice_problem_note', {
	id: id('id'),
	voiceUpdateId: text('voice_update_id')
		.notNull()
		.references(() => voiceUpdate.id),
	carId: text('car_id')
		.notNull()
		.references(() => car.id),
	driveSessionId: text('drive_session_id').references(() => driveSession.id),
	note: text('note').notNull(),
	createdAt: text('created_at').notNull(),
});

export const voiceUpdateResult = sqliteTable('voice_update_result', {
	id: id('id'),
	voiceUpdateId: text('voice_update_id')
		.notNull()
		.references(() => voiceUpdate.id),
	kind: text('kind').notNull(),
	recordId: text('record_id').notNull(),
	label: text('label').notNull(),
	createdAt: text('created_at').notNull(),
});

export const owner = sqliteTable('owner', {
	id: id('id'),
	name: text('name').notNull(),
	email: text('email').notNull().unique(),
	emailVerified: integer('email_verified', { mode: 'boolean' }).notNull(),
	image: text('image'),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
	updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
	timezone: text('timezone').notNull().default('UTC'),
});

export const session = sqliteTable('session', {
	id: id('id'),
	expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
	token: text('token').notNull().unique(),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
	updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
	ipAddress: text('ip_address'),
	userAgent: text('user_agent'),
	userId: text('user_id').notNull(),
});

export const account = sqliteTable('account', {
	id: id('id'),
	accountId: text('account_id').notNull(),
	providerId: text('provider_id').notNull(),
	userId: text('user_id').notNull(),
	accessToken: text('access_token'),
	refreshToken: text('refresh_token'),
	idToken: text('id_token'),
	accessTokenExpiresAt: integer('access_token_expires_at', {
		mode: 'timestamp_ms',
	}),
	refreshTokenExpiresAt: integer('refresh_token_expires_at', {
		mode: 'timestamp_ms',
	}),
	scope: text('scope'),
	password: text('password'),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
	updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const verification = sqliteTable('verification', {
	id: id('id'),
	identifier: text('identifier').notNull(),
	value: text('value').notNull(),
	expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }),
	updatedAt: integer('updated_at', { mode: 'timestamp_ms' }),
});

export const passkey = sqliteTable('passkey', {
	id: id('id'),
	name: text('name'),
	publicKey: text('public_key').notNull(),
	userId: text('user_id').notNull(),
	credentialID: text('credential_id').notNull().unique(),
	counter: integer('counter').notNull().default(0),
	deviceType: text('device_type'),
	backedUp: integer('backed_up', { mode: 'boolean' }).notNull().default(false),
	transports: text('transports'),
	createdAt: integer('created_at', { mode: 'timestamp_ms' }),
	aaguid: text('aaguid'),
});

export const inviteCode = sqliteTable('invite_code', {
	id: id('id'),
	code: text('code').notNull().unique(),
	creatorId: text('creator_id')
		.notNull()
		.references(() => owner.id),
	slot: integer('slot'),
	status: text('status').notNull().default('available'),
	reservedEmail: text('reserved_email'),
	reservedUntil: text('reserved_until'),
	redeemedEmail: text('redeemed_email'),
	redeemedUserId: text('redeemed_user_id').references(() => owner.id),
	reservedAt: text('reserved_at'),
	redeemedAt: text('redeemed_at'),
	revokedAt: text('revoked_at'),
	createdAt: text('created_at').notNull(),
	updatedAt: text('updated_at').notNull(),
});
export const authRateLimit = sqliteTable('auth_rate_limit', {
	key: id('key'),
	windowStartedAt: integer('window_started_at').notNull(),
	count: integer('count').notNull().default(0),
});
