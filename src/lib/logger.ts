import { pino, type Logger } from 'pino'

export type { Logger }

export function createLogger(level = 'info'): Logger {
  const pretty = process.stdout.isTTY && process.env.NODE_ENV !== 'production'
  return pino({
    level,
    base: undefined,
    redact: {
      paths: [
        'token',
        'password',
        '*.token',
        '*.password',
        'headers.authorization',
      ],
      censor: '***',
    },
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'HH:MM:ss',
              ignore: 'pid,hostname',
            },
          },
        }
      : {}),
  })
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}
