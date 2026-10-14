import { prisma } from '../lib/prisma';

export interface OAuthUser {
  id: string;
  name: string;
  email: string;
  picture?: string;
}

export interface OAuthProvider {
  name: string;
  /** Authenticate with access token */
  authenticate: (token: string) => Promise<OAuthUser | null>;
  /** Refresh access token */
  refresh: (refreshToken: string) => Promise<{ accessToken: string; expiresIn: number }>;
  /** Revoke token */
  revoke: (token: string) => Promise<boolean>;
}

/** provedores configurados */
const providers = new Map<string, OAuthProvider>();

/** Registrar provedor OAuth */
export function registerProvider(name: string, provider: OAuthProvider) {
  providers.set(name, provider);
}

/** Autenticar com provedor */
export async function authenticate(providerName: string, token: string): Promise<OAuthUser | null> {
  const provider = providers.get(providerName);
  if (!provider) {
    console.error(`Provedor OAuth '${providerName}' não configurado`);
    return null;
  }
  return provider.authenticate(token);
}

export default { registerProvider, authenticate };
