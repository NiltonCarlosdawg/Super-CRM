import { WinstonLogger, createLogger, format, transports } from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

const { combine, timestamp, json, printf } = format;

const logFormat = combine(
  timestamp(),
  json(),
  printf(({ timestamp, level, message, ...meta }) => {
    return `${timestamp} ${level}: ${message} ${JSON.stringify(meta)}`;
  })
);

export const errorLogger = createLogger({
  level: 'error',
  format: logFormat,
  transports: [
    new transports.File({ filename: 'logs/error-.log' }),
    new transports.Console(),
  ],
});

export const combinedLogger = createLogger({
  level: 'info',
  format: logFormat,
  transports: [
    new transports.File({ filename: 'logs/combined-.log' }),
    new transports.Console(),
  ],
});
