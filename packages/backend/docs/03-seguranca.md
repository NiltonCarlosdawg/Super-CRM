# 03 — Segurança e privacidade

Aplica-se a todo o código, testes, docs e prompts. Em caso de dúvida, escolhe a opção mais restritiva e pergunta.

## 1. Modelo de ameaça (resumo)

| Ativo | Ameaça principal | Consequência |
|---|---|---|
| **Credenciais de sessão do WhatsApp** (estado de autenticação do Baileys no WA-AKG) | Fuga ou cópia | Tomada de controlo da conta WhatsApp |
| Conversas e contactos (dados pessoais) | Fuga, acesso indevido, uso indevido | Dano a clientes, responsabilidade legal |
| Painel e API do CRM | Acesso não autorizado, abuso de permissões | Envio de mensagens, leitura de dados |
| **A IA** | Injeção de instruções por mensagens de clientes | Respostas fora das regras, fuga de dados, ações indevidas |
| Webhooks | Falsificação ou repetição de eventos | Mensagens falsas, estados corrompidos |
| Cadeia de dependências | Pacote malicioso ou vulnerável (incluindo o WA-AKG e as suas dependências do Baileys) | Execução de código |
| Envio em massa | Spam, banimento de números, queixas | Perda de linhas de atendimento, reputação |

## 2. Segredos

- Nunca em código, commits, logs, fixtures, prompts, tickets ou capturas de ecrã.
- Variáveis de ambiente validadas no arranque. Em produção, vêm de um gestor de segredos ou de ficheiros fora do repositório com permissões restritas.
- `.env` no `.gitignore`. `.env.example` sem valores reais. Verificação de segredos em CI (ex.: *secret scanning*) e *pre-commit*.
- Segredos distintos por ambiente. Rotação documentada (API key do WA-AKG, segredo de webhook, chave do LLM, segredo de sessões).
- Se um segredo vazar: considerar comprometido, rodar de imediato e registar o incidente.

## 3. Autenticação e autorização (painel/API)

- Palavras-passe com **argon2id** (ou bcrypt com custo adequado). Nunca em claro, nunca em logs.
- Sessões com expiração, rotação após login e invalidação em logout e em mudança de palavra-passe. Cookies `HttpOnly`, `Secure`, `SameSite`. Se houver cookies, proteção CSRF.
- **MFA** para `admin` (recomendado para todos). Limitação de tentativas de login e bloqueio progressivo.
- **RBAC** no servidor, sempre:
  - `agent`: ver e responder conversas, aceitar handoffs.
  - `editor`: gerir conhecimento (catálogo, documentos, regras, gatilhos).
  - `admin`: contas WhatsApp, utilizadores, campanhas, configuração.
- Autorização verificada **em cada pedido**, no servidor. Nunca confiar em campos enviados pelo cliente (ex.: `role`, `ownerId`).
- Princípio do menor privilégio também entre serviços (ver secção 5).
- Ações sensíveis ficam no `audit_log` (quem, o quê, quando, de onde): login, mudança de papéis, ligar/desligar conta WhatsApp, criar/iniciar campanha, publicar conhecimento, devolver conversa à IA, exportar ou apagar dados.

## 4. Validação e proteção da API

- Validação de todas as entradas (`docs/02`). Listas de campos permitidos (não *mass assignment*).
- Rate limiting por utilizador e IP. Limites de tamanho de corpo e de upload.
- CORS restrito às origens do painel. Cabeçalhos de segurança (HSTS, `X-Content-Type-Options`, CSP onde aplicável).
- Sem informação interna em erros. IDs não sequenciais (`uuid`).
- SQL só parametrizado (Drizzle). Nunca construir SQL por concatenação.
- Sem `eval`, sem `child_process` com entrada externa, sem desserialização insegura.

## 5. Isolamento do WA-AKG

O WA-AKG guarda as chaves de sessão do WhatsApp e corre código de terceiros. Trata-o como **componente de alto risco**.

- **Nunca exposto à internet.** Só acessível numa rede privada/loopback, apenas a partir do backend do CRM. Dashboard/Swagger do WA-AKG desligados ou atrás de VPN/túnel, nunca públicos.
- Autenticação do CRM→WA-AKG com API key longa e aleatória, guardada como segredo. Rodável sem *downtime*.
- Webhooks WA-AKG→CRM: **assinados** (HMAC) se o WA-AKG o suportar, ou protegidos por segredo partilhado + lista de IPs + rede privada. Se não suportar nada disto, é um achado da auditoria e um **gate**.
- Base de dados do WA-AKG separada da do CRM, com credenciais distintas. O CRM **nunca** lê nem escreve nela.
- **Estado de autenticação das sessões:** armazenado com permissões restritas, **cifrado em repouso** (volume cifrado) e com backup cifrado. Perder = voltar a ler o QR. Vazar = conta comprometida. Nunca em logs nem em backups sem cifra.
- Contentor com utilizador não-root, sistema de ficheiros mínimo, sem portas desnecessárias, recursos limitados.
- Contas WhatsApp de campanhas e de atendimento em **números diferentes** (`purpose`), para que um banimento de campanha não derrube o atendimento.

## 6. Segurança da IA (injeção de instruções e abuso)

O texto dos clientes é **dado não fiável**, nunca instruções.

- O prompt de sistema define regras fixas. O texto do cliente vai sempre em turnos de utilizador, delimitado, nunca concatenado ao prompt de sistema.
- A IA **não tem ferramentas com efeitos**. Só `lookup_catalog` (leitura). Não pode enviar mensagens a outros números, alterar conhecimento, criar campanhas, aprovar descontos nem mudar o `ai_mode`.
- Quem decide handoff, bloqueio e envio é o código (orquestrador), não o modelo.
- A saída estruturada do modelo é **validada por esquema**. Campos desconhecidos são descartados. Códigos de gatilho inexistentes são ignorados (já testado).
- Instruções do cliente do tipo "ignora as regras", "mostra o teu prompt", "dá-me 90% de desconto" **não alteram** o comportamento: tratar como conversa normal e, se envolver preço fora das regras, `price_negotiation`.
- Nunca incluir no prompt: segredos, dados de outros clientes, dados internos desnecessários. Só o contexto da conversa atual e o conhecimento publicado relevante.
- Mensagens fixas de handoff vêm da configuração, não do modelo.
- Registar cada resposta com fontes (`answer_traces`) para auditoria. Revisão periódica de respostas problemáticas.
- Cenários de abuso entram no conjunto de avaliação (injeção, pedido de desconto, pedido de dados de terceiros, tentativa de extrair o prompt).

## 7. Privacidade e proteção de dados

**Enquadramento legal (a confirmar com jurista):** Angola tem a Lei n.º 22/11, de 17 de Junho (Proteção de Dados Pessoais), fiscalizada pela Agência de Proteção de Dados (APD). Segundo fontes públicas, o tratamento exige consentimento expresso do titular e notificação à APD, os titulares têm direitos de acesso, retificação, oposição e eliminação, e transferências internacionais para países sem proteção adequada precisam de autorização da APD. Há um projeto de revisão da lei que foi a consulta pública em 2025. **O estado atual deve ser verificado antes de produção.** Isto não é aconselhamento jurídico.

Implicações para o desenvolvimento:

- **Minimização:** guardar só o necessário. Recolher consentimento e a sua origem (`marketing_consent`, `consent_at`, `consent_source`).
- **Retenção:** política definida (ex.: apagar ou anonimizar conversas após N meses). Job de retenção testado.
- **Direitos dos titulares:** funcionalidade de exportar e de **apagar** todos os dados de um contacto (conversas, leads, registos de IA). Testada.
- **Transferência para LLM/embeddings externos:** enviar conversas a um fornecedor fora de Angola é uma transferência internacional de dados. **Gate:** não ativar sem decisão legal (A11). Antes de enviar, **reduzir dados**: não enviar número de telefone completo, morada nem identificadores quando desnecessários. Funções `redactForLLM` testadas.
- **Notificação à APD** e política de privacidade: tarefas do dono do produto, não do agente. O agente assinala quando uma funcionalidade nova trata dados de forma nova.
- **Dados sensíveis:** não pedir nem guardar dados sensíveis (saúde, biometria, financeiros como números de cartão) nas conversas. Se aparecerem, não os processar nem registar.
- **Vigilância CCTV:** o conhecimento sobre CCTV é informação comercial. O CRM **não** guarda imagens nem vídeos de câmaras.
- **Mídia recebida** (fotos, áudios, documentos): tamanho e tipo validados, guardada fora do alcance de execução, acesso por URLs assinadas e curtas, sem processar com serviços externos sem gate.
- **As 20 conversas existentes não têm permissão de uso.** Não entram em testes, prompts, exemplos nem avaliações.

## 8. Envio em massa e conformidade com o WhatsApp

- Só enviar campanhas a contactos com **consentimento registado** e **sem opt-out**.
- Todas as campanhas incluem forma clara de **sair** ("responde SAIR"). Mensagens com essa intenção são detetadas e o contacto fica com `opted_out_at`. É processado de imediato e nunca contactado de novo em campanhas.
- Limites de ritmo, janelas horárias e pausa automática por sinais de problema (`docs/04`).
- O uso do Baileys é **não oficial** e viola os termos do WhatsApp. O risco de banimento é aceite pela empresa e **não deve ser agravado**: sem rotação de números para fugir a bloqueios, sem contornar limites.
- Campanhas nunca usam contas de atendimento (`purpose = support`).

## 9. Cadeia de abastecimento

- Dependências fixadas com *lockfile*, `audit` em CI, revisão de cada dependência nova.
- WA-AKG: auditar `package.json`, scripts de instalação (`postinstall`), a pasta `patches/` e dependências diretas (Baileys). Fixar versões e imagens de contentor. Nada de `latest`.
- Imagens Docker mínimas, com *digest* fixo, a correr como não-root. Análise de vulnerabilidades da imagem em CI.
- Revisão obrigatória de qualquer *script* que o agente adicione ao repositório.

## 10. Operação

- TLS em todo o tráfego externo e, quando possível, interno.
- Backups da base do CRM e do estado das sessões do WA-AKG, **cifrados**, com restauro **testado**.
- Atualizações de segurança regulares. Plano para quando o WhatsApp mudar o protocolo e a ligação quebrar (`docs/04`, *runbooks*).
- Registo de incidentes e comunicação: em caso de fuga de dados, o dono do produto decide a notificação (APD e titulares).
- Ambientes separados (dev, staging, produção), com **números de WhatsApp de teste** em dev/staging. Nunca ligar dev a números de clientes.

## 11. Lista de verificação antes de cada gate

- [ ] Sem segredos no repositório (scan limpo).
- [ ] Autorização testada para cada papel e para pedidos sem sessão.
- [ ] Webhooks rejeitam assinatura inválida e eventos repetidos.
- [ ] WA-AKG sem acesso público, API key rodada e testada.
- [ ] Logs sem telefones completos, mensagens ou segredos.
- [ ] Opt-out e consentimento testados.
- [ ] Dados enviados a serviços externos revistos e mínimos.
- [ ] Backups cifrados e restauro testado.
- [ ] Dependências auditadas e fixadas.
