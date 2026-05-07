'use strict';

const pino = require('pino');

// Use pino-pretty in development for human-readable output.
// In production, emit raw JSON so log aggregators (Datadog, Loki, etc.) can parse it.
const transport = process.env.NODE_ENV !== 'production'
  ? { target: 'pino-pretty', options: { colorize: true } }
  : undefined;

const logger = pino({ level: 'info', transport });

module.exports = logger;
