import { literal, object } from 'zod/mini';
import {
	InvalidSignOutResponse,
	type SignOutResponse,
} from './sign-out-contract';

const signOutResponseSchema = object({ success: literal(true) });

export const parseSignOutResponse = (value: unknown): SignOutResponse => {
	const parsed = signOutResponseSchema.safeParse(value);
	if (!parsed.success) throw new InvalidSignOutResponse();
	return parsed.data;
};
