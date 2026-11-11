// Startup file do Passenger (cPanel arranca `node <ficheiro>`, não `npm start`):
// reproduz `tsx --env-file-if-exists=.env src/infra/main.ts` — carrega o .env se
// existir, regista o loader do tsx e importa o entrypoint real.
import { register } from 'tsx/esm/api';

try {
  process.loadEnvFile(new URL('.env', import.meta.url));
} catch (err) {
  if (err?.code !== 'ENOENT') throw err; // sem .env: arranca com o ambiente do processo
}

register();
await import('./src/infra/main.ts');
