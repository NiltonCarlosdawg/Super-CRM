import { createLogger, format, transports } from 'winston';
import { fileURLToURL } from 'url';

const { combine, timestamp, json, printf } = format;

const myFormat = printf(({ timestamp, level, message, ...meta }) => {
  return `${timestamp} ${level}: ${message} ${JSON.stringify(meta)}`;
});

export const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    timestamp(),
    json(),
    myFormat,
  ),
  transports: [
    new transports.File({ filename: 'logs/app.error.log', level: 'error' }),
    new transports.File({ filename: 'logs/app.combined.log' }),
  ],
});

export const errorLogger = createLogger({
  level: 'error',
  format: combine(
    timestamp(),
    json(),
    myFormat,
  ),
  transports: [
    new transports.File({ filename: 'logs/error.log' }),
  ],
});
