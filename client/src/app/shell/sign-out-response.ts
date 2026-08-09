import { literal, object } from 'zod/mini';
import type * as z from 'zod/mini';
import { InvalidSignOutResponse } from './sign-out-contract';

const signOutResponseSchema = object({ success: literal(true) });

export type SignOutResponse = z.infer<typeof signOutResponseSchema>;

export const parseSignOutResponse = (value: unknown): SignOutResponse => {
	const parsed = signOutResponseSchema.safeParse(value);
	if (!parsed.success) throw new InvalidSignOutResponse();
	return parsed.data;
};
