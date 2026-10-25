// Transporte LLM — CRM MilVendas (Fase 3, Task 6). Só tipos, sem lógica.
// É a fronteira que o AIProvider usa para falar com um fornecedor (OpenAI,
// Anthropic, vLLM...). A implementação concreta (HTTP, auth, parsing) fica em
// src/adapters/ai/ e troca-se sem tocar no CRM.

export interface LLMToolCallRef {
  id: string; // id real devolvido pelo fornecedor — obrigatório no eco
  name: string;
  args: unknown;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolName?: string;
  /** Echo das tool_calls da assistant — obrigatório antes de uma mensagem tool. */
  toolCalls?: readonly LLMToolCallRef[];
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
  /** Opcional: fixa a temperatura da amostragem (0 = determinista — usado pelo eval). */
  temperature?: number;
}

export interface LLMCallResult {
  content: string | null;
  toolCall: LLMToolCallRef | null;
  model: string;
}

export interface LLMTransport {
  readonly name: string;
  call(req: LLMCallRequest, signal: AbortSignal): Promise<LLMCallResult>;
}
