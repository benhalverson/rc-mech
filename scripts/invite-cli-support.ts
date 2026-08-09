export type InviteSeedResult = {
	readonly invite: unknown;
	readonly reused: boolean;
};

type InviteSeedRequests = {
	readonly code: string;
	readonly create: () => Promise<Response>;
	readonly list: () => Promise<Response>;
	readonly reuseExisting: boolean;
};

const availableOwnedInvite = (payload: unknown, code: string): unknown => {
	const codes =
		typeof payload === 'object' &&
		payload !== null &&
		'codes' in payload &&
		Array.isArray(payload.codes)
			? payload.codes
			: [];
	return codes.find(
		(candidate) =>
			typeof candidate === 'object' &&
			candidate !== null &&
			'code' in candidate &&
			candidate.code === code &&
			'status' in candidate &&
			candidate.status === 'available',
	);
};

export const createOrReuseInvite = async ({
	code,
	create,
	list,
	reuseExisting,
}: InviteSeedRequests): Promise<InviteSeedResult> => {
	const response = await create();
	if (response.ok)
		return { invite: await response.json(), reused: false } as const;

	const failure = await response.text();
	const creationError = `Invite creation failed (${response.status}): ${failure}`;
	if (response.status !== 409 || !reuseExisting) throw new Error(creationError);

	const lookup = await list();
	if (!lookup.ok)
		throw new Error(
			`Invite lookup failed (${lookup.status}): ${await lookup.text()}`,
		);
	const existing = availableOwnedInvite(await lookup.json(), code);
	if (!existing) throw new Error(creationError);
	return { invite: { code: existing }, reused: true } as const;
};
