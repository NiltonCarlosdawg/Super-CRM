import { keywordSafetyNet } from '../domain/keyword-safety-net';

export interface ClassificationResult {
  primaryTrigger: string;
  secondaryTriggers: string[];
  confidence: number;
  requiresHuman: boolean;
  suggestedActions: string[];
}

export function classifyMessageAdvanced(text: string, context?: any): ClassificationResult {
  const safetyResult = keywordSafetyNet(text);
  
  const primaryTrigger = safetyResult.trigger;
  const secondaryTriggers = safetyResult.trigger !== 'human_requested' 
    ? ['human_requested'] 
    : [];
  
  const requiresHuman = safetyResult.trigger === 'human_requested';
  const confidence = safetyResult.trigger ? 0.8 : 0.3;
  const suggestedActions = requiresHuman 
    ? ['Conectar com atendente', 'Analisar contexto']
    : ['Processar mensagem', 'Gerar resposta'];
  
  return {
    primaryTrigger,
    secondaryTriggers,
    confidence,
    requiresHuman,
    suggestedActions,
  };
}

export function getSafetyDetails(text: string) {
  return {
    triggers: keywordSafetyNet,
    safetyNetStatus: keywordSafetyNet ? 'ativo' : 'inativo',
    lastAnalysis: new Date().toISOString(),
  };
}
