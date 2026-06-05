// Kraken action registry (v0)
// Each action has: name, description, paramSchema, handler

const crypto = require('crypto');

function hashParams(params) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(params || {}))
    .digest('hex').slice(0, 12);
}

const actions = {
  echo: {
    name: 'echo',
    description: 'Diagnostic echo - proves pipeline end-to-end',
    paramSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', minLength: 1, maxLength: 200 }
      },
      required: ['message']
    },
    handler: async (params, ctx) => {
      return { echoed: params.message, at: new Date().toISOString() };
    }
  },
  'incident.note': {
    name: 'incident.note',
    description: 'Append a note to the incident log',
    paramSchema: {
      type: 'object',
      properties: {
        note: { type: 'string', minLength: 1, maxLength: 500 },
        severity: { type: 'string', enum: ['info', 'warn'] }
      },
      required: ['note']
    },
    handler: async (params, ctx) => {
      const line = {
        type: 'kraken_note',
        traceId: ctx.traceId,
        note: params.note,
        severity: params.severity || 'info',
        at: new Date().toISOString()
      };
      const fs = require('fs');
      const logPath = process.env.INCIDENT_LOG_PATH || 'C:\\AtomArcade\\incident-log.jsonl';
      fs.appendFileSync(logPath, JSON.stringify(line) + '\n');
      return { written: true, path: logPath };
    }
  }
};

function getActions() {
  return Object.values(actions).map(a => ({
    name: a.name,
    description: a.description,
    paramSchema: a.paramSchema
  }));
}

function getAction(name) {
  return actions[name] || null;
}

module.exports = { actions, getActions, getAction, hashParams };
