#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';
import { Command } from 'commander';
import { validateInviteCode } from '../src/invite-policy';
import { createOrReuseInvite } from './invite-cli-support';

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
	.option(
		'--reuse-existing',
		'Reuse an available invite already owned by this local account',
	)
	.option(
		'--client-id <client-id>',
		'Local identity used to isolate authentication rate limits',
	)
	.option('--cookie-file <path>', 'Write the session cookie to this file')
	.parse();

const options = program.opts<{
	url: string;
	ownerEmail: string;
	code: string;
	token: string;
	reuseExisting?: boolean;
	clientId?: string;
	cookieFile?: string;
}>();
const parsed = validateInviteCode(options.code);
if (!parsed.ok) throw new Error(parsed.reason);
const base = options.url.replace(/\/$/, '');
const origin = new URL(base);
if (
	origin.protocol !== 'http:' ||
	!['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
)
	throw new Error('The invite CLI only accepts loopback HTTP URLs');

const cookieFrom = (response: Response): string => {
	const cookies = response.headers.getSetCookie?.() ?? [];
	const cookie = cookies[0]?.split(';', 1)[0];
	if (!cookie)
		throw new Error('The authentication response did not set a session cookie');
	return cookie;
};

const request = await fetch(`${base}/api/auth/sign-in/magic-link`, {
	method: 'POST',
	headers: {
		'content-type': 'application/json',
		origin: base,
		...(options.clientId ? { 'CF-Connecting-IP': options.clientId } : {}),
	},
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

const { invite, reused } = await createOrReuseInvite({
	code: parsed.code,
	create: () =>
		fetch(`${base}/api/v1/invite-codes`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie },
			body: JSON.stringify({ code: parsed.code }),
		}),
	list: () =>
		fetch(`${base}/api/v1/invite-codes`, {
			headers: { cookie },
		}),
	reuseExisting: options.reuseExisting ?? false,
});
if (options.cookieFile)
	await writeFile(options.cookieFile, `${cookie}\n`, { mode: 0o600 });
console.log(
	JSON.stringify({
		invite,
		...(reused ? { reused } : {}),
		...(options.cookieFile ? { cookieFile: options.cookieFile } : {}),
	}),
);
