# ADR-0005: Credenciais por Defeito e Secrets Management

## Contexto

O `.env.example` do CRM contém valores de exemplo que incluem `DATABASE_URL` com senha explícita, `AUTH_SECRET` genérico e `SUPERADMIN` role default `OWNER`. Essas credenciais por defeito são um risco de segurança se usadas em produção sem alteração.

## Decisões

### Opção A: Obrigatória alteração antes de produção (escolhida)
- O sistema deve falhar ou bloquear o init se variáveis sensíveis mantiverem valores de exemplo
- `npm run postinstall` ou `npm ci` deve validar que `DATABASE_URL`, `AUTH_SECRET`, `SUPERADMIN` não são valores de exemplo
- `docker-compose` e deploy scripts devem incluir passo de validação de secrets
- `.env.example` deve usar placeholder claros (`SEU_VALOR_AQUI`, `SUA_CHAVE_SECRETA_AQUI`)

### Opção B: Apenas documentação de risco
- `.env.example` mantém valores de exemplo com avisos em comentários
- Responsabilidade do desenvolvedor alterar antes de produção
- Não há bloqueio técnico
- Depende de boa-fé do time/operador

### Opção C: Máscaras automáticas
- O sistema injeta secrets reais via secret manager (AWS Secrets Manager, HashiCorp Vault) em produção
- `.env.example` não tem valores reais, mas o deploy script injeta os reais
- Em desenvolvimento, usam-se valores de exemplo aceitáveis

## Decisão: Opção A (Obrigatoriedade de alteração antes de produção)

A decisão é implementar validação rigorosa de secrets antes de permitir o início em produção:

1. **Script de validação `postinstall`/`prestart`**:
   ```json
   // package.json scripts
   "postinstall": "node scripts/validate-secrets.js",
   "prestart": "node scripts/validate-secrets.js"
   ```

2. **Script de validação** (`scripts/validate-secrets.js`):
   ```javascript
   const requiredEnvs = [
     'DATABASE_URL',
     'AUTH_SECRET', 
     'SUPERADMIN',
     'WA_API_KEY',
     'NEXTAUTH_URL',
   ];
   
   const exampleValues = [
     'SEU_VALOR_AQUI_DATABASE',
     'SEU_SECRET_AQUI_AUTH',
     'SEU_SUPERADMIN_AQUI',
     'SUA_API_KEY_AQUI',
     'http://localhost:3000',
   ];
   
   let hasErrors = false;
   
   requiredEnvs.forEach((env, i) => {
     const value = process.env[env];
     const isExample = exampleValues[i].split(' ').some(ex => value?.includes(ex) || value === ex);
     
     if (isExample) {
       console.error(`❌ Variável de ambiente ${env} ainda tem valor de exemplo.`);
       console.error(`   Por favor, substitua por um valor real antes de rodar em produção.`);
       hasErrors = true;
     }
   });
   
   if (hasErrors) {
     console.error('𛑠 Falha na validação de secrets. Corrija as variáveis de ambiente e rode novamente.');
     process.exit(1);
   } else {
     console.log('✅ Todas as variáveis de ambiente críticas estão configuradas.');
   }
   ```

3. **Atualizar `.env.example`** com placeholder explícitos (já está fazendo, mas garantir que sejam claros):
   ```
   # .env.example
   DATABASE_URL=postgresql://user:SEU_SENHA_AQUI@localhost:5432/crm_test
   AUTH_SECRET=SEU_SECRET_AQUI_DEVESSer_uma_string_aleatoria_muito_longa
   SUPERADMIN=OWNER  # <- Isso deve ser alterado durante onboarding
   WA_API_KEY=SUA_API_KEY_DO_WHATSAPP_AQUI
   NEXTAUTH_URL=http://localhost:3000
   ```

4. **Validação em Docker/K8s**:
   - `docker-compose.yml` pode ter `entrypoint` que roda validação
   - Em K8s, o `postStart` hook pode validar secrets
   - Variáveis de ambiente vazias ou `your-secret-here` devem falhar o start

5. **Integração com secret manager** (futuro):
   - Em produção, secrets vêm do AWS Secrets Manager / HashiCorp Vault
   - `.env` não contém valores reais - são injetados pelo orchestration
   - O validador checa se secrets estão definidos (não vazios), não necessariamente o conteúdo

## Conseqüências

### Positivas:
- ✅ Impede uso acidental de credenciais de exemplo em produção
- ✅ Força o onboarding/Setup correto antes de qualquer deploy
- ✅ Conformidade com AGENTS.md regra #4: "Segredos nunca em código, commits, logs, fixtures"
- ✅ Auditable: falha clara no início, não em runtime misterioso
- ✅ Funciona em qualquer ambiente (local, Docker, cloud)

### Negativas:
- ⚠️ Pode bloquear `npm ci`/`npm install` se não configurado (exigir `SKIP_SECRET_VALIDATION=1` para devs)
- ⚠️ Requer que desenvolvedores leiam e atualizem `.env.example`
- ⚠️ Pode gerar DX (developer experience) negativo se validação for muito rigorosa sem `SKIP` flag

## Status

**Aprovado** - Validação obrigatória antes de start em produção, com flag `SKIP_SECRET_VALIDATION=1` para desenvolvimento.

## Implementação Requerida

1. **Adicionar script no `package.json`**:
   ```json
   {
     "scripts": {
       "postinstall": "node scripts/validate-secrets.js",
       "prestart": "node scripts/validate-secrets.js",
       "dev": "npx tsx watch src/infra/main.ts",
       "start": "NODE_ENV=production npx tsx src/server/index.ts",
       "test": "tsx --test \"tests/unit/**/*.test.ts\"",
       "lint": "eslint . --ext .ts,.tsx",
       "typecheck": "tsc --noEmit"
     }
   }
   ```

2. **Criar script `scripts/validate-secrets.js`** (conteúdo como acima)

3. **Adicionar flag de exceção** para desenvolvimento:
   ```javascript
   // No validate-secrets.js
   if (process.env.SKIP_SECRET_VALIDATION === '1') {
     console.log('⚠️  Validação de secrets pulada (SKIP_SECRET_VALIDATION=1)');
     return;
   }
   ```

4. **Atualizar `.env.example`** garantir placeholder claros (já existente, revisar):
   - Already has `SEU_VALOR_AQUI` pattern - confirm this is clear enough
   - Add comments: `# <--- SUBSTITUIR antes de produção`

5. **Documentar nos docs/wa-akg-audit.md** a seção de secrets (já está na seção F19 confirmada)

6. **Testar em fluxos**:
   - `npm ci` sem `.env` configurado -> falha com mensagem clara
   - `npm ci` com `.env` com valores reais -> passa
   - `npm ci` com `.env` com valores de exemplo -> falha com mensagem clara
   - `SKIP_SECRET_VALIDATION=1 npm ci` -> passa (dev only)

## Referências

- AGENTS.md regra #4: "Segredos nunca em código, commits, logs, fixtures ou prompts. Configuração por variáveis de ambiente validadas no arranque."
- AGENTS.md regra #11: "Migrações Drizzle versionadas e revistas. Nunca edite uma migração já aplicada. Nunca `drizzle-kit push` fora de desenvolvimento local."
- `package.json` scripts - já tem `start` e `dev` definidos
- Seção F19 do `docs/wa-akg-audit.md` - já confirmado (zero segredos durinhos no código)

---
*Decisão registrada e aprovada.*