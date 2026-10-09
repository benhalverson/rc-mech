import type { SyncReview } from './offline-sync-review.models';
export type ReviewField = Readonly<{ label: string; value: string }>;
const hidden = new Set([
	'id',
	'revision',
	'url',
	'objectKey',
	'ownerKey',
	'carId',
	'operationId',
	'type',
	'base',
	'baseVersion',
	'baseCurrent',
	'version',
	'currentSetupVersion',
	'createdAt',
	'updatedAt',
	'sequence',
	'dependencies',
	'rawValues',
	'sourceMetadata',
]);
const label = (key: string): string =>
	key
		.replace(/Id$/, '')
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.replace(/^./, (value) => value.toUpperCase());
export const reviewFields = (
	value: unknown,
	names: Readonly<Record<string, string>>,
	prefix = '',
): readonly ReviewField[] => {
	if (value === null || value === undefined)
		return [{ label: prefix || 'Record', value: 'Not available' }];
	if (typeof value !== 'object')
		return [{ label: prefix || 'Value', value: String(value) }];
	return Object.entries(value)
		.filter(([key]) => !hidden.has(key))
		.flatMap(([key, item]) => {
			const name = prefix ? `${prefix} / ${label(key)}` : label(key);
			if (key.endsWith('Id'))
				return [
					{
						label: name,
						value:
							item === null
								? 'None'
								: (names[String(item)] ?? 'Unavailable record'),
					},
				];
			return reviewFields(item, names, name);
		});
};
export const deviceReviewValue = ({ operation }: SyncReview): unknown => {
	const command = operation.command;
	if (command.type === 'car.archive' || command.type === 'car.restore')
		return { status: command.type === 'car.archive' ? 'Archived' : 'Active' };
	if ('input' in command) return { action: command.action, ...command.input };
	if ('changes' in command) return command.changes;
	if ('car' in command) return command.car;
	if ('setup' in command) return command.setup;
	return command;
};
export const remoteReviewValue = (review: SyncReview): unknown => {
	const operation = review.operation;
	if (review.family === 'build')
		return review.operation.remote?.components.find(
			(value) =>
				value.id ===
				(review.operation.command.base?.id ??
					review.operation.command.componentId),
		);
	if (review.family === 'drive')
		return review.operation.remote?.sessions.find(
			(value) => value.id === review.operation.command.sessionId,
		);
	if (review.family === 'setup')
		return review.operation.remote
			? {
					setup: review.operation.remote.setup,
					currentSetupId: review.operation.remote.currentSetupId,
				}
			: undefined;
	if (review.family === 'maintenance') {
		const { command, remote } = review.operation;
		if (command.entity === 'plan')
			return remote?.plans.find((value) => value.id === command.planId);
		if (command.entity === 'service')
			return remote?.records.find((value) => value.id === command.recordId);
		return remote?.consumables?.find((value) => value.id === command.entryId);
	}
	return operation.remote;
};
export const reviewFeedback = (review: SyncReview): string =>
	typeof review.operation.feedback === 'string'
		? review.operation.feedback
		: (review.operation.feedback?.message ??
			'Review the device change before retrying.');
