import { z } from 'zod';

export const broadcastSchema = z.object({
  sessionId: z.string().nonempty(),
  text: z.string().nonempty(),
  contactIds: z.array(z.string()).optional(),
  type: z.enum(['text', 'image', 'document']).optional(),
});

export const authSchema = z.object({
  apiKey: z.string().nonempty(),
});

export function validateBroadcast(body: unknown) {
  return broadcastSchema.safeParse(body);
}

export function validateAuth(body: unknown) {
  return authSchema.safeParse(body);
}
