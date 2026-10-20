const cron = require('node-cron');
const config = require('../config');
const NotificationService = require('./NotificationService');

const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

class SchedulerService {
    constructor() {
        this.checkTime = config.checkTime;
        this.activeJobs = new Set();
    }

    async checkBirthdays() {
        console.log(`Running birthday check at ${new Date().toLocaleString()}`);
        try {
            await NotificationService.sendBirthdayNotifications();
            console.log('Birthday notifications processed successfully');
        } catch (error) {
            console.error('Error processing birthday notifications:', error);
        }
    }

    /**
     * @param {{ checkTime?: string, initialCheck?: boolean }} [options] a new time from Settings
     *   reschedules without the catch-up check (that one runs once, at startup)
     */
    start({ checkTime, initialCheck = true } = {}) {
        // A malformed time (a hand-edited value, CHECK_TIME="9") falls back instead of leaving no job
        const time = [checkTime, this.checkTime, config.checkTime, '00:00'].find(value => TIME_RE.test(String(value || '')));
        if (time !== checkTime && checkTime) console.error(`Birthday check time "${checkTime}" is not HH:MM — using ${time}`);

        // Stop any existing jobs
        this.stop();
        this.checkTime = time;

        // Perform initial check
        if (initialCheck) this.checkBirthdays();

        // Schedule birthday check at configured time
        const job = cron.schedule(this.getCronExpression(), () => this.checkBirthdays(), {
            timezone: config.timezone
        });

        this.activeJobs.add(job);
        console.log(`Birthday check scheduled for ${this.checkTime} ${config.timezone}`);
    }

    stop() {
        // Stop all active jobs
        for (const job of this.activeJobs) {
            job.stop();
        }
        this.activeJobs.clear();
    }

    getCronExpression() {
        const [hours, minutes] = this.checkTime.split(':');
        return `${minutes} ${hours} * * *`;
    }
}

module.exports = new SchedulerService();