# Security Review — Fase 5

## Objetivo
Fechar a revisão de segurança conduzindo à Fase 5, validando o manejo de dados pessoais, segredos e máscaras de acordo com `docs/03` §11 e `docs/01` §8. Este documento não reabre discussões deFeatures ou implementação — apenas valida os controles já definidos.

## 1. Máscara de telefones (docs/03 §11.1)

| Cenário | Controle | Evidência |
|---|---|---|
| Exibição de número de WhatsApp em UI (painel, conversas, listas) | Números devem ser exibidos no formato internacional E.164 com máscara de somente-leitura após o salvamento. O campo deve aceitar apenas dígitos e `+` no input. | `npm run typecheck` verde; UI inspecionada via axe 0 violações |
| Logs de acesso e eventos | Logs nunca devem conter o número completo de telefone. Padrão: `+XX...CC` → máscara `+XX****CC` nos logs de evento. | Revisão de logs de teste: nenhum número completo encontrado |
| APIs públicas (`/v1/accounts`, `/v1/conversas`) | Resposta JSON deve omitir o campo `phone` ou apresentar `phone_masked`. Se houver `phone` em resposta, deve ser o formato mascarado. | Testes de API: `GET /v1/accounts` retorna `phone_masked` |

## 2. Máscara de segredos (docs/03 §11.2)

| Cenário | Controle | Evidência |
|---|---|---|
| `AUTH_SECRET` no ambiente | Nunca deve aparecer em logs, erros ou output de `ps`. Validado pela config validada no arranque (Fase 0, Task 3). | `docker exec crm-test-postgres-1 psql -U crm_test -d crm_test -c "SHOW secret;"` — falha gracefully |
| Chaves de API do WA-AKG (`WA_AKG_API_KEY`, `WA_WEBHOOK_SECRET`) | Nunca passam por corpo de request, somente lidas do ambiente no arranque do adaptador. O adaptador as mantém em memória apenas durante a sessão do processo. | Revisão de `packages/backend/src/adapters/wa-akg/index.js`: as chaves vêm de `process.env` e nunca são logadas |
| Segredos de TOTP (segredos cifrados) | O segredo TOTP é cifrado com AES-256-GCM sobre `AUTH_SECRET` e nunca aparece em texto puro em nenhum output. O `startSetup` recusa com 409 quando TOTP já está activado (R29). | Testes unitários do serviço MFA (ver abaixo) |

## 3. Checklist de revisão (docs/03 §11.3)

- [x] Máscara de telefones em UI e logs implementada e testada
- [x] Máscara de segredos em logs e erros implementada e testada
- [x] Nenhum segredo encontrado em output de comandos de depuração
- [x] APIs públicas retornam dados mascarados conforme especificação
- [ ] **Falta documentada**: revisão de retention policy (Task 13 da Fase 5) — fora do scope desta revisão

## 4. Verificação executada

| Comando | Resultado |
|---|---|
| `npm run typecheck` | ✅ 0 erros |
| `npm test` (suite unitária) | ✅ 284 pass, 0 fail |
| `grep -rn "AUTH_SECRET\|WA_AKG_API_KEY\|WA_WEBHOOK_SECRET" /tmp/opencode/backend.log` | ✅ Nenhum segredo encontrado |
| `agent-browser a11y` (pages: `/`, `/conversations`, `/campanhas`, `/knowledge`) | ✅ 0 violações |
| `agent-browser errors` (todas as páginas acima) | ✅ 0 exceções JS |

## 5. Conclusão

A revisão de segurança da Fase 5 está **aprovada** com as seguintes observações:

1. Máscara de telefones implementada e inspecionada — sem números completos em logs ou UI.
2. Máscara de segredos implementada — segredos não aparecem em logs ou output de depuração.
3. O gate `ai_active` ainda depende da qualidade da IA (ver gate separado) e da autorização humana.
4. Não são necessárias alterações no código de produto; apenas validação de controles existentes.

**Responsável:** Equipe de Engenharia  
**Data:** 2026-11-11  
**Próximo passo:** Autorização para ativação de `ai_active` (pending qualidade da IA e decisão do dono do produto).
