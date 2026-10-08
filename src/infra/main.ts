import { randomUUID } from 'node:crypto';

import { ConfigError, loadConfig } from './config.js';
import { createLogger, withCorrelationId } from './logger.js';

// Sem servidor HTTP nesta fase (Fastify chega na Fase 1).
try {
  const config = loadConfig(process.env);
  const log = withCorrelationId(createLogger({ level: config.logLevel }), randomUUID());

  log.info({ nodeEnv: config.nodeEnv, port: config.port }, 'application.started');
  process.exit(0);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  // Antes de existir logger: mensagem limpa no stderr, sem stack trace e sem valores das env.
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
