import { VOICE_CORRECTION_MAX_LENGTH } from './types';

const carProperties = {
	name: { type: 'string', maxLength: 120 },
	make: { type: 'string', maxLength: 120 },
	model: { type: 'string', maxLength: 120 },
	scale: { type: 'string', maxLength: 20 },
	vehicleType: { type: 'string', maxLength: 80 },
	powerType: { type: 'string', maxLength: 80 },
	notes: { type: 'string', maxLength: 4000 },
};
const carBaseProperties = {
	name: carProperties.name,
	make: { ...carProperties.make, type: ['string', 'null'] },
	model: { ...carProperties.model, type: ['string', 'null'] },
	scale: { ...carProperties.scale, type: ['string', 'null'] },
	vehicleType: { ...carProperties.vehicleType, type: ['string', 'null'] },
	powerType: { ...carProperties.powerType, type: ['string', 'null'] },
	notes: { ...carProperties.notes, type: ['string', 'null'] },
};
const setupProperties = {
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
};
const setupCurrentSelectionSchema = {
	type: 'object',
	required: ['setupId', 'version'],
	properties: {
		setupId: { type: 'string', format: 'uuid', nullable: true },
		version: { type: 'integer', minimum: 0 },
	},
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
export const openApi = {
	openapi: '3.1.0',
	info: { title: 'Chassis Notes API', version: '0.1.0' },
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
		'/api/v1/sync/operations/{operationId}': {
			parameters: [
				{
					name: 'operationId',
					in: 'path',
					required: true,
					schema: { type: 'string', format: 'uuid' },
				},
			],
			put: {
				summary:
					'Idempotently apply one owner-scoped, version-aware Car or Setup operation',
				requestBody: {
					required: true,
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['contractVersion', 'command'],
								properties: {
									contractVersion: { type: 'integer', enum: [1] },
									command: {
										oneOf: [
											{
												type: 'object',
												required: ['type', 'carId', 'car'],
												properties: {
													type: { const: 'car.create' },
													carId: { type: 'string', format: 'uuid' },
													car: {
														type: 'object',
														required: ['name'],
														properties: carProperties,
													},
												},
											},
											{
												type: 'object',
												required: [
													'type',
													'carId',
													'baseVersion',
													'base',
													'changes',
												],
												properties: {
													type: { const: 'car.edit' },
													carId: { type: 'string', format: 'uuid' },
													baseVersion: { type: 'integer', minimum: 0 },
													base: {
														type: 'object',
														description:
															'Must contain exactly the fields present in changes.',
														properties: carBaseProperties,
													},
													changes: {
														type: 'object',
														minProperties: 1,
														properties: carProperties,
													},
												},
											},
											...(['archive', 'restore'] as const).map((action) => ({
												type: 'object',
												required: ['type', 'carId', 'baseVersion', 'base'],
												properties: {
													type: { const: `car.${action}` },
													carId: { type: 'string', format: 'uuid' },
													baseVersion: { type: 'integer', minimum: 0 },
													base: {
														type: 'object',
														required: ['archivedAt'],
														properties: {
															archivedAt:
																action === 'archive'
																	? { type: 'null' }
																	: { type: 'string', format: 'date-time' },
														},
													},
												},
											})),
											{
												type: 'object',
												required: [
													'type',
													'carId',
													'setupId',
													'copiedFromSetupId',
													'setup',
													'makeCurrent',
													'baseCurrent',
												],
												properties: {
													type: { const: 'setup.create' },
													carId: { type: 'string', format: 'uuid' },
													setupId: { type: 'string', format: 'uuid' },
													copiedFromSetupId: {
														type: 'string',
														format: 'uuid',
														nullable: true,
													},
													setup: {
														type: 'object',
														required: ['name'],
														properties: setupProperties,
													},
													makeCurrent: { type: 'boolean' },
													baseCurrent: {
														...setupCurrentSelectionSchema,
														nullable: true,
													},
												},
											},
											{
												type: 'object',
												required: [
													'type',
													'carId',
													'setupId',
													'baseVersion',
													'base',
													'changes',
												],
												properties: {
													type: { const: 'setup.correct' },
													carId: { type: 'string', format: 'uuid' },
													setupId: { type: 'string', format: 'uuid' },
													baseVersion: { type: 'integer', minimum: 0 },
													base: {
														type: 'object',
														minProperties: 1,
														properties: setupProperties,
													},
													changes: {
														type: 'object',
														minProperties: 1,
														properties: setupProperties,
													},
												},
											},
											{
												type: 'object',
												required: ['type', 'carId', 'setupId', 'baseCurrent'],
												properties: {
													type: { const: 'setup.select-current' },
													carId: { type: 'string', format: 'uuid' },
													setupId: { type: 'string', format: 'uuid' },
													baseCurrent: setupCurrentSelectionSchema,
												},
											},
										],
									},
								},
								additionalProperties: false,
							},
						},
					},
				},
				responses: {
					200: { description: 'Applied or exact terminal replay' },
					400: { description: 'Malformed operation envelope or identifier' },
					401: { description: 'Authentication required' },
					404: { description: 'Owned Car or Setup is unavailable' },
					409: {
						description:
							'Operation ID reuse, unsupported contract, or Sync conflict',
					},
					422: { description: 'Stable Needs-attention validation rejection' },
					503: {
						description: 'Transient synchronization infrastructure failure',
					},
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
		'/api/v1/service-records': {
			get: {
				summary: "List service records across the authenticated owner's cars",
				responses: {
					200: { description: 'Owner-scoped service history' },
					401: { description: 'Authentication required' },
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

const raceRecordingPaths = openApi.paths as Record<string, unknown>;
const raceRecordingSchema = {
	type: 'object',
	required: [
		'id',
		'carId',
		'driveSessionId',
		'fileName',
		'contentType',
		'sizeBytes',
		'partSizeBytes',
		'status',
		'uploadedBytes',
		'uploadedPartNumbers',
		'createdAt',
		'updatedAt',
		'expiresAt',
		'completedAt',
	],
	properties: {
		id: { type: 'string', format: 'uuid' },
		carId: { type: 'string' },
		driveSessionId: { type: 'string' },
		fileName: { type: 'string', maxLength: 255 },
		contentType: {
			type: 'string',
			enum: ['video/mp4', 'video/quicktime', 'video/webm'],
		},
		sizeBytes: { type: 'integer', minimum: 1, maximum: 10_737_418_240 },
		partSizeBytes: { type: 'integer', enum: [10_485_760] },
		status: { type: 'string', enum: ['uploading', 'validating'] },
		uploadedBytes: { type: 'integer', minimum: 0 },
		uploadedPartNumbers: {
			type: 'array',
			items: { type: 'integer', minimum: 1, maximum: 1024 },
		},
		createdAt: { type: 'string', format: 'date-time' },
		updatedAt: { type: 'string', format: 'date-time' },
		expiresAt: { type: 'string', format: 'date-time' },
		completedAt: { type: ['string', 'null'], format: 'date-time' },
	},
};
const raceRecordingResponse = {
	type: 'object',
	required: ['raceVideo'],
	properties: { raceVideo: raceRecordingSchema },
};
const raceVideoIdParameter = {
	name: 'raceVideoId',
	in: 'path',
	required: true,
	schema: { type: 'string', format: 'uuid' },
};
Object.assign(raceRecordingPaths, {
	'/api/v1/cars/{carId}/race-videos': {
		parameters: [
			{
				name: 'carId',
				in: 'path',
				required: true,
				schema: { type: 'string' },
			},
		],
		get: {
			summary: 'List resumable Race recordings for an owned Car',
			responses: {
				200: {
					description: 'Authoritative upload and validation progress',
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['raceVideos'],
								properties: {
									raceVideos: {
										type: 'array',
										items: raceRecordingSchema,
									},
								},
							},
						},
					},
				},
				404: { description: 'Car not found' },
			},
		},
	},
	'/api/v1/cars/{carId}/drives/{driveId}/race-videos': {
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
		post: {
			summary: 'Create or resume an owned private multipart Race recording',
			requestBody: {
				required: true,
				content: {
					'application/json': {
						schema: {
							type: 'object',
							additionalProperties: false,
							required: ['fileName', 'contentType', 'sizeBytes', 'requestId'],
							properties: {
								fileName: { type: 'string', minLength: 1, maxLength: 255 },
								contentType: raceRecordingSchema.properties.contentType,
								sizeBytes: raceRecordingSchema.properties.sizeBytes,
								requestId: { type: 'string', format: 'uuid' },
							},
						},
					},
				},
			},
			responses: {
				200: {
					description: 'Existing idempotent upload',
					content: { 'application/json': { schema: raceRecordingResponse } },
				},
				201: {
					description: 'Multipart upload created',
					content: { 'application/json': { schema: raceRecordingResponse } },
				},
				400: { description: 'Invalid upload declaration' },
				404: { description: 'Car or Drive session not found' },
				409: { description: 'Upload identity or lifecycle conflict' },
				429: { description: 'Owner quota or creation rate exceeded' },
				503: { description: 'Private storage unavailable' },
			},
		},
	},
	'/api/v1/race-videos/{raceVideoId}': {
		parameters: [raceVideoIdParameter],
		get: {
			summary: 'Read authoritative owner-scoped upload progress',
			responses: {
				200: {
					description: 'Current Race-recording state',
					content: { 'application/json': { schema: raceRecordingResponse } },
				},
				404: { description: 'Race recording not found' },
			},
		},
		delete: {
			summary: 'Cancel an upload or delete a completed private recording',
			responses: {
				204: { description: 'Private recording discarded or already absent' },
				404: { description: 'Race recording not found' },
				409: { description: 'Upload completion is already in progress' },
				503: { description: 'Private storage unavailable' },
			},
		},
	},
	'/api/v1/race-videos/{raceVideoId}/upload-parts/{partNumber}': {
		parameters: [
			raceVideoIdParameter,
			{
				name: 'partNumber',
				in: 'path',
				required: true,
				schema: { type: 'integer', minimum: 1, maximum: 1024 },
			},
			{
				name: 'x-transfer-request-id',
				in: 'header',
				required: true,
				schema: { type: 'string', minLength: 1, maxLength: 200 },
			},
		],
		put: {
			summary: 'Stream one exact bounded part into the server-held upload',
			requestBody: {
				required: true,
				content: {
					'application/octet-stream': {
						schema: { type: 'string', format: 'binary' },
					},
				},
			},
			responses: {
				200: {
					description: 'Authoritative persisted part progress',
					content: { 'application/json': { schema: raceRecordingResponse } },
				},
				400: { description: 'Part number, length, or headers invalid' },
				404: { description: 'Race recording not found' },
				409: { description: 'Part identity or lifecycle conflict' },
				410: { description: 'Upload expired' },
				429: { description: 'Owner quota exceeded' },
				503: { description: 'Private storage unavailable' },
			},
		},
	},
	'/api/v1/race-videos/{raceVideoId}/complete': {
		parameters: [raceVideoIdParameter],
		post: {
			summary: 'Complete and verify the server-held ordered multipart upload',
			responses: {
				200: {
					description: 'Completed private object ready for media validation',
					content: { 'application/json': { schema: raceRecordingResponse } },
				},
				404: { description: 'Race recording not found' },
				409: { description: 'Parts missing or lifecycle conflict' },
				503: { description: 'Private storage unavailable' },
			},
		},
	},
});

const setupPaths = openApi.paths as Record<string, unknown>;
const setupSchema = {
	type: 'object',
	required: ['name'],
	properties: {
		...setupProperties,
		makeCurrent: { type: 'boolean' },
	},
};
const guardedSetupCopySchema = {
	...setupSchema,
	required: [],
	properties: {
		...setupSchema.properties,
		expectedCurrentSetupId: { type: 'string' },
		expectedSourceUpdatedAt: { type: 'string', format: 'date-time' },
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
		'version',
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
		version: { type: 'integer', minimum: 1 },
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
	required: ['currentSetupId', 'currentSetupVersion', 'setups'],
	properties: {
		currentSetupId: { type: 'string', nullable: true },
		currentSetupVersion: { type: 'integer', minimum: 0 },
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
	'/api/v1/setups': {
		get: {
			summary:
				'List the complete owner-scoped setup snapshot for offline preparation',
			responses: {
				200: {
					description: 'Owner setup snapshot grouped by Car',
					content: {
						'application/json': {
							schema: {
								type: 'object',
								required: ['setupCollections'],
								properties: {
									setupCollections: {
										type: 'array',
										items: {
											type: 'object',
											required: [
												'carId',
												'currentSetupId',
												'currentSetupVersion',
												'setups',
											],
											properties: {
												carId: { type: 'string' },
												currentSetupId: {
													type: 'string',
													nullable: true,
												},
												currentSetupVersion: {
													type: 'integer',
													minimum: 0,
												},
												setups: {
													type: 'array',
													items: setupResponseSchema,
												},
											},
										},
									},
								},
							},
						},
					},
				},
			},
		},
	},
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
					'application/json': { schema: guardedSetupCopySchema },
				},
			},
			responses: {
				201: {
					description: 'Copied setup snapshot',
					content: { 'application/json': { schema: setupResponse } },
				},
				404: { description: 'Setup not found' },
				409: { description: 'Archived car or stale Current setup' },
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

const consumablePaths = openApi.paths as Record<string, unknown>;
const consumableAxleSchema = {
	type: 'object',
	properties: {
		details: {
			anyOf: [
				{ type: 'string' },
				{ type: 'object', additionalProperties: true },
			],
		},
		cost: { type: 'number', minimum: 0 },
		currency: { type: 'string', pattern: '^[A-Za-z]{3}$' },
	},
};
const consumableSchema = {
	type: 'object',
	required: ['kind', 'performedAt'],
	properties: {
		kind: { type: 'string', enum: ['fluid', 'tires'] },
		performedAt: { type: 'string', format: 'date-time' },
		fluidArea: {
			type: 'string',
			enum: [
				'front-shocks',
				'rear-shocks',
				'front-differential',
				'rear-differential',
				'custom',
			],
		},
		customFluidArea: { type: 'string' },
		front: consumableAxleSchema,
		rear: consumableAxleSchema,
		cost: { type: 'number', minimum: 0 },
		currency: { type: 'string', pattern: '^[A-Za-z]{3}$' },
		notes: { type: 'string' },
		prefillFromCurrentSetup: { type: 'boolean' },
	},
};
const consumableUpdateSchema = {
	type: 'object',
	minProperties: 1,
	properties: {
		performedAt: { type: 'string', format: 'date-time' },
		notes: { type: 'string', nullable: true },
		fluidArea: consumableSchema.properties.fluidArea,
		customFluidArea: { type: 'string', nullable: true },
		front: { ...consumableAxleSchema, nullable: true },
		rear: { ...consumableAxleSchema, nullable: true },
		cost: { type: 'number', minimum: 0, nullable: true },
		currency: { type: 'string', pattern: '^[A-Za-z]{3}$', nullable: true },
	},
};
Object.assign(consumablePaths, {
	'/api/v1/consumable-maintenance': {
		get: {
			summary:
				"List consumable maintenance history across the authenticated owner's cars",
			responses: {
				200: { description: 'Owner-scoped consumable maintenance history' },
				401: { description: 'Authentication required' },
			},
		},
	},
	'/api/v1/consumables/report': {
		get: {
			summary:
				"Report consumable history and spend across the authenticated owner's cars",
			responses: {
				200: { description: 'Owner-scoped consumable report' },
				401: { description: 'Authentication required' },
			},
		},
	},
	'/api/v1/cars/{carId}/consumables': {
		parameters: [carIdParameter],
		get: {
			summary: 'List active consumable maintenance history for an owned car',
			responses: {
				200: { description: 'Consumable history' },
				404: { description: 'Car not found' },
			},
		},
		post: {
			summary: 'Record an owned-car fluid or tire-set change',
			requestBody: {
				required: true,
				content: { 'application/json': { schema: consumableSchema } },
			},
			responses: {
				201: { description: 'Consumable entry created' },
				400: { description: 'Invalid consumable entry' },
				404: { description: 'Car not found' },
				409: { description: 'Car is archived' },
			},
		},
	},
	'/api/v1/cars/{carId}/consumables/prefill': {
		parameters: [carIdParameter],
		get: {
			summary:
				'Map tire details from the owned car current setup into front and rear axle values',
			responses: {
				200: { description: 'Setup tire prefill' },
				404: { description: 'Car not found' },
			},
		},
	},
	'/api/v1/cars/{carId}/consumables/report': {
		parameters: [carIdParameter],
		get: {
			summary:
				'Report owner-scoped tire replacement history, spend, and fluid changes',
			responses: {
				200: {
					description:
						'Historical consumable report without reminders or due dates',
				},
				404: { description: 'Car not found' },
			},
		},
	},
	'/api/v1/consumables/{entryId}': {
		patch: {
			summary: 'Edit an owned consumable maintenance entry',
			requestBody: {
				required: true,
				content: {
					'application/json': { schema: consumableUpdateSchema },
				},
			},
			responses: {
				200: { description: 'Consumable entry updated' },
				400: { description: 'Invalid update' },
				404: { description: 'Entry not found' },
				409: { description: 'Entry or car is archived' },
			},
		},
		get: {
			summary: 'Read an owned consumable maintenance entry',
			responses: {
				200: { description: 'Consumable entry' },
				404: { description: 'Entry not found' },
			},
		},
	},
	'/api/v1/consumables/{entryId}/archive': {
		post: {
			summary: 'Archive an owned consumable entry',
			responses: {
				200: { description: 'Entry archived' },
				404: { description: 'Entry not found' },
				409: { description: 'Invalid lifecycle transition' },
			},
		},
	},
	'/api/v1/consumables/{entryId}/restore': {
		post: {
			summary: 'Restore an archived owned consumable entry',
			responses: {
				200: { description: 'Entry restored' },
				404: { description: 'Entry not found' },
				409: { description: 'Invalid lifecycle transition' },
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

const invitePaths = openApi.paths as Record<string, unknown>;
invitePaths['/api/auth/register'] = {
	post: {
		summary: 'Reserve an invite code and send a first-registration magic link',
		requestBody: {
			required: true,
			content: {
				'application/json': {
					schema: {
						type: 'object',
						required: ['email', 'inviteCode'],
						properties: {
							email: { type: 'string', format: 'email' },
							inviteCode: { type: 'string', minLength: 6, maxLength: 32 },
							callbackURL: { type: 'string' },
						},
					},
				},
			},
		},
		responses: {
			200: { description: 'Neutral response whether registration is accepted' },
			429: {
				description: 'Too many registration attempts; retry after one minute',
				headers: {
					'Retry-After': {
						description: 'Seconds before retrying',
						schema: { type: 'integer' },
					},
				},
			},
		},
	},
};
invitePaths['/api/v1/invite-codes'] = {
	get: {
		summary: 'List the authenticated user invite-code history and allowance',
		responses: {
			200: { description: 'Invite-code history and remaining allowance' },
			401: { description: 'Authentication required' },
		},
	},
	post: {
		summary: 'Create an invite code for the authenticated user',
		requestBody: {
			required: true,
			content: {
				'application/json': {
					schema: {
						type: 'object',
						required: ['code'],
						properties: {
							code: { type: 'string', minLength: 6, maxLength: 32 },
						},
					},
				},
			},
		},
		responses: {
			201: { description: 'Invite code created' },
			400: { description: 'Invalid invite code' },
			409: { description: 'Code collision or lifetime allowance exhausted' },
		},
	},
};
invitePaths['/api/v1/invite-codes/{id}/revoke'] = {
	parameters: [
		{ name: 'id', in: 'path', required: true, schema: { type: 'string' } },
	],
	post: {
		summary: 'Permanently revoke an unused owned invite code',
		responses: {
			200: { description: 'Invite code revoked' },
			404: { description: 'Invite code not found or cannot be revoked' },
		},
	},
};

const voicePaths = openApi.paths as Record<string, unknown>;
const voiceUpdateIdParameter = {
	name: 'voiceUpdateId',
	in: 'path',
	required: true,
	schema: { type: 'string', format: 'uuid' },
};
voicePaths['/api/v1/cars/{carId}/voice-updates'] = {
	parameters: [carIdParameter],
	get: {
		summary: 'List owner-scoped voice track notes for a car',
		responses: {
			200: { description: 'Voice updates and processing states' },
			404: { description: 'Car not found' },
		},
	},
	post: {
		summary: 'Store an idempotent private audio or text track note',
		requestBody: {
			required: true,
			content: {
				'multipart/form-data': {
					schema: {
						type: 'object',
						required: ['captureId', 'file'],
						properties: {
							captureId: { type: 'string', format: 'uuid' },
							driveSessionId: { type: 'string' },
							file: { type: 'string', format: 'binary' },
						},
					},
				},
				'application/json': {
					schema: {
						type: 'object',
						required: ['captureId', 'text'],
						properties: {
							captureId: { type: 'string', format: 'uuid' },
							text: { type: 'string', maxLength: 20000 },
							driveSessionId: { type: 'string', nullable: true },
						},
					},
				},
			},
		},
		responses: {
			201: { description: 'Private pending voice artifact created' },
			200: { description: 'Existing capture returned for idempotent retry' },
			400: { description: 'Invalid capture' },
			404: { description: 'Car or drive session not found' },
			409: { description: 'Archived car or capture collision' },
		},
	},
};
voicePaths['/api/v1/voice-updates/{voiceUpdateId}'] = {
	parameters: [voiceUpdateIdParameter],
	get: {
		summary: 'Read voice provenance and derived record links',
		responses: {
			200: { description: 'Owner-scoped voice update' },
			404: { description: 'Voice update not found' },
		},
	},
	patch: {
		summary: 'Correct a pending voice context or review draft',
		responses: {
			200: { description: 'Voice update corrected' },
			409: { description: 'Voice update is read-only' },
		},
	},
	delete: {
		summary:
			'Discard a pending capture or remove saved audio without deleting derived history',
		responses: {
			200: { description: 'Artifact policy applied' },
			409: { description: 'Archived provenance is read-only' },
		},
	},
};
voicePaths['/api/v1/voice-updates/{voiceUpdateId}/audio'] = {
	parameters: [voiceUpdateIdParameter],
	get: {
		summary: 'Stream an owner-scoped private original recording',
		responses: {
			200: { description: 'Private audio stream' },
			404: { description: 'Recording not found' },
		},
	},
};
voicePaths[
	'/api/v1/voice-updates/{voiceUpdateId}/corrections/{correctionId}/audio'
] = {
	parameters: [
		voiceUpdateIdParameter,
		{
			name: 'correctionId',
			in: 'path',
			required: true,
			schema: { type: 'string', format: 'uuid' },
		},
	],
	get: {
		summary: 'Stream an owner-scoped private voice correction recording',
		responses: {
			200: { description: 'Private correction audio stream' },
			404: { description: 'Correction recording not found' },
		},
	},
};
voicePaths['/api/v1/voice-updates/{voiceUpdateId}/process'] = {
	parameters: [voiceUpdateIdParameter],
	post: {
		summary: 'Transcribe and extract a review-only update draft',
		responses: {
			200: { description: 'Reviewable draft created' },
			202: { description: 'Already processing' },
			422: { description: 'Recording contains no detected speech' },
			502: { description: 'Retryable provider failure' },
		},
	},
};
voicePaths['/api/v1/voice-updates/{voiceUpdateId}/corrections'] = {
	parameters: [voiceUpdateIdParameter],
	post: {
		summary: 'Apply a short voice or text correction to a review draft',
		requestBody: {
			required: true,
			content: {
				'application/json': {
					schema: {
						type: 'object',
						required: ['text'],
						properties: {
							text: {
								type: 'string',
								minLength: 1,
								maxLength: VOICE_CORRECTION_MAX_LENGTH,
								description:
									'Text is limited to the review-note capacity so the full correction can be retained when AI processing fails.',
							},
						},
					},
				},
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
			200: { description: 'Corrected review draft' },
			400: {
				description: 'Correction exceeds the text or audio input limit',
			},
			409: { description: 'Draft is not reviewable' },
		},
	},
};
voicePaths['/api/v1/voice-updates/{voiceUpdateId}/confirm'] = {
	parameters: [voiceUpdateIdParameter],
	post: {
		summary: 'Idempotently save confirmed facts to immutable garage history',
		responses: {
			200: { description: 'Voice update and created record links' },
			409: { description: 'Unresolved facts still require an explicit choice' },
		},
	},
};
voicePaths['/api/v1/voice-updates/{voiceUpdateId}/results'] = {
	parameters: [voiceUpdateIdParameter],
	get: {
		summary: 'Read voice provenance and created record links',
		responses: {
			200: { description: 'Voice update result provenance' },
			404: { description: 'Voice update not found' },
		},
	},
};

const trackMapPaths = openApi.paths as Record<string, unknown>;
trackMapPaths['/api/v1/track-layouts'] = {
	get: {
		summary: 'List Track layouts visible to the authenticated user',
		responses: { 200: { description: 'Track layouts and version summaries' } },
	},
	post: {
		summary: 'Owner-only create a Track layout',
		requestBody: {
			required: true,
			content: {
				'application/json': {
					schema: {
						type: 'object',
						required: ['name'],
						properties: { name: { type: 'string', maxLength: 160 } },
					},
				},
			},
		},
		responses: {
			201: { description: 'Track layout created' },
			400: { description: 'Invalid name' },
			409: { description: 'Duplicate name' },
		},
	},
};
trackMapPaths['/api/v1/track-layouts/{layoutId}'] = {
	patch: {
		summary: 'Owner-only rename a Track layout',
		requestBody: {
			required: true,
			content: {
				'application/json': {
					schema: {
						type: 'object',
						required: ['name'],
						properties: { name: { type: 'string' } },
					},
				},
			},
		},
		responses: {
			200: { description: 'Track layout renamed' },
			404: { description: 'Track layout not found' },
			409: { description: 'Duplicate name' },
		},
	},
};
trackMapPaths['/api/v1/track-layouts/{layoutId}/retire'] = {
	post: {
		summary: 'Owner-only retire a Track layout',
		responses: {
			200: { description: 'Track layout retired' },
			404: { description: 'Track layout not found' },
		},
	},
};
trackMapPaths['/api/v1/track-layouts/{layoutId}/map-versions'] = {
	post: {
		summary: 'Owner-only create or clone a draft Track map version',
		responses: {
			201: { description: 'Draft Track map created' },
			404: { description: 'Layout or source map not found' },
		},
	},
};
trackMapPaths['/api/v1/track-layouts/{layoutId}/map-versions/{versionId}'] = {
	get: {
		summary: 'Owner-only read a Track map version and corners',
		responses: {
			200: { description: 'Track map geometry' },
			404: { description: 'Track map not found' },
		},
	},
};
trackMapPaths['/api/v1/track-map-versions/{versionId}'] = {
	get: {
		summary: 'Owner-only read a Track map version and corners',
		responses: {
			200: { description: 'Track map geometry' },
			404: { description: 'Track map not found' },
		},
	},
	patch: {
		summary: 'Owner-only replace draft Track map corners',
		responses: {
			200: { description: 'Draft geometry saved' },
			400: { description: 'Invalid or degenerate geometry' },
			409: { description: 'Only drafts are editable' },
			404: { description: 'Track map not found' },
		},
	},
};
