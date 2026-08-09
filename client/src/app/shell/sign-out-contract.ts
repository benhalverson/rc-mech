export type SignOutResponse = { success: true };

export type SignOutGatewayFailure =
	| { kind: 'http'; status: number }
	| { kind: 'unavailable' }
	| { kind: 'invalid-response' };

export class InvalidSignOutResponse extends Error {}
