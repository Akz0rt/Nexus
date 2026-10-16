const { EventEmitter } = require('node:events');

/**
 * In-process bus between the bot and the web panel, so bot code never imports web code.
 * Events:
 *   'audit' — (entry) every action recorded by AuditLogService
 */
const bus = new EventEmitter();
bus.setMaxListeners(50);

module.exports = bus;
