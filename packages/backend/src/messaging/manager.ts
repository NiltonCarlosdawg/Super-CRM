import { prisma } from '../lib/prisma';
import { authAdapter } from '../adapters/auth/auth';

export interface Message {
  id: string;
  content: string;
  type: 'text' | 'image' | 'video' | 'audio';
  status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed';
  createdAt: Date;
  metadata?: any;
}

/** Enviar mensagem */
export async function sendMessage(sessionId: string, recipient: string, message: Message): Promise<string> {
  // Implementar envio via WhatsApp API
  // Simples placeholder
  const messageId = `msg-${Date.now()}`;
  
  // Registrar mensagem no banco
  await prisma.message.create({
    data: {
      id: messageId,
      sessionId,
      content: message.content,
      type: message.type,
      status: 'sent',
      createdAt: new Date(),
    },
  });
  
  return messageId;
}

/** Obter mensagens pendentes */
export async function getPendingMessages(sessionId: string): Promise<Message[]> {
  return prisma.message.findMany({
    where: { sessionId, status: 'pending' },
  });
}

/** Atualizar status da mensagem */
export async function updateMessageStatus(messageId: string, status: Message['status']): Promise<void> {
  await prisma.message.update({
    where: { id: messageId },
    data: { status },
  });
}
