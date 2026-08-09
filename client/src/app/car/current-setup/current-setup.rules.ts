import {
	currentSetupSectionKeys,
	type CurrentSetupChange,
	type CurrentSetupReadoutRow,
	type CurrentSetupSectionKey,
	type CurrentSetupSnapshot,
} from './current-setup.models';

const NOT_RECORDED = 'Not recorded';

const sectionLabels: Record<CurrentSetupSectionKey, string> = {
	vehicle: 'Vehicle',
	drivetrain: 'Drivetrain',
	electronics: 'Electronics',
	tires: 'Tires',
	shocks: 'Shocks',
	frontSuspension: 'Front suspension',
	rearSuspension: 'Rear suspension',
	notes: 'Notes',
};

const contextLabels = {
	recordedAt: 'Date',
	track: 'Track',
	event: 'Event',
	surface: 'Surface',
	traction: 'Traction',
	moisture: 'Moisture',
	condition: 'Condition',
	temperature: 'Temperature',
} as const;

type SetupEntry = {
	readonly id: string;
	readonly section: CurrentSetupSectionKey;
	readonly field: string;
	readonly value: unknown;
};

type Alias = readonly [CurrentSetupSectionKey, readonly string[]];

const rideHeight: Alias = ['vehicle', ['rideHeight', 'chassisRideHeight']];
const frontCamber: Alias = ['frontSuspension', ['camber', 'frontCamber']];
const rearCamber: Alias = ['rearSuspension', ['camber', 'rearCamber']];
const frontToe: Alias = ['frontSuspension', ['toe', 'frontToe']];
const rearCBlock: Alias = [
	'rearSuspension',
	['cBlockPill', 'cBlockPillPosition', 'rearCBlockPill'],
];
const rearDBlock: Alias = [
	'rearSuspension',
	['dBlockPill', 'dBlockPillPosition', 'rearDBlockPill'],
];
const frontShockSpring: Alias = ['shocks', ['frontSpring', 'frontShockSpring']];
const frontShockOil: Alias = ['shocks', ['frontOil', 'frontShockOil']];
const rearShockSpring: Alias = ['shocks', ['rearSpring', 'rearShockSpring']];
const rearShockOil: Alias = ['shocks', ['rearOil', 'rearShockOil']];
const drivetrainConfiguration: Alias = [
	'drivetrain',
	['configuration', 'drivetrainConfiguration', 'driveType', 'layout'],
];
const gearDifferentialOil: Alias = [
	'drivetrain',
	['gearDifferentialOil', 'gearDiffOil', 'diffOil'],
];
const gearDifferentialHeight: Alias = [
	'drivetrain',
	['gearDifferentialHeight', 'gearDiffHeight', 'diffHeight'],
];
const frontDifferentialOil: Alias = [
	'drivetrain',
	['frontDifferentialOil', 'frontDiffOil'],
];
const centerDifferentialOil: Alias = [
	'drivetrain',
	['centerDifferentialOil', 'centerDiffOil'],
];
const rearDifferentialOil: Alias = [
	'drivetrain',
	['rearDifferentialOil', 'rearDiffOil'],
];
const centerDrive: Alias = [
	'drivetrain',
	['centerDrive', 'centerDriveConfiguration', 'centerSlipper'],
];

const fieldId = (section: CurrentSetupSectionKey, field: string): string =>
	`${section}.${field}`;

const isMissing = (value: unknown): boolean =>
	value === null || value === undefined || value === '';

export const displaySetupValue = (value: unknown): string => {
	if (isMissing(value)) return NOT_RECORDED;
	if (typeof value === 'string') return value;
	if (
		typeof value === 'number' ||
		typeof value === 'boolean' ||
		typeof value === 'bigint'
	)
		return String(value);
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
};

export const setupFieldLabel = (field: string): string =>
	field
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/[_-]+/g, ' ')
		.replace(/^./, (character) => character.toUpperCase());

const findEntry = (
	setup: CurrentSetupSnapshot,
	[section, aliases]: Alias,
): SetupEntry | null => {
	for (const field of aliases) {
		if (Object.hasOwn(setup.sections[section], field))
			return {
				id: fieldId(section, field),
				section,
				field,
				value: setup.sections[section][field],
			};
	}
	return null;
};

const entryValue = (entry: SetupEntry | null): string =>
	displaySetupValue(entry?.value);

const recordConsumed = (
	consumed: Set<string>,
	...entries: Array<SetupEntry | null>
): void => {
	for (const entry of entries) if (entry) consumed.add(entry.id);
};

const drivetrainRows = (
	setup: CurrentSetupSnapshot,
	consumed: Set<string>,
): CurrentSetupReadoutRow[] => {
	const configuration = findEntry(setup, drivetrainConfiguration);
	const gearOil = findEntry(setup, gearDifferentialOil);
	const gearHeight = findEntry(setup, gearDifferentialHeight);
	const frontOil = findEntry(setup, frontDifferentialOil);
	const centerOil = findEntry(setup, centerDifferentialOil);
	const rearOil = findEntry(setup, rearDifferentialOil);
	const drive = findEntry(setup, centerDrive);
	const configurationText = isMissing(configuration?.value)
		? ''
		: displaySetupValue(configuration?.value);
	const driveText = isMissing(drive?.value)
		? ''
		: displaySetupValue(drive?.value);
	const isFourWheel = /(?:\b4\s*wd\b|four[ -]?wheel)/i.test(configurationText);
	const isTwoWheel = /(?:\b2\s*wd\b|two[ -]?wheel)/i.test(configurationText);
	const decoupledCenter =
		/decoupled/i.test(driveText) &&
		(drive?.field === 'centerSlipper' || /slipper/i.test(driveText));
	const rows: CurrentSetupReadoutRow[] = [];
	const add = (id: string, label: string, entry: SetupEntry | null): void => {
		rows.push({ id, label, value: entryValue(entry) });
		recordConsumed(consumed, entry);
	};

	if (configuration)
		add('drivetrain-configuration', 'Drivetrain configuration', configuration);
	if (isFourWheel) {
		add('front-differential-oil', 'Front differential oil', frontOil);
		if (decoupledCenter) add('center-drive', 'Center drive', drive);
		else add('center-differential-oil', 'Center differential oil', centerOil);
		add('rear-differential-oil', 'Rear differential oil', rearOil);
	} else if (isTwoWheel) {
		add('gear-differential-oil', 'Gear differential oil', gearOil);
		add('gear-differential-height', 'Gear differential height', gearHeight);
	} else {
		for (const [id, label, entry] of [
			['gear-differential-oil', 'Gear differential oil', gearOil],
			['gear-differential-height', 'Gear differential height', gearHeight],
			['front-differential-oil', 'Front differential oil', frontOil],
			['center-differential-oil', 'Center differential oil', centerOil],
			['rear-differential-oil', 'Rear differential oil', rearOil],
			['center-drive', 'Center drive', drive],
		] as const) {
			if (!entry || isMissing(entry.value)) continue;
			add(id, label, entry);
		}
	}

	return rows.length
		? rows
		: [{ id: 'drivetrain', label: 'Drivetrain', value: NOT_RECORDED }];
};

export const currentSetupPriorityRows = (
	setup: CurrentSetupSnapshot,
): CurrentSetupReadoutRow[] => {
	const consumed = new Set<string>();
	const ride = findEntry(setup, rideHeight);
	const frontCamberEntry = findEntry(setup, frontCamber);
	const rearCamberEntry = findEntry(setup, rearCamber);
	const frontToeEntry = findEntry(setup, frontToe);
	const cBlock = findEntry(setup, rearCBlock);
	const dBlock = findEntry(setup, rearDBlock);
	const frontSpring = findEntry(setup, frontShockSpring);
	const frontOil = findEntry(setup, frontShockOil);
	const rearSpring = findEntry(setup, rearShockSpring);
	const rearOil = findEntry(setup, rearShockOil);
	recordConsumed(
		consumed,
		ride,
		frontCamberEntry,
		rearCamberEntry,
		frontToeEntry,
		cBlock,
		dBlock,
		frontSpring,
		frontOil,
		rearSpring,
		rearOil,
	);
	return [
		{ id: 'ride-height', label: 'Ride height', value: entryValue(ride) },
		{
			id: 'camber',
			label: 'Camber · Front / Rear',
			value:
				!frontCamberEntry && !rearCamberEntry
					? NOT_RECORDED
					: `${entryValue(frontCamberEntry)} / ${entryValue(rearCamberEntry)}`,
		},
		{ id: 'front-toe', label: 'Front toe', value: entryValue(frontToeEntry) },
		{
			id: 'rear-toe',
			label: 'Rear toe · C / D Pill',
			value:
				!cBlock && !dBlock
					? NOT_RECORDED
					: `${entryValue(cBlock)} / ${entryValue(dBlock)}`,
		},
		{
			id: 'front-shock-spring',
			label: 'Front shock spring',
			value: entryValue(frontSpring),
		},
		{
			id: 'front-shock-oil',
			label: 'Front shock oil',
			value: entryValue(frontOil),
		},
		{
			id: 'rear-shock-spring',
			label: 'Rear shock spring',
			value: entryValue(rearSpring),
		},
		{
			id: 'rear-shock-oil',
			label: 'Rear shock oil',
			value: entryValue(rearOil),
		},
		...drivetrainRows(setup, consumed),
	];
};

const consumedPriorityIds = (setup: CurrentSetupSnapshot): Set<string> => {
	const consumed = new Set<string>();
	for (const alias of [
		rideHeight,
		frontCamber,
		rearCamber,
		frontToe,
		rearCBlock,
		rearDBlock,
		frontShockSpring,
		frontShockOil,
		rearShockSpring,
		rearShockOil,
	] as const)
		recordConsumed(consumed, findEntry(setup, alias));
	drivetrainRows(setup, consumed);
	return consumed;
};

export const currentSetupRemainingRows = (
	setup: CurrentSetupSnapshot,
): CurrentSetupReadoutRow[] => {
	const consumed = consumedPriorityIds(setup);
	return currentSetupSectionKeys.flatMap((section) =>
		Object.entries(setup.sections[section])
			.filter(([field]) => !consumed.has(fieldId(section, field)))
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([field, value]) => ({
				id: fieldId(section, field),
				label: `${sectionLabels[section]} · ${setupFieldLabel(field)}`,
				value: displaySetupValue(value),
			})),
	);
};

const flattenedSetup = (
	setup: CurrentSetupSnapshot,
): Map<string, { label: string; value: string }> => {
	const entries = new Map<string, { label: string; value: string }>();
	for (const [field, label] of Object.entries(contextLabels))
		entries.set(`context.${field}`, {
			label,
			value: displaySetupValue(
				setup.context[field as keyof typeof setup.context],
			),
		});
	for (const section of currentSetupSectionKeys)
		for (const [field, value] of Object.entries(setup.sections[section]))
			entries.set(fieldId(section, field), {
				label: `${sectionLabels[section]} · ${setupFieldLabel(field)}`,
				value: displaySetupValue(value),
			});
	return entries;
};

export const changesFromPreviousSetup = (
	current: CurrentSetupSnapshot,
	setups: readonly CurrentSetupSnapshot[],
): CurrentSetupChange[] => {
	if (!current.copiedFromSetupId) return [];
	const previous = setups.find(
		(setup) => setup.id === current.copiedFromSetupId,
	);
	if (!previous) return [];
	const before = flattenedSetup(previous);
	const after = flattenedSetup(current);
	const entries = new Map(before);
	for (const [id, entry] of after) entries.set(id, entry);
	return [...entries.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.flatMap(([id, entry]) => {
			const previousValue = before.get(id)?.value ?? NOT_RECORDED;
			const currentValue = after.get(id)?.value ?? NOT_RECORDED;
			if (previousValue === currentValue) return [];
			return [
				{
					id,
					label: entry.label,
					previousValue,
					currentValue,
				},
			];
		});
};
