import { setupDraftFromSnapshot } from '../car/setups/setup-sync-rules';
import type { CarEditableField } from '../garage/car-sync/car-sync.models';
import type { ReviewOperation, SyncReview } from './offline-sync-review.models';

/** A resolution is a new command against exactly the remote evidence reviewed. */
export const retryReviewedOperation = (
	review: SyncReview,
	operationId: string,
): ReviewOperation => {
	const clean = {
		operationId,
		status: 'pending' as const,
		feedback: undefined,
		remote: undefined,
	};
	switch (review.family) {
		case 'car': {
			const { command, remote } = review.operation;
			if (!remote || command.type === 'car.create')
				return { ...review.operation, ...clean, command };
			const base =
				command.type === 'car.edit'
					? Object.fromEntries(
							Object.keys(command.changes).map((key) => [
								key,
								remote[key as CarEditableField] ?? null,
							]),
						)
					: { archivedAt: remote.archivedAt ?? null };
			return {
				...review.operation,
				...clean,
				command: { ...command, baseVersion: remote.version ?? 0, base },
			} as ReviewOperationsCar;
		}
		case 'setup': {
			const { command, remote } = review.operation;
			if (!remote) return { ...review.operation, ...clean, command };
			const selection = {
				setupId: remote.currentSetupId,
				version: remote.currentSetupVersion,
			};
			if (command.type === 'setup.correct') {
				if (!remote.setup)
					throw new Error(
						'The saved Setup no longer exists. Keep the saved version and create a new Setup.',
					);
				const draft = setupDraftFromSnapshot(remote.setup);
				return {
					...review.operation,
					...clean,
					command: {
						...command,
						baseVersion: remote.setup.version ?? 1,
						base: Object.fromEntries(
							Object.keys(command.base).map((key) => [
								key,
								draft[key as keyof typeof draft] ?? null,
							]),
						),
					},
				};
			}
			return {
				...review.operation,
				...clean,
				command: { ...command, baseCurrent: selection },
			};
		}
		case 'build': {
			const { command, remote } = review.operation;
			return {
				...review.operation,
				...clean,
				command: remote
					? {
							...command,
							baseVersion: remote.version,
							base:
								remote.components.find(
									(component) =>
										component.id === (command.base?.id ?? command.componentId),
								) ?? null,
						}
					: command,
			};
		}
		case 'drive': {
			const { command, remote } = review.operation;
			return {
				...review.operation,
				...clean,
				command: remote
					? {
							...command,
							baseVersion: remote.version,
							base:
								remote.sessions.find(
									(session) => session.id === command.sessionId,
								) ?? null,
						}
					: command,
			};
		}
		case 'maintenance': {
			const { command, remote } = review.operation;
			if (!remote) return { ...review.operation, ...clean, command };
			switch (command.entity) {
				case 'plan':
					return {
						...review.operation,
						...clean,
						command: {
							...command,
							baseVersion: remote.version,
							base:
								remote.plans.find((plan) => plan.id === command.planId) ?? null,
						},
					};
				case 'service':
					return {
						...review.operation,
						...clean,
						command: {
							...command,
							baseVersion: remote.version,
							planBase:
								remote.plans.find(
									(plan) =>
										plan.id === (command.planBase?.id ?? command.base?.planId),
								) ?? null,
							base:
								remote.records.find(
									(record) => record.id === command.recordId,
								) ?? null,
						},
					};
				default:
					return {
						...review.operation,
						...clean,
						command: {
							...command,
							baseVersion: remote.version,
							base:
								remote.consumables?.find(
									(entry) => entry.id === command.entryId,
								) ?? null,
						},
					};
			}
		}
		case 'settings': {
			const { command, remote } = review.operation;
			return {
				...review.operation,
				operationId,
				status: 'pending',
				feedback: undefined,
				remote: undefined,
				command:
					command.type === 'timezone' && remote !== undefined
						? { ...command, base: remote }
						: command,
			};
		}
	}
};
type ReviewOperationsCar =
	import('../garage/car-sync/car-sync.models').CarSyncOperation;
