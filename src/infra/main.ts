import { randomUUID } from 'node:crypto';

import { ConfigError, loadConfig } from './config.js';

// Fase 0: escrita direta; a Task 4 substitui por logger estruturado.
// Sem servidor HTTP nesta fase (Fastify chega na Fase 1).
try {
  const config = loadConfig(process.env);
  const correlationId = randomUUID();

  process.stdout.write(
    `${JSON.stringify({
      level: 'info',
      msg: 'application.started',
      correlationId,
      nodeEnv: config.nodeEnv,
      port: config.port,
    })}\n`,
  );
  process.exit(0);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  // Sem stack trace e sem valores das env: só a lista de issues.
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
