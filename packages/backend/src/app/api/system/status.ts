import { NextRequest, NextResponse } from 'next/server';
import { authAdapter } from '@/adapters/auth/auth';

export async function GET(request: NextRequest) {
  const user = await authAdapter.getAuthenticatedUser(request);
  if (!user) {
    return NextResponse.json({ error: 'Não autenticado' }, { status: 401 });
  }
  
  return NextResponse.json({
    status: 'ok',
    version: '1.0.0',
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    userId: user.userId,
    role: user.role,
  });
}

export async function POST(request: NextRequest) {
  const user = await authAdapter.getAuthenticatedUser(request);
  if (!user) {
    return NextResponse.json({ error: 'Não autenticado' }, { status: 401 });
  }
  
  const { action, data } = await request.json();
  
  try {
    // Processar ação solicitada
    const result = await processSystemAction(action, data);
    
    return NextResponse.json({ status: 'success', result });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

async function processSystemAction(action: string, data: any) {
  // Processar ação do sistema
  switch (action) {
    case 'restart':
      // Reiniciar aplicação (simulado)
      return { status: 'simulated', message: 'Reinício simulado' };
    case 'status':
      return { status: 'ok', message: 'Sistema operando normalmente' };
    default:
      return { status: 'unknown', message: 'Ação não reconhecida' };
  }
}
