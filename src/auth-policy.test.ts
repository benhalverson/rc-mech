import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createEmailSender } from './email.ts';
import {
	hasEmailDelivery,
	hasMagicLinkConfiguration,
	isAllowedOrigin,
	isConfiguredOwner,
	isLocalDevelopment,
	normalizeEmail,
} from './auth-policy.ts';

test('owner matching is case-insensitive and trims whitespace', () => {
	assert.equal(normalizeEmail('  Owner@Example.com '), 'owner@example.com');
	assert.equal(
		isConfiguredOwner(' Owner@Example.com ', {
			OWNER_EMAIL: 'owner@example.com',
		}),
		true,
	);
});

test('missing or different owner addresses are not allowed', () => {
	assert.equal(isConfiguredOwner('owner@example.com', {}), false);
	assert.equal(
		isConfiguredOwner('other@example.com', {
			OWNER_EMAIL: 'owner@example.com',
		}),
		false,
	);
});

test('deployed magic-link configuration fails closed when delivery is unavailable', () => {
	const deployed = {
		APP_URL: 'https://garage.example',
		OWNER_EMAIL: 'owner@example.com',
		EMAIL_FROM: 'noreply@example.com',
	};
	assert.equal(isLocalDevelopment(deployed), false);
	assert.equal(hasMagicLinkConfiguration(deployed), true);
	assert.equal(hasEmailDelivery(deployed), false);
	assert.equal(
		hasMagicLinkConfiguration({
			APP_URL: 'https://garage.example',
			OWNER_EMAIL: 'owner@example.com',
		}),
		false,
	);
});

test('local configuration permits the deliberate no-op seam even with a simulated binding', async () => {
	let attempted = false;
	const local = {
		APP_URL: 'http://localhost:8787',
		ENVIRONMENT: 'local',
		OWNER_EMAIL: 'owner@example.com',
		EMAIL: {
			send: async () => {
				attempted = true;
			},
		},
	};
	assert.equal(isLocalDevelopment(local), true);
	const sender = createEmailSender(local as unknown as Env);
	assert.equal(sender.available, false);
	await sender.send({
		from: 'from@example.com',
		to: 'to@example.com',
		subject: 'Subject',
		text: 'Body',
	});
	assert.equal(attempted, false);
});

test('credentialed CORS accepts only the Angular dev server matching the WebAuthn RP host', () => {
	assert.equal(
		isAllowedOrigin('https://garage.example', 'https://garage.example'),
		true,
	);
	assert.equal(
		isAllowedOrigin('https://attacker.example', 'https://garage.example'),
		false,
	);
	assert.equal(
		isAllowedOrigin('http://localhost:4200', {
			APP_URL: 'http://localhost:8787',
			ENVIRONMENT: 'local',
		}),
		true,
	);
	assert.equal(
		isAllowedOrigin('http://127.0.0.1:4200', {
			APP_URL: 'http://localhost:8787',
			ENVIRONMENT: 'local',
		}),
		false,
	);
	assert.equal(
		isAllowedOrigin('http://127.0.0.1:4200', {
			APP_URL: 'http://127.0.0.1:8787',
			ENVIRONMENT: 'local',
		}),
		true,
	);
	assert.equal(isLocalDevelopment({ APP_URL: 'http://localhost:8787' }), false);
	assert.equal(
		isAllowedOrigin('http://localhost:4200', {
			APP_URL: 'http://localhost:8787',
			ENVIRONMENT: 'production',
		}),
		false,
	);
});

test('email sender forwards the structured message to the binding', async () => {
	let sent: object | undefined;
	const sender = createEmailSender({
		EMAIL: {
			send: async (message: unknown) => {
				sent = message as object;
			},
		},
	} as unknown as Env);
	assert.equal(sender.available, true);
	await sender.send({
		from: 'from@example.com',
		to: 'to@example.com',
		subject: 'Subject',
		text: 'Body',
	});
	assert.deepEqual(sent, {
		from: 'from@example.com',
		to: 'to@example.com',
		subject: 'Subject',
		text: 'Body',
	});
});
