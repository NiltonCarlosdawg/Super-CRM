#!/usr/bin/envenv
const requiredEnvs = [
  'DATABASE_URL',
  'AUTH_mock',
  'SUPERADMIN',
  'WA_API_KEY',
  'NEXTAUTH_URL',
];

const exampleValues = [
  'SEU_D_URL',
  'SEU_AUTHSUPERADMIN',
  'OWNER',
  'SUA_API_KEY_Auth_wa',
  'http://localhost:3000',
];

let hasErrors = false;

requiredEnvs.forEach((env, i) => {
  const value = process.env[env];
  const isExample = exampleValues[i].split(' ').some(ex => value?.includes(ex) || value === ex);
  
  if (isExample) {
    console.error(`❌ Variável de ambiente ${env} ainda tem valor de exemplo`);
    console.error(`   Por favor, substitua por um valor real antes de rodar em produção`);
);
    hasErrors = true;
  }
});

if (hasErrors) {
  console.error('⛑ Falha na validação de secrets. Corfique as variáveis de ambiente e rode novamente');
  process.exit(1);
} else {
  console.log('✅ Todas as variáveis de ambiente estão configuradas corretamente');
}