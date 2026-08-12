export const ISSUE_230_CONTRACT_VERSION = 'issue-230.round-trip.v1';
export const ISSUE_230_INSTANCE_NAME = 'issue-230-round-trip';

export type Issue230RoundTripCommand = {
	correlationId: string;
	value: string;
};

export type Issue230RoundTripResult = {
	stateBefore:
		| 'running'
		| 'stopping'
		| 'stopped'
		| 'healthy'
		| 'stopped_with_code';
	startupMs: number;
	roundTripMs: number;
	response: Response;
};

export const runIssue230ContainerRoundTrip = async (
	env: Env,
	command: Issue230RoundTripCommand,
): Promise<Issue230RoundTripResult> => {
	const container = env.ISSUE_230_PYTHON_CONTAINER.getByName(
		ISSUE_230_INSTANCE_NAME,
	);
	const stateBefore = await container.getState();
	const roundTripStartedAt = performance.now();
	const startupStartedAt = performance.now();
	await container.startAndWaitForPorts();
	const startupMs = Math.round(performance.now() - startupStartedAt);
	console.log(
		JSON.stringify({
			event: 'issue230.container.ready',
			correlationId: command.correlationId,
			instance: ISSUE_230_INSTANCE_NAME,
			stateBefore: stateBefore.status,
			startupMs,
		}),
	);
	const response = await container.fetch(
		new Request('http://issue-230-python/v1/round-trip', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				contractVersion: ISSUE_230_CONTRACT_VERSION,
				correlationId: command.correlationId,
				value: command.value,
			}),
		}),
	);
	return {
		stateBefore: stateBefore.status,
		startupMs,
		roundTripMs: Math.round(performance.now() - roundTripStartedAt),
		response,
	};
};
