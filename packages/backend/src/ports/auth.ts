export interface AuthPort {
  /** Validar API key do cabeçalho X-API-Key */
  validateApiKey(apiKey: string): Promise<{ userId: string; role: string } | null>;

  /** Obter usuário a partir de sessão ou API key */
  getAuthenticatedUser(request?: Request): Promise<{ userId: string; role: string; authMethod: 'apiKey' | 'session' } | null>;

  /** Verificar se usuário tem papel mínimo */
  hasRole(userRole: string, requiredRole: string): boolean;

  /** Revogar sessão (logout) */
  revokeSession(sessionId: string): Promise<boolean>;
}
