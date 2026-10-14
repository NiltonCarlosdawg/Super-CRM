import { NextRequest, NextResponse } from 'next/server';
import { whatsappAdapter } from '@/modules/whatsapp/adapter';
import { authAdapter } from '@/adapters/auth/auth';

export async function GET(request: NextRequest) {
  const user = await authAdapter.getAuthenticatedUser(request);
  if (!user) {
    return NextResponse.json({ error: 'Não autenticado' }, { status: 401 });
  }
  return NextResponse.json({ status: 'ok', message: 'API funcionando' });
}

export async function POST(request: NextRequest) {
  const user = await authAdapter.getAuthenticatedUser(request);
  if (!user) {
    return NextResponse.json({ error: 'Não autenticado' }, { status: 401 });
  }
  
  const { sessionId, jid, type, text } = await request.json();
  
  try {
    const result = await whatsappAdapter.sendMessage(sessionId, jid, {
      type: type || 'text',
      text: text || ''
    });
    
    // Registrar no banco
    await prisma.message.create({
      data: {
        sessionId,
        remoteJid: jid,
        fromMe: true,
        type: type || 'text',
        content: text || '',
        status: 'queued',
        sendResult: result
      }
    });
    
    // Disparar webhook
    await whatsappAdapter.fireSentWebhook(sessionId, jid, { type, text }, result);
    
    return NextResponse.json({ status: 'success', result });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
