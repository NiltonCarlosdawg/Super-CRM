# ADR-0004: Dashboard e Swagger Públicos

## Contexto

As rotas `/api/docs` (Swagger/OpenAPI) e dashboard estão expostas sem autenticação adicional além da API key/header. Isso pode permitir acesso não autorizado à documentação da API e informações do sistema.

## Decisões

### Opção A: Proteção via NextAuth + Role Check (escolhida)
- Rotas `/api/docs` e `/api/swagger` exigem autenticação NextAuth
- Apenas usuários com role `admin` ou `owner` podem acessar
- API key header (`x-api-key`) ainda funciona para endpoints de API normais
- Em development (`NODE_ENV = development`), pode ser mais flexível

### Opção B: Proteção via Reverse Proxy
- Deixar as rotas públicas, mas proteger atrás de reverse proxy (NGINX, Traefik)
- O reverse proxy trata a autenticação (SSO, LDAP, etc.)
- O CRM não implementa auth nessas rotas
- Menor alteração no código do CRM

### Opção C: Acesso Público Intencional
- Documentação pública considerada benéfica para desenvolvedores
- Swagger ajuda em integrações de terceiros
- Não há risco percebido (já tem API key no header para endpoints reais)

## Decisão: Opção A (Proteção via NextAuth + Role Check)

A decisão é proteger as rotas de documentação com autenticação de usuário do CRM:

1. **Middlewares de proteção** para as rotas:
   - `GET /api/docs*` - require auth + admin role
   - `GET /api/swagger*` - require auth + admin role  
   - `GET /api/openapi*` - require auth + admin role

2. **Configuração de roles**:
   - Role `admin`: acesso total a docs e swagger
   - Role `owner`: acesso total a docs e swagger
   - Role `manager`: acesso restrito (somente leitura, sem schemas sensíveis)
   - Role `user`/`standard`: sem acesso (redirecionar para login)

3. **Implementation no Next.js/Express**:
   ```typescript
   // src/middleware/docs-protector.ts
   import { auth } from '@/auth';
   import { Role } from '@/prisma/enums';
   
   export async function docsProtector(req: Request, res: Response, next: NextFunction) {
     const session = await auth();
     
     if (!session?.user) {
       return res.status(401).json({ error: 'Não autenticado' });
     }
     
     // Verificar role
     const hasAccess = [Role.ADMIN, Role.OWNER].includes(session.user.role as Role);
     
     if (!hasAccess && process.env.NODE_ENV !== 'development') {
       return res.status(403).json({ error: 'Sem permissão para acessar documentação' });
     }
     
     // Em development, permitir acesso para facilidade de teste
     next();
   }
   ```

4. **Expor docs apenas via API versionada** (v1 ou v2), não raiz:
   - `/api/v1/docs` em vez de `/api/docs`
   - Ou usar `next-connect` middlewares com conditionais

5. **Exceção para development**:
   - Quando `NODE_ENV = development`, o middleware permite acesso sem restrição
   - Aviso nos logs: "Acesso a docs em modo development - não produzir em produção"
   - Lembrete em checklist de deploy: "Remover acesso development antes de prod"

6. **Alternative**: Em produção, servir docs via CDN ou ferramenta externa (Swagger UI served separately com auth do lado do proxy).

## Conseqüências

### Positivas:
- ✅ Impede acesso não autorizado à documentação da API
- ✅ Apenas admins/owners têm visibilidade completa dos endpoints
- ✅ Conformidade com princípio de menor privilégio
- ✅ Development ainda tem facilidade de teste (exceção controlada)
- ✅ Auditable: quem acessa docs fica registrado nos logs

### Negativas:
- ⚠️ Requer autenticação NextAuth em todas as rotas de docs
- ⚠️ Novo middleware a ser adicionado e mantido
- ⚠️ Em development, ainda precisa de lembrete para não fazer deploy com config padrão
- ⚠️ Roles precisam ser gerenciadas corretamente no usuário/onboarding

## Status

**Aprovado** - Proteção via NextAuth + role check é o equilíbrio entre segurança e usabilidade.

## Implementação Requerida

1. **Atualizar middleware de auth** para incluir verificação de role nas rotas de docs:
   ```typescript
   // src/middleware/docs-protector.ts (criar)
   export async function docsProtector(req: Request, res: Response, next: NextFunction) {
     // ... implementação como acima
   }
   ```

2. **Aplicar middleware nas rotas de docs** (em `src/server/routes.ts` ou equivalente):
   ```typescript
   import { docsProtector } from '../middleware/docs-protector';
   
   router.get('/api/v1/docs', docsProtector, (req, res) => {
     // servir swagger/ui
   });
   
   router.get('/api/v1/swagger', docsProtector, (req, res) => {
     // servir swagger json
   });
   ```

3. **Garantir que roles sejam atribuídas** nos usuários durante onboarding/criação:
   - Admin/Owner criados manualmente ou via onboarding flow
   - Padrão role para novo usuário ser `user` (sem acesso a docs)

4. **Atualizar `.env.example`** se houver necessidade de flag de controle:
   ```
   NODE_ENV=development  # permite acesso sem restrição em dev
   ```

5. **Testar ambos os modos**:
   - `NODE_ENV = production`: acesso negado sem auth + admin role
   - `NODE_ENV = development`: acesso liberado com warning nos logs

## Referências

- AGENTS.md regra #10: "Valida toda a entrada nas fronteiras (HTTP, webhooks, jobs, saída estruturada do LLM). TypeScript strict, sem any sem comentário a justificar."
- AGENTS.md regra #3: "Não inventes. Se uma informação não está nos docs nem no código, pergunta."
- Sistema de autenticação existente: `src/app/api/auth/routes` (já implementado na Fase 1)
- `src/auth/` - adapters e strategies já implementados

---
*Decisão registrada e aprovada.*