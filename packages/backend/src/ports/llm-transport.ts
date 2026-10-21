// Transporte LLM — CRM MilVendas (Fase 3, Task 6). Só tipos, sem lógica.
// É a fronteira que o AIProvider usa para falar com um fornecedor (OpenAI,
// Anthropic, vLLM...). A implementação concreta (HTTP, auth, parsing) fica em
// src/adapters/ai/ e troca-se sem tocar no CRM.

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolName?: string;
}

export interface LLMTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema
}

export interface LLMCallRequest {
  model: string;
  messages: readonly LLMMessage[];
  tools: readonly LLMTool[];
  maxTokens: number;
}

export interface LLMCallResult {
  content: string | null;
  toolCall: { name: string; args: unknown } | null;
  model: string;
}

export interface LLMTransport {
  readonly name: string;
  call(req: LLMCallRequest, signal: AbortSignal): Promise<LLMCallResult>;
}
