import { z } from 'zod';

export const schemaValidator = {
  /** Validar objeto contra schema */
  validate: <T>(schema: z.ZodSchema<T>, data: unknown): { success: boolean; data: T; error: string } => {
    const result = schema.safeParse(data);
    if (result.success) {
      return { success: true, data: result.data, error: '' };
    }
    return { success: false, data: null as any, error: result.error.message };
  },

  /** Validar parâmetros de query */
  validateQuery: <T extends z.ZodSchema>(schema: T, query: Record<string, string>) => {
    return schemaValidator.validate<T>(schema, query);
  },

  /** Validar body da requisição */
  validateBody: <T extends z.ZodSchema>(schema: T, body: unknown) => {
    return schemaValidator.validate<T>(schema, body);
  },
};
