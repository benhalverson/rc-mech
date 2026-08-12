import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import {
	findCloudflareProxySidecarIds,
	hasSocketDivertRule,
	isBridgeBypassFirst,
	isWsl2KernelRelease,
	parseDockerBridgeSubnet,
	WORKERD_6793_ISSUE_URL,
	WORKERD_6794_PULL_REQUEST_URL,
} from '../prototypes/issue-230/workerd-6793';

const sidecarNameFilter = 'name=workerd-rc-mech-local-Issue230PythonContainer';
const pollIntervalMs = 100;

type CommandResult = {
	readonly exitCode: number;
	readonly output: string;
};

const run = async (
	executable: string,
	args: readonly string[],
): Promise<CommandResult> => {
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
	const exitCode = await new Promise<number>((resolve, reject) => {
		child.once('error', reject);
		child.once('close', (code) => {
			if (code === null) reject(new Error(`${executable} exited by signal`));
			else resolve(code);
		});
	});
	return { exitCode, output };
};

const requireSuccess = async (executable: string, args: readonly string[]) => {
	const result = await run(executable, args);
	if (result.exitCode !== 0)
		throw new Error(
			`${executable} ${args.join(' ')} failed with exit code ${result.exitCode}\n${result.output}`,
		);
	return result.output;
};

const findSidecars = async (): Promise<readonly string[]> =>
	findCloudflareProxySidecarIds(
		await requireSuccess('docker', [
			'ps',
			'--filter',
			sidecarNameFilter,
			'--format',
			'{{.ID}} {{.Names}}',
		]),
	);

const kernelRelease = await readFile('/proc/sys/kernel/osrelease', 'utf8');
if (process.platform !== 'linux' || !isWsl2KernelRelease(kernelRelease))
	throw new Error('This temporary host workaround is restricted to WSL2.');

await requireSuccess('docker', ['info']);
const subnet = parseDockerBridgeSubnet(
	await requireSuccess('docker', [
		'network',
		'inspect',
		'bridge',
		'--format',
		'{{(index .IPAM.Config 0).Subnet}}',
	]),
);

console.error(
	'Watching issue #230 Cloudflare proxy sidecars. Start the proof in another terminal; leave this running until the proof finishes, then press Ctrl+C.',
);

let stopping = false;
process.once('SIGINT', () => {
	stopping = true;
});
process.once('SIGTERM', () => {
	stopping = true;
});

const verifiedSidecars = new Set<string>();

const readRules = async (sidecarId: string): Promise<string | undefined> => {
	const result = await run('docker', [
		'exec',
		sidecarId,
		'iptables',
		'-t',
		'mangle',
		'-S',
		'PREROUTING',
	]);
	return result.exitCode === 0 ? result.output : undefined;
};

const reconcileSidecar = async (sidecarId: string): Promise<void> => {
	const existingRules = await readRules(sidecarId);
	if (existingRules === undefined) return;
	let status: 'already-present' | 'inserted' = 'already-present';
	if (!isBridgeBypassFirst(existingRules, subnet)) {
		const insertion = await run('docker', [
			'exec',
			sidecarId,
			'iptables',
			'-t',
			'mangle',
			'-I',
			'PREROUTING',
			'1',
			'-s',
			subnet,
			'-d',
			subnet,
			'-j',
			'RETURN',
		]);
		if (insertion.exitCode !== 0) return;
		status = 'inserted';
	}

	const verifiedRules = await readRules(sidecarId);
	if (
		verifiedRules === undefined ||
		!isBridgeBypassFirst(verifiedRules, subnet) ||
		!hasSocketDivertRule(verifiedRules)
	)
		return;
	if (verifiedSidecars.has(sidecarId) && status === 'already-present') return;
	verifiedSidecars.add(sidecarId);
	console.log(
		JSON.stringify(
			{
				event: 'workerd-6793.sidecar-patched',
				status,
				sidecarId,
				subnet,
				rule: `iptables -t mangle -I PREROUTING 1 -s ${subnet} -d ${subnet} -j RETURN`,
				socketDivertPresent: true,
				temporaryUntil: WORKERD_6794_PULL_REQUEST_URL,
				upstreamIssue: WORKERD_6793_ISSUE_URL,
			},
			null,
			2,
		),
	);
};

while (!stopping) {
	for (const sidecarId of await findSidecars())
		await reconcileSidecar(sidecarId);
	await delay(pollIntervalMs);
}

console.error('Stopped watching Cloudflare proxy sidecars.');
