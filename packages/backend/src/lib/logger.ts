import pino from 'pino';
import { fileURLToFileURLPath } from 'url';
import { createWriteStream } from 'fs';

const accessLogStream = createWriteStream('./logs/access.log', { flags: 'a' });

const logger = pino(
  {
    level: process.env.LOG_LEVEL || 'info',
    transport: {
      target: 'pino/file',
      destination: './logs/combined.log',
    },
    base: {
      pid: process.pid,
    },
  },
  accessLogStream
);

export { logger };
