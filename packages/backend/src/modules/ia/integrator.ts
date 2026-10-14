import { prisma } from '../lib/prisma';
import { keywordSafetyNet } from '../domain/keyword-safety-net';

export interface IAResponse {
  trigger: string;
  confidence: number;
  response: string;
  suggestions: string[];
}

export async function classifyMessage(text: string, sessionId: string): Promise<IAResponse> {
  // Verificar gatilhos de segurança
  const safetyResult = keywordSafetyNet(text);
  
  // Determinar gatilho principal
  let trigger: string = 'unknown';
  let confidence: number = 0;

  // Verificar gatilhos conhecidos
  const knownTriggers = ['human_requested', 'purchase_intent'];
  for (const trigger of knownTriggers) {
    if (text.toLowerCase().includes(trigger)) {
      trigger = trigger;
      confidence = 0.8;
      break;
    }
  }

  // Montar resposta
  const suggestions = [
    'Posso ajudar com mais informações',
    'Gostaria de falar com um atendente',
    'Qual o seu objetivo?'
  ];

  return {
    trigger,
    confidence,
    response: `Mensagem classificada como: ${trigger}`,
    suggestions,
  };
}

export async function processInboundMessage(
  sessionId: string,
  text: string,
  metadata?: any
): Promise<IAResponse> {
  return classifyMessage(text, sessionId);
}

export async function getSafetyNetStatus(): Promise<{
  totalAnalyzed: number;
  triggersDetected: number;
  safetyActions: number;
}> {
  // Placeholder - implementar com base nos dados reais
  return {
    totalAnalyzed: 0,
    triggersDetected: 0,
    safetyActions: 0,
  };
}
