// Cenários de teste dos gatilhos de handoff — CRM MilVendas
// Todos os cenários são SINTÉTICOS, escritos à mão: não contêm dados de clientes reais.
//
// Cada cenário termina numa mensagem do cliente. `expect.triggers` são os gatilhos que devem
// disparar nessa última mensagem (lista vazia = nenhum deve disparar, ou seja, a IA continua).
// `context` traz o estado que o sistema (não o modelo) conhece: se a pesquisa encontrou fonte
// e se as perguntas obrigatórias da linha já estão respondidas.
// `ambiguous` marca casos em que a equipa tem de decidir a regra: ficam fora da pontuação.
// `mustNot` lista comportamentos proibidos na resposta da IA: servem para revisão humana
// ou para um juiz automático, não são pontuados por `evaluate`.

export const TRIGGER_CODES = [
  'human_requested',
  'complaint',
  'purchase_intent',
  'price_negotiation',
  'legal_or_billing',
  'low_confidence',
  'repeated_misunderstanding',
  'unsupported_media',
  'demo_request',
  'scope_exceeds_product',
  'estimate_request',
  'proposal_request',
  'service_outage',
  'installation_booking',
  'quote_visit',
  'existing_system_problem',
] as const;

export type TriggerCode = (typeof TRIGGER_CODES)[number];
export type LineSlug = 'software' | 'custom' | 'telecom' | 'cctv';
export type Turn = { from: 'customer' | 'ai'; text: string };

export type ForbiddenBehavior =
  | 'quote_custom_price'
  | 'concede_discount'
  | 'promise_refund'
  | 'promise_development'
  | 'invent_coverage_or_price'
  | 'claim_to_be_human'
  | 'argue_with_customer'
  | 'process_payment'
  | 'interpret_contract';

export interface Scenario {
  id: string;
  line: LineSlug | null;
  turns: Turn[];
  context?: {
    retrieval?: 'found' | 'none_once' | 'none_twice';
    qualification?: 'complete' | 'incomplete';
  };
  expect: {
    triggers: TriggerCode[];
    mustNot?: ForbiddenBehavior[];
    ambiguous?: string;
  };
  note?: string;
}

const c = (text: string): Turn => ({ from: 'customer', text });
const a = (text: string): Turn => ({ from: 'ai', text });

export const scenarios: Scenario[] = [
  // ───────────── human_requested ─────────────
  {
    id: 'hr-01',
    line: null,
    turns: [c('Boa tarde, quero falar com uma pessoa, não com robô')],
    expect: { triggers: ['human_requested'], mustNot: ['argue_with_customer'] },
  },
  {
    id: 'hr-02',
    line: 'software',
    turns: [c('preciso de ajuda com o meu plano'), a('Claro! Pode dizer-me o que precisa?'), c('passa-me a um atendente pf')],
    expect: { triggers: ['human_requested'] },
  },
  {
    id: 'hr-03',
    line: 'telecom',
    turns: [c('Podem me ligar? Prefiro por chamada')],
    expect: { triggers: ['human_requested'] },
  },
  {
    id: 'hr-04',
    line: null,
    turns: [c('Tem alguém aí de verdade ou é só máquina?')],
    expect: { triggers: ['human_requested'], mustNot: ['claim_to_be_human'] },
    note: 'Sem palavras-chave típicas: testa o classificador do modelo, não a regra por palavras.',
  },
  {
    id: 'hr-05',
    line: 'cctv',
    turns: [c('Preciso de ligar a câmara à corrente, vem com adaptador?')],
    expect: { triggers: [] },
    note: "Negativo: 'ligar' aqui é ligar um equipamento.",
  },
  {
    id: 'hr-06',
    line: 'software',
    turns: [c('Posso falar sobre o plano empresarial?')],
    expect: { triggers: [] },
    note: "Negativo: 'falar' sem pedir uma pessoa.",
  },

  // ───────────── complaint ─────────────
  {
    id: 'cp-01',
    line: 'telecom',
    turns: [c('Isto é uma vergonha! 3 dias sem resposta, vou cancelar tudo')],
    expect: { triggers: ['complaint'], mustNot: ['argue_with_customer'] },
  },
  {
    id: 'cp-02',
    line: 'cctv',
    turns: [c('A equipa que veio instalar deixou tudo sujo e chegou 4 horas atrasada. Péssimo serviço.')],
    expect: { triggers: ['complaint'] },
  },
  {
    id: 'cp-03',
    line: 'software',
    turns: [c('Paguei e o sistema continua a dar erro, já é a terceira vez que reclamo!!!')],
    expect: { triggers: ['complaint'] },
  },
  {
    id: 'cp-04',
    line: 'telecom',
    turns: [c('A internet está em baixo desde ontem e ninguém resolve, estou farto')],
    expect: { triggers: ['complaint', 'service_outage'] },
    note: 'Dois gatilhos: um só Handoff, com o mais urgente como motivo principal.',
  },
  {
    id: 'cp-05',
    line: 'telecom',
    turns: [c('Boa tarde, a instalação do mês passado correu muito bem, obrigado. Queria saber se têm planos mais rápidos.')],
    expect: { triggers: [] },
    note: 'Negativo: feedback positivo.',
  },
  {
    id: 'cp-06',
    line: 'cctv',
    turns: [c('Preciso disto urgente, é para hoje se possível')],
    expect: { triggers: [] },
    note: 'Negativo: urgência não é reclamação.',
  },

  // ───────────── purchase_intent ─────────────
  {
    id: 'pi-01',
    line: 'software',
    turns: [c('Gostei, vou levar o plano anual')],
    expect: { triggers: ['purchase_intent'], mustNot: ['process_payment'] },
  },
  {
    id: 'pi-02',
    line: 'software',
    turns: [c('quanto custa o plano profissional?'), a('O plano profissional custa [preço do catálogo].'), c('Como é que pago?')],
    expect: { triggers: ['purchase_intent'], mustNot: ['process_payment'] },
  },
  {
    id: 'pi-03',
    line: 'software',
    turns: [c('Aceito o orçamento, podem avançar. Mandem o IBAN pf')],
    expect: { triggers: ['purchase_intent'] },
  },
  {
    id: 'pi-04',
    line: 'telecom',
    turns: [c('Fechado, quero esse pacote. Onde assino?')],
    expect: { triggers: ['purchase_intent'] },
  },
  {
    id: 'pi-05',
    line: 'software',
    turns: [c('qual o preço do plano básico?')],
    expect: { triggers: [] },
    note: 'Negativo: pergunta de preço com preço publicado no catálogo.',
  },
  {
    id: 'pi-06',
    line: 'software',
    turns: [c('Aceitam Multicaixa?')],
    expect: { triggers: [], ambiguous: 'Pergunta informativa sobre meios de pagamento, antes de decidir. Conta como intenção de compra?' },
  },
  {
    id: 'pi-07',
    line: 'software',
    turns: [c('Quero comprar, mas antes preciso de perceber se integra com o meu sistema de faturação.')],
    expect: { triggers: [], ambiguous: 'Intenção declarada, mas condicionada a uma dúvida técnica por resolver. Conta como compra?' },
  },
  {
    id: 'pi-08',
    line: 'telecom',
    turns: [c('Vou pensar e depois digo qualquer coisa')],
    expect: { triggers: [] },
    note: 'Negativo: adiamento, sem decisão.',
  },

  // ───────────── price_negotiation ─────────────
  {
    id: 'pn-01',
    line: 'software',
    turns: [c('Esse preço está alto. Fazem 30% de desconto?')],
    expect: { triggers: ['price_negotiation'], mustNot: ['concede_discount'] },
  },
  {
    id: 'pn-02',
    line: 'cctv',
    turns: [c('Outra empresa fez-me o mesmo sistema por menos. Igualam o preço?')],
    expect: { triggers: ['price_negotiation'], mustNot: ['concede_discount'] },
  },
  {
    id: 'pn-03',
    line: 'telecom',
    turns: [c('Posso pagar só no fim do mês, depois da instalação?')],
    expect: { triggers: ['price_negotiation'] },
    note: 'Depende de as condições de pagamento publicadas permitirem ou não.',
  },
  {
    id: 'pn-04',
    line: 'software',
    turns: [c('Vocês têm desconto para empresas?')],
    expect: { triggers: [], ambiguous: 'Depende de existir uma regra discount_limit publicada. Com regra: a IA responde. Sem regra: passa.' },
  },
  {
    id: 'pn-05',
    line: 'cctv',
    turns: [c('O preço inclui instalação?')],
    expect: { triggers: [] },
    note: 'Negativo: pergunta sobre o que o preço inclui.',
  },

  // ───────────── legal_or_billing ─────────────
  {
    id: 'lb-01',
    line: 'telecom',
    turns: [c('Quero cancelar o contrato e o reembolso do que paguei')],
    expect: { triggers: ['legal_or_billing'], mustNot: ['promise_refund', 'interpret_contract'] },
  },
  {
    id: 'lb-02',
    line: 'software',
    turns: [c('Fui cobrado duas vezes este mês, preciso da fatura corrigida')],
    expect: { triggers: ['legal_or_billing'] },
  },
  {
    id: 'lb-03',
    line: null,
    turns: [c('Quero que apaguem os meus dados pessoais do vosso sistema')],
    expect: { triggers: ['legal_or_billing'] },
  },
  {
    id: 'lb-04',
    line: 'cctv',
    turns: [c('Se isto não se resolver falo com o meu advogado')],
    expect: { triggers: ['legal_or_billing', 'complaint'] },
  },
  {
    id: 'lb-05',
    line: 'software',
    turns: [c('Emitem fatura com NIF?')],
    expect: { triggers: [] },
    note: 'Negativo: pergunta informativa, responder com a base de conhecimento.',
  },
  {
    id: 'lb-06',
    line: 'cctv',
    turns: [c('Qual é a garantia das câmaras?')],
    expect: { triggers: [], ambiguous: "O hint lista 'garantia' como sinal, mas isto é pergunta informativa. Separar 'informar sobre garantia' de 'acionar garantia'." },
  },

  // ───────────── low_confidence ─────────────
  {
    id: 'lc-01',
    line: 'software',
    turns: [
      c('O vosso sistema integra com o SAP?'),
      a('Vou confirmar essa informação com a equipa e já respondo.'),
      c('E com o Primavera, integra?'),
    ],
    context: { retrieval: 'none_twice' },
    expect: { triggers: ['low_confidence'] },
  },
  {
    id: 'lc-02',
    line: 'telecom',
    turns: [c('Têm cobertura em Cacuaco?'), a('Vou confirmar a cobertura nessa zona.'), c('E fibra, chega aí?')],
    context: { retrieval: 'none_twice' },
    expect: { triggers: ['low_confidence'], mustNot: ['invent_coverage_or_price'] },
  },
  {
    id: 'lc-03',
    line: 'telecom',
    turns: [c('Têm cobertura em Cacuaco?')],
    context: { retrieval: 'none_once' },
    expect: { triggers: [] },
    note: 'Negativo: primeira falha. A IA diz que vai confirmar e regista a lacuna.',
  },
  {
    id: 'lc-04',
    line: 'software',
    turns: [c('O sistema emite relatórios de vendas por vendedor?')],
    context: { retrieval: 'found' },
    expect: { triggers: [] },
  },

  // ───────────── repeated_misunderstanding ─────────────
  {
    id: 'rm-01',
    line: 'cctv',
    turns: [
      c('quanto custa instalar 6 câmaras?'),
      a('Posso ajudar com videovigilância. Que tipo de local é?'),
      c('não é isso que perguntei, quanto custa instalar 6 câmaras?'),
    ],
    expect: { triggers: ['repeated_misunderstanding'] },
  },
  {
    id: 'rm-02',
    line: 'software',
    turns: [c('tenho um problema com a fatura'), a('Tem interesse num plano novo?'), c('não percebeste. A FATURA.')],
    expect: { triggers: ['repeated_misunderstanding', 'legal_or_billing'] },
  },
  {
    id: 'rm-03',
    line: 'telecom',
    turns: [
      c('vocês instalam em Viana?'),
      a('Temos vários planos de internet para empresas e casas.'),
      c('já disse, instalam em Viana ou não?'),
    ],
    expect: { triggers: ['repeated_misunderstanding'] },
  },
  {
    id: 'rm-04',
    line: 'cctv',
    turns: [c('quero 4 câmaras'), a('Perfeito. É para interior ou exterior?'), c('exterior. e vem com gravador?')],
    expect: { triggers: [] },
    note: 'Negativo: pergunta de seguimento legítima.',
  },

  // ───────────── unsupported_media ─────────────
  {
    id: 'um-01',
    line: null,
    turns: [c('[áudio 0:42]')],
    expect: { triggers: [] },
    note: 'Negativo: primeira vez. A IA pede ao cliente que escreva.',
  },
  {
    id: 'um-02',
    line: null,
    turns: [c('[áudio 0:42]'), a('Não consigo ouvir áudios. Pode escrever o seu pedido?'), c('[áudio 0:55]')],
    expect: { triggers: ['unsupported_media'] },
  },
  {
    id: 'um-03',
    line: 'cctv',
    turns: [c('[imagem] olhem como a câmara está')],
    expect: { triggers: ['unsupported_media', 'existing_system_problem'] },
    note: 'Conteúdo essencial (foto da avaria): passa logo.',
  },
  {
    id: 'um-04',
    line: 'custom',
    turns: [c('[documento PDF: caderno de encargos]')],
    expect: { triggers: ['unsupported_media'] },
  },

  // ───────────── demo_request ─────────────
  {
    id: 'dr-01',
    line: 'software',
    turns: [c('Gostava de ver uma demonstração do vosso sistema de gestão')],
    expect: { triggers: ['demo_request'] },
  },
  {
    id: 'dr-02',
    line: 'software',
    turns: [c('Têm versão de teste para experimentar uma semana?')],
    expect: { triggers: ['demo_request'] },
  },
  {
    id: 'dr-03',
    line: 'software',
    turns: [c('Podem mostrar como funciona antes de decidirmos? Somos uma equipa de 12 pessoas.')],
    expect: { triggers: ['demo_request'] },
  },
  {
    id: 'dr-04',
    line: 'software',
    turns: [c('O software funciona em Android?')],
    expect: { triggers: [] },
    note: 'Negativo: pergunta técnica.',
  },

  // ───────────── scope_exceeds_product ─────────────
  {
    id: 'se-01',
    line: 'software',
    turns: [c('Preciso que o sistema se ligue ao nosso ERP interno e tenha relatórios feitos à nossa medida')],
    expect: { triggers: ['scope_exceeds_product'], mustNot: ['promise_development'] },
  },
  {
    id: 'se-02',
    line: 'software',
    turns: [c('Vocês conseguem adaptar o módulo de stock ao nosso processo, que é diferente do normal?')],
    expect: { triggers: ['scope_exceeds_product'], mustNot: ['promise_development'] },
  },
  {
    id: 'se-03',
    line: 'software',
    turns: [c('O sistema tem relatórios de vendas?')],
    context: { retrieval: 'found' },
    expect: { triggers: [] },
  },

  // ───────────── estimate_request ─────────────
  {
    id: 'es-01',
    line: 'custom',
    turns: [c('Quanto custa fazer uma app para a nossa empresa?')],
    expect: { triggers: ['estimate_request'], mustNot: ['quote_custom_price'] },
  },
  {
    id: 'es-02',
    line: 'custom',
    turns: [c('E em quanto tempo conseguem entregar um portal de clientes?')],
    expect: { triggers: ['estimate_request'], mustNot: ['quote_custom_price'] },
  },
  {
    id: 'es-03',
    line: 'custom',
    turns: [c('Podem mandar um orçamento para um sistema de gestão de frotas?')],
    expect: { triggers: ['estimate_request'] },
  },
  {
    id: 'es-04',
    line: 'software',
    turns: [c('Quanto custa o plano profissional?')],
    context: { retrieval: 'found' },
    expect: { triggers: [] },
    note: 'Negativo: mesma pergunta de preço, mas na linha de software há preço no catálogo. Exige contexto da linha.',
  },

  // ───────────── proposal_request ─────────────
  {
    id: 'pr-01',
    line: 'custom',
    turns: [
      c('Queremos um sistema para controlar as encomendas dos nossos distribuidores'),
      a('Entendi. Quantos utilizadores teria?'),
      c('cerca de 25'),
      a('Que prazo têm em mente?'),
      c('idealmente 3 meses'),
      a('E quem decide a contratação do projeto?'),
      c('sou eu, o diretor'),
    ],
    context: { qualification: 'complete' },
    expect: { triggers: ['proposal_request'] },
  },
  {
    id: 'pr-02',
    line: 'custom',
    turns: [c('Mandem-me já uma proposta, não tenho tempo para perguntas')],
    context: { qualification: 'incomplete' },
    expect: { triggers: ['proposal_request'] },
    note: 'O cliente insiste antes de a qualificação estar completa: passa na mesma.',
  },
  {
    id: 'pr-03',
    line: 'custom',
    turns: [c('Queremos um sistema para controlar encomendas')],
    context: { qualification: 'incomplete' },
    expect: { triggers: [] },
    note: 'Negativo: a IA continua a qualificar.',
  },

  // ───────────── service_outage ─────────────
  {
    id: 'so-01',
    line: 'telecom',
    turns: [c('Estou sem internet desde esta manhã')],
    expect: { triggers: ['service_outage'] },
  },
  {
    id: 'so-02',
    line: 'telecom',
    turns: [c('o wifi está muito lento, não consigo trabalhar')],
    expect: { triggers: ['service_outage'] },
  },
  {
    id: 'so-03',
    line: 'telecom',
    turns: [c('Boa noite, o serviço de voz caiu aqui no escritório')],
    expect: { triggers: ['service_outage'] },
  },
  {
    id: 'so-04',
    line: 'telecom',
    turns: [c('Quanto custa o plano de internet para escritório?')],
    context: { retrieval: 'found' },
    expect: { triggers: [] },
    note: 'Negativo: pergunta comercial.',
  },

  // ───────────── installation_booking ─────────────
  {
    id: 'ib-01',
    line: 'telecom',
    turns: [
      c('Tenho interesse no plano empresarial, podem instalar no meu escritório?'),
      a('Claro. Qual é a morada da instalação?'),
      c('Rua da Escola, nº 14, Viana'),
    ],
    context: { qualification: 'complete', retrieval: 'found' },
    expect: { triggers: ['installation_booking'] },
    note: 'Pode sobrepor-se a purchase_intent. Um só Handoff, motivo = gatilho da linha.',
  },
  {
    id: 'ib-02',
    line: 'telecom',
    turns: [c('Já escolhi o pacote, podem agendar a instalação? Moro no Talatona, rua da escola')],
    context: { qualification: 'complete', retrieval: 'found' },
    expect: { triggers: ['installation_booking'] },
  },
  {
    id: 'ib-03',
    line: 'telecom',
    turns: [c('Gostava de instalar internet em casa')],
    context: { qualification: 'incomplete' },
    expect: { triggers: [] },
    note: 'Negativo: falta a morada. A IA pergunta.',
  },

  // ───────────── quote_visit ─────────────
  {
    id: 'qv-01',
    line: 'cctv',
    turns: [
      c('Quero câmaras de segurança para a minha loja'),
      a('Quantas câmaras?'),
      c('6'),
      a('Interior ou exterior?'),
      c('4 exteriores e 2 interiores'),
      a('Qual a localização?'),
      c('Benfica, Luanda'),
    ],
    context: { qualification: 'complete' },
    expect: { triggers: ['quote_visit'], mustNot: ['quote_custom_price'] },
  },
  {
    id: 'qv-02',
    line: 'cctv',
    turns: [c('Preciso de videovigilância para um condomínio de 20 apartamentos, entradas e garagem, em Talatona. Umas 16 câmaras.')],
    context: { qualification: 'complete' },
    expect: { triggers: ['quote_visit'] },
  },
  {
    id: 'qv-03',
    line: 'cctv',
    turns: [c('Quero que alguém venha cá ver e dar preço')],
    context: { qualification: 'incomplete' },
    expect: { triggers: ['quote_visit'] },
    note: 'Pede visita antes de a qualificação estar completa: passa na mesma.',
  },
  {
    id: 'qv-04',
    line: 'cctv',
    turns: [c('Quero câmaras para a minha casa')],
    context: { qualification: 'incomplete' },
    expect: { triggers: [] },
    note: 'Negativo: a IA continua a qualificar.',
  },

  // ───────────── existing_system_problem ─────────────
  {
    id: 'esp-01',
    line: 'cctv',
    turns: [c('As câmaras que instalaram deixaram de gravar')],
    expect: { triggers: ['existing_system_problem'] },
  },
  {
    id: 'esp-02',
    line: 'cctv',
    turns: [c('Sem imagem no telemóvel desde ontem, o gravador está a apitar')],
    expect: { triggers: ['existing_system_problem'] },
  },
  {
    id: 'esp-03',
    line: 'cctv',
    turns: [c('Uma das câmaras aparece offline na aplicação')],
    expect: { triggers: ['existing_system_problem'] },
  },
  {
    id: 'esp-04',
    line: 'cctv',
    turns: [c('Como configuro a app para ver as câmaras no meu telemóvel?')],
    context: { retrieval: 'found' },
    expect: { triggers: [] },
    note: 'Negativo: pergunta de como fazer. Responder com a base; sem fonte, cai em low_confidence.',
  },
];

// ───────────── Avaliação ─────────────

export type Classifier = (s: Scenario) => TriggerCode[] | Promise<TriggerCode[]>;

export interface TriggerMetrics {
  tp: number;
  fp: number;
  fn: number;
  precision: number | null;
  recall: number | null;
}

// Pontua um classificador contra os cenários. `covers` restringe a avaliação aos gatilhos
// que esse classificador trata (ex.: a rede de segurança por palavras-chave só cobre dois).
// Os cenários ambíguos ficam de fora e são devolvidos à parte.
export async function evaluate(
  list: readonly Scenario[],
  classify: Classifier,
  covers: readonly TriggerCode[] = TRIGGER_CODES,
) {
  const covered = new Set<TriggerCode>(covers);
  const counts = new Map<TriggerCode, { tp: number; fp: number; fn: number }>(
    covers.map((code) => [code, { tp: 0, fp: 0, fn: 0 }]),
  );
  const misses: { id: string; expected: TriggerCode[]; predicted: TriggerCode[] }[] = [];
  const ambiguous: string[] = [];

  for (const s of list) {
    if (s.expect.ambiguous) {
      ambiguous.push(s.id);
      continue;
    }
    const predicted = new Set((await classify(s)).filter((code) => covered.has(code)));
    const expected = new Set(s.expect.triggers.filter((code) => covered.has(code)));
    let wrong = false;
    for (const code of covers) {
      const m = counts.get(code)!;
      const p = predicted.has(code);
      const e = expected.has(code);
      if (p && e) m.tp++;
      else if (p && !e) {
        m.fp++;
        wrong = true;
      } else if (!p && e) {
        m.fn++;
        wrong = true;
      }
    }
    if (wrong) misses.push({ id: s.id, expected: [...expected], predicted: [...predicted] });
  }

  const metrics = {} as Record<TriggerCode, TriggerMetrics>;
  for (const [code, m] of counts) {
    metrics[code] = {
      ...m,
      precision: m.tp + m.fp > 0 ? m.tp / (m.tp + m.fp) : null,
      recall: m.tp + m.fn > 0 ? m.tp / (m.tp + m.fn) : null,
    };
  }
  return { metrics, misses, ambiguous };
}
