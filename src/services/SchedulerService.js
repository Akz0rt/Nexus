const cron = require('node-cron');
const config = require('../config');
const NotificationService = require('./NotificationService');

const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

/** One daily birthday check per server, at that server's time in its timezone */
class SchedulerService {
    constructor() {
        this.jobs = new Map(); // guildId -> { job, checkTime, timezone }
    }

    async checkBirthdays(guild) {
        console.log(`Running birthday check for ${guild.id} at ${new Date().toLocaleString()}`);
        try {
            await NotificationService.sendBirthdayNotifications(guild);
            console.log(`Birthday notifications for ${guild.id} processed successfully`);
        } catch (error) {
            console.error(`Error processing birthday notifications for ${guild.id}:`, error);
        }
    }

    /**
     * (Re)schedule one server. A new time from Settings reschedules without the
     * catch-up check (that one runs once, at startup or when the bot joins).
     * @param {import('discord.js').Guild} guild
     * @param {{ checkTime?: string, timezone?: string, initialCheck?: boolean }} [options]
     */
    start(guild, { checkTime, timezone, initialCheck = true } = {}) {
        // A malformed time (a hand-edited value, CHECK_TIME="9") falls back instead of leaving no job
        const time = [checkTime, config.checkTime, '00:00'].find(value => TIME_RE.test(String(value || '')));
        if (time !== checkTime && checkTime) console.error(`Birthday check time "${checkTime}" of ${guild.id} is not HH:MM — using ${time}`);
        const zone = timezone || config.timezone;

        this.stop(guild.id);

        if (initialCheck) this.checkBirthdays(guild);

        const [hours, minutes] = time.split(':');
        const job = cron.schedule(`${minutes} ${hours} * * *`, () => this.checkBirthdays(guild), { timezone: zone });
        this.jobs.set(guild.id, { job, checkTime: time, timezone: zone });
        console.log(`Birthday check for ${guild.id} scheduled for ${time} ${zone}`);
    }

    /** Stop one server's check (the bot left it), or all of them */
    stop(guildId) {
        for (const [id, { job }] of this.jobs) {
            if (guildId && id !== guildId) continue;
            job.stop();
            this.jobs.delete(id);
        }
    }
}

module.exports = new SchedulerService();
