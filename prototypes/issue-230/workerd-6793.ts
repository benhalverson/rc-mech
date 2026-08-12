export const WORKERD_6793_ISSUE_URL =
	'https://github.com/cloudflare/workerd/issues/6793';
export const WORKERD_6794_PULL_REQUEST_URL =
	'https://github.com/cloudflare/workerd/pull/6794';

const sidecarNameSuffix = '-proxy';
const containerIdPattern = /^[0-9a-f]{12,64}$/;

export const isWsl2KernelRelease = (kernelRelease: string): boolean =>
	/microsoft-standard-wsl2/i.test(kernelRelease);

export const parseDockerBridgeSubnet = (output: string): string => {
	const subnet = output.trim();
	const [address, prefix, ...extra] = subnet.split('/');
	const octetText = address?.split('.');
	const octets = octetText?.map((octet) => Number(octet));
	const prefixLength = Number(prefix);
	const isValid =
		extra.length === 0 &&
		octetText?.every((octet) => /^\d{1,3}$/.test(octet)) &&
		octets?.length === 4 &&
		octets.every(
			(octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255,
		) &&
		prefix !== undefined &&
		/^\d{1,2}$/.test(prefix) &&
		Number.isInteger(prefixLength) &&
		prefixLength >= 0 &&
		prefixLength <= 32;
	if (!isValid)
		throw new Error(`Docker bridge returned an invalid IPv4 subnet: ${subnet}`);
	return subnet;
};

export const findCloudflareProxySidecarIds = (
	containerList: string,
): readonly string[] => {
	const containerIds = containerList
		.trim()
		.split('\n')
		.filter(Boolean)
		.map((line) => line.trim().split(/\s+/, 2))
		.filter((fields) => fields[1]?.endsWith(sidecarNameSuffix))
		.map((fields) => fields[0]);
	for (const containerId of containerIds) {
		if (containerId === undefined || !containerIdPattern.test(containerId))
			throw new Error(
				`Docker returned an invalid sidecar container ID: ${containerId}`,
			);
	}
	return containerIds;
};

export const bridgeBypassRule = (subnet: string): string =>
	`-A PREROUTING -s ${subnet} -d ${subnet} -j RETURN`;

export const isBridgeBypassFirst = (
	iptablesRules: string,
	subnet: string,
): boolean =>
	iptablesRules.split('\n').find((line) => line.startsWith('-A PREROUTING')) ===
	bridgeBypassRule(subnet);

export const hasSocketDivertRule = (iptablesRules: string): boolean =>
	iptablesRules
		.split('\n')
		.includes('-A PREROUTING -p tcp -m socket -j DIVERT');

type Workerd6793DiagnosisInput = {
	readonly error: string;
	readonly kernelRelease: string;
	readonly workerLog: string;
};

export const diagnoseWorkerd6793 = ({
	error,
	kernelRelease,
	workerLog,
}: Workerd6793DiagnosisInput) => {
	const evidence = `${error}\n${workerLog}`;
	if (
		!isWsl2KernelRelease(kernelRelease) ||
		!evidence.includes('CONTAINER_UNAVAILABLE') ||
		!evidence.includes('kj/timer.c++:30: overloaded: operation timed out') ||
		!evidence.includes('Container failed to start')
	)
		return undefined;

	return {
		code: 'CLOUDFLARE_WORKERD_6793',
		message:
			'Known Cloudflare local Container sidecar TPROXY rule-ordering failure on WSL2.',
		nextStep:
			'Start `pnpm prototype:230:wsl-workaround` in another terminal, leave it watching, then rerun `pnpm prototype:230:prove` and stop the watcher only after the proof finishes.',
		issue: WORKERD_6793_ISSUE_URL,
		pullRequest: WORKERD_6794_PULL_REQUEST_URL,
	} as const;
};
