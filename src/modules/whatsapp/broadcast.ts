import { prisma } from '../lib/prisma';
import { authAdapter } from '../adapters/auth/auth';
import { whatsappAdapter } from '../whatsapp/adapter';

export interface BroadcastBody {
  sessionId: string;
  text: string;
  /** IDs dos contacts a enviar (sem = todos do session) */
  contactIds?: string[];
  /** Tipo de mensagem: text, image, document */
  type?: 'text' | 'image' | 'document';
}

/** Executar broadcast */
export async function executeBroadcast(body: BroadcastBody) {
  const { sessionId, text, contactIds, type } = body;

  // Verificar autenticação
  const user = await authAdapter.getAuthenticatedUser();
  if (!user) {
    throw new Error('Não autenticado');
  }

  // Obter contacts
  const contacts = contactIds
    ? await prisma.contact.findMany({ where: { id: { in: contactIds } } })
    : await prisma.contact.findMany({ where: { sessionId } });

  // Filtrar contacts conectados
  const connectedContacts = contacts.filter(async (contact) => {
    const isConnected = await checkSessionConnected(sessionId);
    return isConnected;
  });

  // Enviar mensagens em lote
  const results = await Promise.all(connectedContacts.map(async (contact) => {
    try {
      const result = await whatsappAdapter.sendMessage(
        sessionId,
        contact.jid,
        { type: type || 'text', text }
      );
      return { contactId: contact.id, status: 'success', result };
    } catch (error) {
      return { contactId: contact.id, status: 'error', error: error.message };
    }
  }));

  return results;
