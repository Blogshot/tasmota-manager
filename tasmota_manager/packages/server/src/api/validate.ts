import type { ApiErrorBody } from '@tm/shared';
import type { FastifyReply } from 'fastify';
import { type ZodType, prettifyError } from 'zod';

export function parseBody<T>(schema: ZodType<T>, data: unknown, reply: FastifyReply): T | undefined {
  const result = schema.safeParse(data ?? {});
  if (result.success) return result.data;
  void reply.code(400).send({ code: 'validation', message: prettifyError(result.error) } satisfies ApiErrorBody);
  return undefined;
}

export const notFound = (what = 'Device'): ApiErrorBody => ({ code: 'not_found', message: `${what} not found` });
