const { EventEmitter } = require('node:events');

/**
 * In-process bus between the bot and the web panel, so bot code never imports web code.
 * Events:
 *   'audit' — (entry) every action recorded by AuditLogService
 *   'voice' — ({ guildId, userId?, channelId?, channels? }) someone joined, left or
 *             changed state in voice, or voice channels changed
 *   'job'   — (job) progress of a mass role change (RoleJobService)
 */
const bus = new EventEmitter();
bus.setMaxListeners(50);

module.exports = bus;
