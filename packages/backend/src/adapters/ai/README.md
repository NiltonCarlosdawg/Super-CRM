# Adaptadores de IA (Fase 3)

Transportes LLM para o `AIProvider`. Os testes correm sem rede: as fixtures em
`tests/fixtures/llm/` espelham os exemplos da documentação oficial abaixo.

## Evidência da documentação oficial

Consultadas a 2026-10-21 (formatos de payload NÃO deduzidos de memória).

### OpenAI — Chat Completions

- Fonte: https://platform.openai.com/docs/api-reference/chat/create
- Endpoint: `POST {base}/v1/chat/completions`
- Auth: `Authorization: Bearer <AI_API_KEY>`
- Pedido: `{ model, messages: [{role, content}],
  tools: [{type:"function", function:{name, description, parameters}}],
  max_completion_tokens }`
  (`max_tokens` está deprecado → usa-se `max_completion_tokens`)
- Resposta: `choices[0].message.{content, tool_calls[{function:{name, arguments}}]}`.
  `arguments` é **string JSON** gerada pelo modelo; a doc alerta que pode ser inválida,
  por isso é validada (`JSON.parse`) e um erro dá `invalid_response`.
- Tool call indicado por `finish_reason: "tool_calls"`.

### Anthropic — Messages

- Fonte: https://docs.anthropic.com/en/api/messages (→ platform.claude.com/docs/en/api/messages)
- Endpoint: `POST {base}/v1/messages`
- Auth: headers `x-api-key: <AI_API_KEY>` e `anthropic-version: 2023-06-01`
- Pedido: `{ model, max_tokens (obrigatório), system (top-level),
  messages: [{role:"user"|"assistant", content}], tools: [{name, description, input_schema}] }`
  - `role:"system"` NÃO existe nas `messages` — o system prompt vai no campo `system`.
  - Tools usam `input_schema` (≠ OpenAI `function.parameters`).
- Resposta: `content: [{type:"text", text} | {type:"tool_use", id, name, input}]`,
  `stop_reason`. O `input` do `tool_use` já é **objeto** (≠ OpenAI `arguments` string).

## Decisões

- `AI_BASE_URL` é a **origem** sem caminho (ex.: `https://api.openai.com`,
  `https://api.anthropic.com`). `joinUrl` remove um `\/v\d+` final para não duplicar
  a versão quando alguém configura a base com `/v1`.
- `LLMCallRequest.maxTokens` mapeia `max_completion_tokens` (OpenAI) e `max_tokens` (Anthropic).
- Mensagens `role:"tool"` (resultado de tool) viram `{role:"tool", tool_call_id, content}`
  no OpenAI e `{role:"user", content:[{type:"tool_result", tool_use_id, content}]}` na Anthropic.
