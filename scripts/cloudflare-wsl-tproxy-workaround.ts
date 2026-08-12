import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import {
	findCloudflareProxySidecarId,
	hasSocketDivertRule,
	isBridgeBypassFirst,
	isWsl2KernelRelease,
	parseDockerBridgeSubnet,
	WORKERD_6793_ISSUE_URL,
	WORKERD_6794_PULL_REQUEST_URL,
} from '../prototypes/issue-230/workerd-6793';

const sidecarNameFilter = 'name=workerd-rc-mech-local-Issue230PythonContainer';
const waitTimeoutMs = 120_000;

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

const findSidecar = async (): Promise<string | undefined> =>
	findCloudflareProxySidecarId(
		await requireSuccess('docker', [
			'ps',
			'--filter',
			sidecarNameFilter,
			'--format',
			'{{.ID}} {{.Names}}',
		]),
	);

const waitForSidecar = async (): Promise<string> => {
	const deadline = Date.now() + waitTimeoutMs;
	while (Date.now() < deadline) {
		const sidecarId = await findSidecar();
		if (sidecarId) return sidecarId;
		await delay(100);
	}
	throw new Error(
		'Cloudflare issue #230 proxy sidecar did not appear within 120 seconds. Start `pnpm prototype:230:prove` in another terminal while this command is waiting.',
	);
};

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
	'Waiting for the issue #230 Cloudflare proxy sidecar. Start the proof in another terminal.',
);
const sidecarId = await waitForSidecar();
const readRules = () =>
	requireSuccess('docker', [
		'exec',
		sidecarId,
		'iptables',
		'-t',
		'mangle',
		'-S',
		'PREROUTING',
	]);

const existingRules = await readRules();
let status: 'already-present' | 'inserted' = 'already-present';
if (!isBridgeBypassFirst(existingRules, subnet)) {
	await requireSuccess('docker', [
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
	status = 'inserted';
}

const verifiedRules = await readRules();
if (!isBridgeBypassFirst(verifiedRules, subnet))
	throw new Error(
		'The Docker bridge bypass was not the first PREROUTING rule.',
	);
if (!hasSocketDivertRule(verifiedRules))
	throw new Error(
		"Cloudflare's socket DIVERT rule is absent; this does not match workerd issue #6793.",
	);

console.log(
	JSON.stringify(
		{
			verdict: 'PASS',
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
