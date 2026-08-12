import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { diagnoseWorkerd6793 } from './workerd-6793';

const port = Number.parseInt(process.env.RC_MECH_ISSUE_230_PORT ?? '8792', 10);
if (!Number.isInteger(port) || port < 1 || port > 65_535)
	throw new Error('RC_MECH_ISSUE_230_PORT must be a valid TCP port');

const baseUrl = `http://127.0.0.1:${port}`;
const token = `issue-230-token-${process.pid}-${crypto.randomUUID()}`;
const stateDirectory = await mkdtemp(join(tmpdir(), 'rc-mech-issue-230-'));
let worker: ChildProcess | undefined;
let workerLog = '';

const command = async (executable: string, args: readonly string[]) => {
	const child = spawn(executable, args, {
		cwd: process.cwd(),
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	let output = '';
	child.stdout.on('data', (chunk: Buffer) => {
		output += chunk.toString();
	});
	child.stderr.on('data', (chunk: Buffer) => {
		output += chunk.toString();
	});
	const exitCode = await new Promise<number | null>((resolve, reject) => {
		child.once('error', reject);
		child.once('close', resolve);
	});
	if (exitCode !== 0)
		throw new Error(
			`${executable} ${args.join(' ')} failed with exit code ${exitCode}\n${output}`,
		);
	return output;
};

const fetchWithTimeout = async (
	input: string,
	init?: RequestInit,
	timeoutMs = 60_000,
): Promise<Response> =>
	fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });

const isHealthy = async (): Promise<boolean> => {
	try {
		return (
			await fetchWithTimeout(`${baseUrl}/api/v1/health`, undefined, 2_000)
		).ok;
	} catch {
		return false;
	}
};

const waitForWorker = async (): Promise<void> => {
	for (let attempt = 0; attempt < 240; attempt += 1) {
		if (
			workerLog.includes(`Ready on http://localhost:${port}`) &&
			(await isHealthy())
		)
			return;
		if (worker?.exitCode !== null)
			throw new Error(`Wrangler exited before becoming ready\n${workerLog}`);
		await delay(250);
	}
	throw new Error(`Wrangler did not become ready\n${workerLog}`);
};

const stopWorker = async (): Promise<void> => {
	if (!worker?.pid || worker.exitCode !== null) return;
	try {
		process.kill(-worker.pid, 'SIGTERM');
	} catch {
		worker.kill('SIGTERM');
	}
	await Promise.race([
		new Promise<void>((resolve) => worker?.once('close', () => resolve())),
		delay(5_000),
	]);
	if (worker.exitCode === null) {
		try {
			process.kill(-worker.pid, 'SIGKILL');
		} catch {
			worker.kill('SIGKILL');
		}
	}
};

const postJson = (
	path: string,
	body: Readonly<Record<string, unknown>>,
	cookie?: string,
) =>
	fetchWithTimeout(`${baseUrl}${path}`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			origin: baseUrl,
			...(cookie ? { cookie } : {}),
		},
		body: JSON.stringify(body),
	});

const requireStatus = async (
	response: Response,
	status: number,
	operation: string,
) => {
	if (response.status !== status) {
		const details = await response.clone().text();
		throw new Error(
			`${operation} returned ${response.status}, expected ${status}: ${details}`,
		);
	}
};

const roundTripResult = z
	.object({
		contractVersion: z.literal('issue-230.round-trip.v1'),
		correlationId: z.string().uuid(),
		transformedValue: z.string(),
		container: z
			.object({
				instance: z.literal('issue-230-round-trip'),
				stateBefore: z.string(),
				startupMs: z.number().int().nonnegative(),
				roundTripMs: z.number().int().nonnegative(),
			})
			.strict(),
	})
	.strict();

type RoundTripResult = z.infer<typeof roundTripResult>;

const roundTrip = async (value: string, cookie: string) => {
	const response = await postJson(
		'/api/v1/prototypes/python-round-trip',
		{ value },
		cookie,
	);
	await requireStatus(response, 200, `round trip for ${value}`);
	const envelope = z
		.object({ result: roundTripResult })
		.strict()
		.parse(await response.json());
	const expected = `python:${value.toUpperCase()}`;
	if (envelope.result.transformedValue !== expected)
		throw new Error(
			`round trip returned ${envelope.result.transformedValue}, expected ${expected}`,
		);
	return envelope.result;
};

const waitForWorkerEvidence = async (
	correlationId: string,
): Promise<string[]> => {
	const expectedEvents = [
		'issue230.worker.request',
		'issue230.container.ready',
		'issue230.worker.response',
	] as const;
	for (let attempt = 0; attempt < 40; attempt += 1) {
		const lines = workerLog
			.split('\n')
			.filter((line) => line.includes(correlationId));
		if (
			expectedEvents.every((event) =>
				lines.some((line) => line.includes(event)),
			)
		)
			return lines;
		await delay(250);
	}
	throw new Error(
		`Missing Worker correlation evidence for ${correlationId}\n${workerLog}`,
	);
};

const readContainerLogs = async (): Promise<string> => {
	const containerIds = (
		await command('docker', [
			'ps',
			'-aq',
			'--filter',
			'name=workerd-rc-mech-local-Issue230PythonContainer',
		])
	)
		.trim()
		.split('\n')
		.filter(Boolean);
	const logs: string[] = [];
	for (const containerId of containerIds) {
		logs.push(await command('docker', ['logs', containerId]));
	}
	return logs.join('\n');
};

const waitForPythonEvidence = async (
	correlationId: string,
): Promise<string> => {
	for (let attempt = 0; attempt < 40; attempt += 1) {
		const matchingLine = (await readContainerLogs())
			.split('\n')
			.find(
				(line) =>
					line.includes('issue230.python.received') &&
					line.includes(correlationId),
			);
		if (matchingLine) return matchingLine;
		await delay(250);
	}
	throw new Error(`Missing Python correlation evidence for ${correlationId}`);
};

const readContainerDiagnostics = async (): Promise<string> => {
	try {
		return await readContainerLogs();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
};

try {
	await command('docker', ['info']);
	if (await isHealthy()) throw new Error(`port ${port} is already in use`);

	await command('pnpm', [
		'exec',
		'wrangler',
		'd1',
		'migrations',
		'apply',
		'DB',
		'--local',
		'--env',
		'local',
		'--persist-to',
		stateDirectory,
	]);

	worker = spawn(
		'pnpm',
		[
			'exec',
			'wrangler',
			'dev',
			'--env',
			'local',
			'--local',
			'--port',
			String(port),
			'--persist-to',
			stateDirectory,
			'--var',
			`APP_URL:${baseUrl}`,
			'--var',
			'OWNER_EMAIL:owner@example.com',
			'--var',
			`MAGIC_LINK_TEST_TOKEN:${token}`,
		],
		{
			cwd: process.cwd(),
			detached: true,
			stdio: ['ignore', 'pipe', 'pipe'],
		},
	);
	const recordLog = (chunk: Buffer) => {
		workerLog += chunk.toString();
	};
	worker.stdout?.on('data', recordLog);
	worker.stderr?.on('data', recordLog);
	await waitForWorker();

	const unauthenticated = await postJson(
		'/api/v1/prototypes/python-round-trip',
		{ value: 'trackside' },
	);
	await requireStatus(unauthenticated, 401, 'unauthenticated round trip');

	const magicLinkRequest = await postJson('/api/auth/sign-in/magic-link', {
		email: 'owner@example.com',
		callbackURL: '/',
	});
	await requireStatus(magicLinkRequest, 200, 'magic-link request');

	const verification = await fetchWithTimeout(
		`${baseUrl}/api/auth/magic-link/verify?token=${encodeURIComponent(token)}&callbackURL=%2F`,
		{ headers: { origin: baseUrl }, redirect: 'manual' },
		5_000,
	);
	await requireStatus(verification, 302, 'magic-link verification');
	const cookie = verification.headers
		.getSetCookie()
		.map((header) => header.split(';', 1)[0])
		.join('; ');
	if (!cookie)
		throw new Error('magic-link verification did not return a session cookie');

	const cold = await roundTrip('trackside', cookie);
	const pythonEvidence = await waitForPythonEvidence(cold.correlationId);
	const warm = await roundTrip('pitlane', cookie);
	await delay(12_000);
	const afterSleep = await roundTrip('racebench', cookie);
	const evidence = [
		...(await waitForWorkerEvidence(cold.correlationId)),
		pythonEvidence,
	];

	const proof: {
		verdict: 'PASS';
		unauthenticatedStatus: number;
		cold: RoundTripResult;
		warm: RoundTripResult;
		afterSleep: RoundTripResult;
		correlationEvidence: string[];
	} = {
		verdict: 'PASS',
		unauthenticatedStatus: unauthenticated.status,
		cold,
		warm,
		afterSleep,
		correlationEvidence: evidence,
	};
	console.log(JSON.stringify(proof, null, 2));
} catch (error) {
	const errorMessage = error instanceof Error ? error.message : String(error);
	const kernelRelease = await readFile(
		'/proc/sys/kernel/osrelease',
		'utf8',
	).catch(() => '');
	const containerDiagnostics = await readContainerDiagnostics();
	console.error(
		JSON.stringify(
			{
				verdict: 'FAIL',
				error: errorMessage,
				knownIssue: diagnoseWorkerd6793({
					error: errorMessage,
					kernelRelease,
					workerLog,
				}),
				workerLog,
				containerDiagnostics,
			},
			null,
			2,
		),
	);
	process.exitCode = 1;
} finally {
	await stopWorker();
	await rm(stateDirectory, { force: true, recursive: true });
}
