import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { type Db, openDb } from '../src/db';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../drizzle', import.meta.url));

export function testDb(): Db {
  return openDb(':memory:', MIGRATIONS_DIR);
}

export const silentLogger = pino({ level: 'silent' });

export async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 3000): Promise<NonNullable<T>> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value as NonNullable<T>;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: Zeitüberschreitung');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
