import { NextResponse } from 'next/server';
import { authAdapter } from '@/adapters/auth/auth';

/** GET - Verificar autenticação */
export async function GET(request: Request) {
  const user = await authAdapter.getAuthenticatedUser(request);
  if (!user) {
    return NextResponse.json({ authenticated: false }, { status: 401 });
  }
  return NextResponse.json({ authenticated: true, userId: user.userId, role: user.role });
}

/** POST - Login com API Key */
export async function POST(request: Request) {
  const { apiKey } = await request.json();
  const user = await authAdapter.validateApiKey(apiKey);
  if (!user) {
    return NextResponse.json({ authenticated: false, error: 'Invalid API Key' }, { status: 401 });
  }
  return NextResponse.json({ authenticated: true, userId: user.userId, role: user.role });
}
