import { prisma } from '../lib/prisma';
import { authAdapter } from '../adapters/auth/auth';

export interface IntegrationConfig {
  name: string;
  type: 'api' | 'webhook' | 'file';
  endpoint: string;
  authMethod: 'apiKey' | 'oauth' | 'none';
  isActive: boolean;
  frequency?: string;
}

/** Registrar nova integração */
export async function registerIntegration(data: IntegrationConfig) {
  return prisma.integration.create({
    data: {
      name: data.name,
      type: data.type,
      endpoint: data.endpoint,
      authMethod: data.authMethod,
      isActive: data.isActive,
      frequency: data.frequency,
    },
  });
}

/** Listar integrações ativas */
export async function listIntegrations() {
  return prisma.integration.findMany({ where: { isActive: true } });
}

/** Atualizar integração */
export async function updateIntegration(id: string, data: Partial<IntegrationConfig>) {
  return prisma.integration.update({ where: { id }, data });
}

/** Remover integração */
export async function removeIntegration(id: string) {
  return prisma.integration.delete({ where: { id } });
}
