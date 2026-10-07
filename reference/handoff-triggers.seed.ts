// Gatilhos de handoff — CRM MilVendas
// Ponto de partida: as linhas e os limiares são hipóteses a afinar pela equipa.
// Os "Sinais" e "Exemplos" de detectionHint alimentam o classificador da IA.
// Os gatilhos human_requested e purchase_intent devem ter também uma regra
// determinística (palavras-chave) como rede de segurança, sem depender só do modelo.

import type { PgDatabase } from 'drizzle-orm/pg-core';
import { businessLines, handoffTriggers } from './knowledge.schema';

type LineSlug = 'software' | 'custom' | 'telecom' | 'cctv';

type TriggerSeed = Omit<typeof handoffTriggers.$inferInsert, 'id' | 'lineId'> & {
  lineSlug: LineSlug | null; // null = global
};

export const triggerSeeds: TriggerSeed[] = [
  // ───────────── Globais ─────────────
  {
    lineSlug: null,
    code: 'human_requested',
    description: 'O cliente pede para falar com uma pessoa.',
    detectionHint:
      'Sinais: pede atendente, pessoa, humano, responsável, comercial ou chamada telefónica. ' +
      "Exemplos: 'quero falar com alguém', 'passa-me a um atendente', 'prefiro falar por chamada'. " +
      'Não discutir nem insistir: passar logo.',
    action: 'handoff_now',
    priority: 'high',
  },
  {
    lineSlug: null,
    code: 'complaint',
    description: 'Reclamação, irritação ou ameaça de cancelar.',
    detectionHint:
      'Sinais: insatisfação com produto, serviço, instalação, atendimento ou atraso; tom irritado ou ' +
      'ironia; ameaça de cancelar ou de reclamar publicamente; maiúsculas e pontuação excessiva. ' +
      'A IA não se defende nem justifica: reconhece a situação e passa.',
    action: 'handoff_now',
    priority: 'urgent',
  },
  {
    lineSlug: null,
    code: 'purchase_intent',
    description: 'O cliente decidiu comprar ou contratar.',
    detectionHint:
      'Sinais: confirma que quer comprar ou contratar, aceita preço ou proposta, pergunta como ou onde ' +
      "pagar, pede dados de pagamento ou fatura, pede para avançar. Exemplos: 'quero levar', 'como é que pago?', " +
      "'pode fechar'. A IA não processa pagamentos nem confirma encomendas: passa com resumo.",
    action: 'handoff_now',
    priority: 'high',
  },
  {
    lineSlug: null,
    code: 'price_negotiation',
    description: 'Pedido de desconto ou condições fora das regras publicadas.',
    detectionHint:
      'Sinais: pede desconto, compara com concorrente e exige igualar, pede condições de pagamento que ' +
      'não constam das regras. A IA pode informar preço de tabela e condições publicadas, mas nunca ' +
      'concede desconto acima do limite da regra discount_limit. Sem regra ou acima do limite: passar.',
    action: 'handoff_now',
    priority: 'high',
  },
  {
    lineSlug: null,
    code: 'legal_or_billing',
    description: 'Cobrança, fatura, reembolso, contrato, garantia ou dados pessoais.',
    detectionHint:
      'Sinais: disputa de cobrança ou fatura, reembolso, devolução, cancelamento de contrato, garantia, ' +
      'termos contratuais, pedido de acesso ou apagamento de dados pessoais, menção a advogado, ' +
      'autoridades ou ação legal. A IA não interpreta contratos nem promete reembolsos.',
    action: 'handoff_now',
    priority: 'high',
  },
  {
    lineSlug: null,
    code: 'low_confidence',
    description: 'A IA não encontrou fonte fiável para responder.',
    detectionHint:
      'Sinais: a pesquisa na base de conhecimento não devolve fonte acima do limiar, ou a IA teria de ' +
      'inventar preço, prazo, disponibilidade ou característica. Primeira vez: dizer que vai confirmar e ' +
      'registar a lacuna. Duas respostas seguidas sem fonte: passar a um humano.',
    action: 'handoff_now',
    priority: 'normal',
  },
  {
    lineSlug: null,
    code: 'repeated_misunderstanding',
    description: 'O cliente repete a pergunta ou diz que não foi percebido.',
    detectionHint:
      "Sinais: reformula a mesma pergunta duas ou mais vezes, diz 'não percebeste', 'não é isso', " +
      "'já disse', ou ignora a resposta e repete o pedido. Passar à segunda repetição.",
    action: 'handoff_now',
    priority: 'normal',
  },
  {
    lineSlug: null,
    code: 'unsupported_media',
    description: 'O cliente envia conteúdo que a IA não consegue interpretar.',
    detectionHint:
      'Sinais: áudio, imagem, vídeo ou documento que a IA não processa. Primeira vez: pedir ao cliente ' +
      'que escreva o pedido. Se insistir ou o conteúdo for essencial (por exemplo, foto de um problema): passar.',
    action: 'handoff_now',
    priority: 'normal',
  },

  // ───────────── Software ─────────────
  {
    lineSlug: 'software',
    code: 'demo_request',
    description: 'O cliente quer uma demonstração do software.',
    detectionHint:
      "Sinais: pede demo, demonstração, teste, 'ver como funciona', período experimental. " +
      'A IA recolhe nome da empresa e contacto, depois passa para agendamento.',
    action: 'handoff_now',
    priority: 'high',
  },
  {
    lineSlug: 'software',
    code: 'scope_exceeds_product',
    description: 'O pedido excede o produto standard e sugere solução personalizada.',
    detectionHint:
      'Sinais: pede funcionalidades que o produto não tem, integrações específicas ou adaptações ao seu ' +
      'processo. A IA explica o que o produto faz hoje, não promete desenvolvimento, e sinaliza o painel ' +
      'para a equipa de soluções personalizadas.',
    action: 'flag_only',
    priority: 'normal',
  },

  // ───────────── Soluções personalizadas ─────────────
  {
    lineSlug: 'custom',
    code: 'estimate_request',
    description: 'O cliente pede preço, prazo ou estimativa de um desenvolvimento.',
    detectionHint:
      "Sinais: 'quanto custa', 'em quanto tempo ficava', pede orçamento ou cronograma de algo à medida. " +
      'A IA nunca dá valores nem prazos de trabalho personalizado: passa de imediato.',
    action: 'handoff_now',
    priority: 'high',
  },
  {
    lineSlug: 'custom',
    code: 'proposal_request',
    description: 'Lead qualificado para receber proposta.',
    detectionHint:
      'A IA qualifica (problema, âmbito, utilizadores, urgência, quem decide) com as perguntas ' +
      'obrigatórias da linha. Quando estiverem respondidas, ou se o cliente insistir antes, passar com ' +
      'o resumo do que foi recolhido.',
    action: 'handoff_when_qualified',
    priority: 'high',
  },

  // ───────────── Telecomunicações ─────────────
  {
    lineSlug: 'telecom',
    code: 'service_outage',
    description: 'Cliente existente reporta serviço em baixo ou degradado.',
    detectionHint:
      "Sinais: 'sem internet', 'caiu', 'está lento', 'não funciona', falha de serviço contratado. " +
      'Isto é suporte, não vendas: passar de imediato com a morada ou identificação do cliente, se já houver.',
    action: 'handoff_now',
    priority: 'urgent',
  },
  {
    lineSlug: 'telecom',
    code: 'installation_booking',
    description: 'O cliente escolheu um serviço e quer instalação.',
    detectionHint:
      'A IA confirma o serviço pretendido e recolhe morada e contacto (perguntas obrigatórias da linha). ' +
      'Se a morada não constar da informação de cobertura, não prometer: passar. ' +
      'Com os dados completos, passar para agendamento.',
    action: 'handoff_when_qualified',
    priority: 'high',
  },

  // ───────────── CCTV ─────────────
  {
    lineSlug: 'cctv',
    code: 'quote_visit',
    description: 'Lead qualificado para orçamento e visita técnica.',
    detectionHint:
      'A IA recolhe número de câmaras, interior ou exterior, tipo de local e localização (perguntas ' +
      'obrigatórias da linha). Quando completas, ou se o cliente pedir visita ou orçamento antes, passar ' +
      'com o resumo. A IA não dá preço final: depende de visita.',
    action: 'handoff_when_qualified',
    priority: 'high',
  },
  {
    lineSlug: 'cctv',
    code: 'existing_system_problem',
    description: 'Cliente com câmaras instaladas reporta avaria.',
    detectionHint:
      "Sinais: 'a câmara não grava', 'sem imagem', 'offline', 'não consigo ver à distância', avaria num " +
      'sistema já instalado. Suporte, não vendas: passar de imediato.',
    action: 'handoff_now',
    priority: 'urgent',
  },
];

// Insere só os gatilhos que ainda não existem (por linha + código). Seguro para correr várias vezes.
export async function seedHandoffTriggers(db: PgDatabase<any, any, any>): Promise<number> {
  const lines = await db.select({ id: businessLines.id, slug: businessLines.slug }).from(businessLines);
  const idBySlug = new Map(lines.map((l) => [l.slug, l.id]));

  const rows = triggerSeeds.map(({ lineSlug, ...t }) => {
    if (lineSlug && !idBySlug.has(lineSlug)) {
      throw new Error(`Linha de negócio inexistente: ${lineSlug}`);
    }
    return { ...t, lineId: lineSlug ? idBySlug.get(lineSlug)! : null };
  });

  const existing = await db
    .select({ lineId: handoffTriggers.lineId, code: handoffTriggers.code })
    .from(handoffTriggers);
  const key = (lineId: string | null, code: string) => `${lineId ?? 'global'}:${code}`;
  const have = new Set(existing.map((e) => key(e.lineId, e.code)));

  const toInsert = rows.filter((r) => !have.has(key(r.lineId, r.code)));
  if (toInsert.length > 0) await db.insert(handoffTriggers).values(toInsert);
  return toInsert.length;
}
