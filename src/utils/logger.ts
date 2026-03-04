// src/utils/logger.ts
// Structured JSON logger. Never logs tokens, passwords, or secrets.
// All log lines include: timestamp, level, service, message, and context.

import fs from 'fs';
import path from 'path';
import { config } from '../config/env';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  service: string;
  message: string;
  [key: string]: unknown;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// Redact known sensitive key patterns from any log context object
const SENSITIVE_KEY_PATTERNS = [
  /token/i,
  /secret/i,
  /password/i,
  /passwd/i,
  /authorization/i,
  /accesskey/i,
  /apikey/i,
  /api_key/i,
  /private/i,
];

function redactSensitive(obj: unknown, depth = 0): unknown {
  if (depth > 8) return '[deep]';
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    // Truncate very long strings that might be tokens
    return obj.length > 500 ? obj.substring(0, 50) + '...[truncated]' : obj;
  }
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => redactSensitive(item, depth + 1));
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const isSensitive = SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
    result[key] = isSensitive ? '[REDACTED]' : redactSensitive(value, depth + 1);
  }
  return result;
}

class Logger {
  private service: string;
  private minLevel: LogLevel;
  private logStream: fs.WriteStream | null = null;

  constructor(service: string) {
    this.service = service;
    this.minLevel = (config.logging.level as LogLevel) || 'info';
    this.initFileStream();
  }

  private initFileStream(): void {
    try {
      const logDir = config.logging.dir;
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      const today = new Date().toISOString().split('T')[0];
      const logFile = path.join(logDir, `social-publisher-${today}.log`);
      this.logStream = fs.createWriteStream(logFile, { flags: 'a' });
    } catch {
      // If file logging fails, continue with stdout only
      this.logStream = null;
    }
  }

  private shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.minLevel];
  }

  private write(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      service: this.service,
      message,
      ...(context ? (redactSensitive(context) as Record<string, unknown>) : {}),
    };

    const line = config.logging.format === 'pretty'
      ? `[${entry.timestamp}] [${level.toUpperCase().padEnd(5)}] [${this.service}] ${message}${
          context ? '\n  ' + JSON.stringify(redactSensitive(context), null, 2).replace(/\n/g, '\n  ') : ''
        }`
      : JSON.stringify(entry);

    // Write to stdout
    if (level === 'error' || level === 'warn') {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }

    // Write to daily log file
    if (this.logStream) {
      this.logStream.write(JSON.stringify(entry) + '\n');
    }
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.write('debug', message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.write('info', message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.write('warn', message, context);
  }

  error(message: string, error?: unknown, context?: Record<string, unknown>): void {
    const errorContext: Record<string, unknown> = { ...context };

    if (error instanceof Error) {
      errorContext.errorName = error.name;
      errorContext.errorMessage = error.message;
      // Only include stack in non-production or debug
      if (config.nodeEnv !== 'production' || this.minLevel === 'debug') {
        errorContext.stack = error.stack;
      }
    } else if (error !== undefined) {
      errorContext.errorRaw = String(error);
    }

    this.write('error', message, Object.keys(errorContext).length > 0 ? errorContext : undefined);
  }

  close(): void {
    if (this.logStream) {
      this.logStream.end();
    }
  }
}

// Factory function — each service/module gets its own logger with service label
export function createLogger(service: string): Logger {
  return new Logger(service);
}

export type { Logger };
