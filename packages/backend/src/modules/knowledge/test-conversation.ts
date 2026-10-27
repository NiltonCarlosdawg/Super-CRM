// Treinar agente, Task 8: substrato sintético do chat de teste.
// Encontra-ou-cria, por tenant, uma conta WhatsApp fictícia ("chat-de-teste"),
// um contacto sintético e UMA conversa com `is_test = true` e `line_id = null`.
// O chat de teste corre sobre esta conversa com `isTest: true` (o orquestrador
// desliga handoff, lacunas e notificações), pelo que aqui não há envios.
//
// Idempotência tolerante a corrida: cada insert usa valores determinísticos
// (sessão da conta, telefone do contacto) e a unique certa; quando o insert
// perde a corrida, relê pela mesma chave em vez de falhar. Nenhum destes dados
// contacta o WA-AKG: a conta fica `disconnected` por desenho.

import { and, eq } from 'drizzle-orm';

import type { DbClient } from '../../adapters/db/index.js';
import { contacts } from '../../adapters/db/schema/contacts.schema.js';
import { conversations } from '../../adapters/db/schema/conversations.schema.js';
import { whatsappAccounts } from '../../adapters/db/schema/whatsapp-accounts.schema.js';

/** Etiqueta da conta sintética (visível no painel de contas). */
export const TEST_ACCOUNT_LABEL = 'chat-de-teste';

/** Nome do contacto sintético. */
export const TEST_CONTACT_NAME = 'Chat de teste';

/**
 * Telefone E.164 determinístico por tenant: `+2449` + 9 dígitos derivados do
 * uuid (13 dígitos no total, dentro do máximo de 15 do E.164). Como o único é
 * `(tenant_id, phone_e164)`, o mesmo valor em tenants diferentes não colide.
 */
export function testContactPhone(tenantId: string): string {
  const hex = tenantId.replace(/-/g, '');
  const suffix = BigInt(`0x${hex}`) % 1_000_000_000n;
  return `+2449${suffix.toString().padStart(9, '0')}`;
}

/** Id de sessão determinístico da conta sintética (unique global). */
function testProviderSessionId(tenantId: string): string {
  return `test-chat:${tenantId}`;
}

async function ensureTestAccount(db: DbClient, tenantId: string): Promise<string> {
  const [existing] = await db
    .select({ id: whatsappAccounts.id })
    .from(whatsappAccounts)
    .where(
      and(
        eq(whatsappAccounts.tenantId, tenantId),
        eq(whatsappAccounts.label, TEST_ACCOUNT_LABEL),
      ),
    )
    .limit(1);
  if (existing !== undefined) return existing.id;

  const providerSessionId = testProviderSessionId(tenantId);
  const [created] = await db
    .insert(whatsappAccounts)
    .values({
      tenantId,
      label: TEST_ACCOUNT_LABEL,
      providerSessionId,
      // Conta fictícia: nunca liga ao WA-AKG, logo não se apresenta como conectada.
      status: 'disconnected',
      purpose: 'support',
    })
    .onConflictDoNothing()
    .returning({ id: whatsappAccounts.id });
  if (created !== undefined) return created.id;

  // Corrida perdida (outra chamada inseriu entretanto): relê pela sessão única.
  const [raced] = await db
    .select({ id: whatsappAccounts.id })
    .from(whatsappAccounts)
    .where(eq(whatsappAccounts.providerSessionId, providerSessionId))
    .limit(1);
  if (raced === undefined) throw new Error('chat de teste: conta sintética não encontrada');
  return raced.id;
}

async function ensureTestContact(db: DbClient, tenantId: string): Promise<string> {
  const phoneE164 = testContactPhone(tenantId);
  const [existing] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), eq(contacts.phoneE164, phoneE164)))
    .limit(1);
  if (existing !== undefined) return existing.id;

  const [created] = await db
    .insert(contacts)
    .values({ tenantId, phoneE164, name: TEST_CONTACT_NAME })
    .onConflictDoNothing()
    .returning({ id: contacts.id });
  if (created !== undefined) return created.id;

  const [raced] = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), eq(contacts.phoneE164, phoneE164)))
    .limit(1);
  if (raced === undefined) throw new Error('chat de teste: contacto sintético não encontrado');
  return raced.id;
}

/**
 * Devolve o id da conversa de teste do tenant, criando-a na primeira chamada.
 * `ai_active` expressa a intenção do chat (responder como em produção); é o
 * `isTest` do turno que garante que nada é enviado nem escalado.
 */
export async function ensureTestConversation(db: DbClient, tenantId: string): Promise<string> {
  const accountId = await ensureTestAccount(db, tenantId);
  const contactId = await ensureTestContact(db, tenantId);

  const [existing] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.tenantId, tenantId),
        eq(conversations.accountId, accountId),
        eq(conversations.contactId, contactId),
      ),
    )
    .limit(1);
  if (existing !== undefined) return existing.id;

  const [created] = await db
    .insert(conversations)
    .values({
      tenantId,
      accountId,
      contactId,
      lineId: null,
      aiMode: 'ai_active',
      isTest: true,
    })
    .onConflictDoNothing({ target: [conversations.accountId, conversations.contactId] })
    .returning({ id: conversations.id });
  if (created !== undefined) return created.id;

  const [raced] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.tenantId, tenantId),
        eq(conversations.accountId, accountId),
        eq(conversations.contactId, contactId),
      ),
    )
    .limit(1);
  if (raced === undefined) throw new Error('chat de teste: conversa sintética não encontrada');
  return raced.id;
}
