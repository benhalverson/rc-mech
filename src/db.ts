import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';

export const db = (env: Pick<Env, 'DB'>) => drizzle(env.DB, { schema });
