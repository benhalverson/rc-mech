#!/usr/bin/env node

import { Command } from 'commander';
import { validateInviteCode } from '../src/invite-policy';

const program = new Command()
	.name('rc-mech-invite')
	.description('Seed an invite through the authenticated RC Mech API')
	.requiredOption('--url <url>', 'Worker origin')
	.requiredOption('--owner-email <email>', 'Owner email address')
	.requiredOption('--code <code>', 'Invite code')
	.option(
		'--token <token>',
		'Deterministic local magic-link token',
		'local-test-token',
	)
	.parse();

const options = program.opts<{
	url: string;
	ownerEmail: string;
	code: string;
	token: string;
}>();
const parsed = validateInviteCode(options.code);
if (!parsed.ok) throw new Error(parsed.reason);
const base = options.url.replace(/\/$/, '');

const cookieFrom = (response: Response): string => {
	const cookies = response.headers.getSetCookie?.() ?? [];
	const cookie = cookies[0]?.split(';', 1)[0];
	if (!cookie)
		throw new Error('The authentication response did not set a session cookie');
	return cookie;
};

const request = await fetch(`${base}/api/auth/sign-in/magic-link`, {
	method: 'POST',
	headers: { 'content-type': 'application/json', origin: base },
	body: JSON.stringify({
		email: options.ownerEmail,
		callbackURL: `${base}/settings`,
	}),
});
if (!request.ok)
	throw new Error(`Owner magic-link request failed (${request.status})`);

const verify = await fetch(
	`${base}/api/auth/magic-link/verify?token=${encodeURIComponent(options.token)}&callbackURL=%2Fsettings`,
	{ redirect: 'manual' },
);
if (verify.status !== 302)
	throw new Error(`Owner magic-link verification failed (${verify.status})`);
const cookie = cookieFrom(verify);

const create = await fetch(`${base}/api/v1/invite-codes`, {
	method: 'POST',
	headers: { 'content-type': 'application/json', cookie },
	body: JSON.stringify({ code: parsed.code }),
});
if (!create.ok)
	throw new Error(
		`Invite creation failed (${create.status}): ${await create.text()}`,
	);
console.log(JSON.stringify({ invite: await create.json(), cookie }));
