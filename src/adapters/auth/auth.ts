import { prisma } from '../lib/prisma';
import { Request } from 'express';

export class AuthAdapter implements AuthPort {
  /** Validar API key do cabeçalho X-API-Key */
  async validateApiKey(apiKey: string): Promise<{ userId: string; role: string } | null> {
    if (!apiKey) return null;
    try {
      const user = await prisma.user.findUnique({
        where: { apiKey },
        select: { id: true, role: true }
      });
      if (!user) return null;
      return { userId: user.id, role: user.role };
    } catch (error) {
      return null;
    }
  }

  /** Obter usuário a partir de sessão ou API key */
  async getAuthenticatedUser(request?: Request): Promise<{ userId: string; role: string; authMethod: 'apiKey' | 'session' } | null> {
    if (request) {
      // Tentar API key primeiro
      const apiKey = request.headers.get('x-api-key');
      if (apiKey) {
        const apiKeyUser = await this.validateApiKey(apiKey);
        if (apiKeyUser) {
          return { userId: apiKeyUser.userId, role: apiKeyUser.role, authMethod: 'apiKey' };
        }
      }
    }
    
    // Fallback para sessão (será implementado depois)
    return null;
  }

  /** Verificar se usuário tem papel mínimo */
  hasRole(userRole: string, requiredRole: 'admin' | 'editor' | 'agent': string): boolean {
    const roleHierarchy: Record<string, number> = {
      admin: 3,
      editor: 2,
      agent: 1
    };
    return (roleHierarchy[userRole as keyof typeof roleHierarchy] || 0) >= (roleHierarchy[requiredRole] || 0);
  }

  /** Revogar sessão (logout) */
  async revokeSession(sessionId: string): Promise<boolean> {
    // Implementação futura - invalidar sessão no Redis ou BD
    try {
      await prisma.$executeRaw`UPDATE session SET status = 'revoked' WHERE sessionId = ${sessionId}`;
      return true;
    } catch {
      return false;
    }
  }
}
