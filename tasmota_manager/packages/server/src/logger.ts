import pino, { type DestinationStream, type Logger } from 'pino';

const REDACT_PATHS = [
  'password',
  '*.password',
  'globalPassword',
  '*.globalPassword',
  'req.headers.authorization',
  'req.headers.cookie',
];

export function createLogger(level: string, destination?: DestinationStream): Logger {
  const options = { level, redact: { paths: REDACT_PATHS, censor: '***' } };
  return destination ? pino(options, destination) : pino(options);
}
