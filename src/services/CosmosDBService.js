const { CosmosClient } = require("@azure/cosmos");
const config = require("../config");
const { isValidDate } = require("../utils/dateUtils");

// Each server keeps its own birthdays: partition /guildId, id = userId
const CONTAINER = "guild_birthdays";
// The old shared list (one date per person for the whole bot), copied once to the main server
const LEGACY_CONTAINER = "birthdays";
const META_PARTITION = "_meta";
const LEGACY_MARKER_ID = "legacy-birthdays-migrated";

function todayParts(timeZone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timeZone || config.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(new Date());
    const value = type => parts.find(part => part.type === type)?.value;
    return { year: value('year'), month: value('month'), day: value('day') };
}

class CosmosDBService {
    constructor() {
        this.client = null;
        this.database = null;
        this.container = null;
        this.initialized = false;
    }

    async initialize() {
        if (this.initialized) return;

        try {
            this.client = new CosmosClient({
                endpoint: config.cosmosEndpoint,
                key: config.cosmosKey
            });

            this.database = this.client.database(config.cosmosDbName);
            await this.database.containers.createIfNotExists({
                id: CONTAINER,
                partitionKey: { paths: ["/guildId"] }
            });
            this.container = this.database.container(CONTAINER);

            console.log("✅ CosmosDB initialized successfully");
            this.initialized = true;
        } catch (error) {
            console.error("❌ Failed to initialize CosmosDB:", error);
            throw error;
        }
    }

    async setBirthday(guildId, userId, month, day) {
        if (!isValidDate(month, day)) {
            throw new Error("Invalid date");
        }

        await this.initialize();

        try {
            // Keep the "congratulated" mark, or a changed date would be congratulated twice today
            const previous = await this.getBirthday(guildId, userId);
            const item = {
                id: userId,
                guildId,
                userId,
                month,
                day,
                createdAt: new Date().toISOString()
            };
            if (previous?.lastCongratulatedOn) item.lastCongratulatedOn = previous.lastCongratulatedOn;

            await this.container.items.upsert(item);
            console.log(`Birthday set for user ${userId} in ${guildId}: ${month}/${day}`);
        } catch (error) {
            console.error(`Failed to set birthday for user ${userId} in ${guildId}:`, error);
            throw error;
        }
    }

    async getBirthday(guildId, userId) {
        await this.initialize();

        try {
            const { resource: item } = await this.container.item(userId, guildId).read();
            return item ? { month: item.month, day: item.day, lastCongratulatedOn: item.lastCongratulatedOn || null } : null;
        } catch (error) {
            if (error.code === 404) {
                return null; // Item not found
            }
            console.error(`Failed to get birthday for user ${userId} in ${guildId}:`, error);
            throw error;
        }
    }

    async getAllBirthdays(guildId) {
        await this.initialize();

        try {
            const { resources: items } = await this.container.items
                .query({ query: "SELECT * FROM c WHERE c.guildId = @guildId", parameters: [{ name: "@guildId", value: guildId }] },
                    { partitionKey: guildId })
                .fetchAll();
            const birthdays = {};
            items.forEach((item) => {
                birthdays[item.userId] = { month: item.month, day: item.day, lastCongratulatedOn: item.lastCongratulatedOn || null };
            });
            return birthdays;
        } catch (error) {
            console.error(`Failed to get all birthdays of ${guildId}:`, error);
            throw error;
        }
    }

    async getBirthdaysByDate(guildId, month, day) {
        await this.initialize();

        try {
            // Support legacy records where month/day may be stored as strings.
            const querySpec = {
                query: `
                    SELECT c.userId FROM c
                    WHERE c.guildId = @guildId
                      AND (c.month = @month OR c.month = @monthStr)
                      AND (c.day = @day OR c.day = @dayStr)
                `,
                parameters: [
                    { name: "@guildId", value: guildId },
                    { name: "@month", value: month },
                    { name: "@day", value: day },
                    { name: "@monthStr", value: String(month) },
                    { name: "@dayStr", value: String(day) }
                ]
            };

            const { resources: items } = await this.container.items
                .query(querySpec, { partitionKey: guildId })
                .fetchAll();

            return items.map((item) => item.userId);
        } catch (error) {
            console.error(
                `Failed to get birthdays of ${guildId} for ${month}/${day}:`,
                error
            );
            throw error;
        }
    }

    /** Who has a birthday today on this server, by the server's own calendar date */
    async getTodaysBirthdays(guildId, timeZone) {
        const { month, day } = todayParts(timeZone);
        const m = parseInt(month, 10);
        const d = parseInt(day, 10);

        if (!Number.isInteger(m) || !Number.isInteger(d)) {
            throw new Error(`Failed to compute today's date for timezone ${timeZone}`);
        }

        console.log(`Checking birthdays of ${guildId} for ${d}/${m} in timezone ${timeZone || config.timezone}`);

        return await this.getBirthdaysByDate(guildId, m, d);
    }

    // Today's calendar date as "YYYY-MM-DD" in the server's timezone.
    // Used as the idempotency key for daily congratulations.
    getTodayDateString(timeZone) {
        const { year, month, day } = todayParts(timeZone);
        return `${year}-${month}-${day}`;
    }

    // True if this user has already been congratulated on this server on the given date.
    async wasCongratulatedOn(guildId, userId, dateStr) {
        await this.initialize();

        try {
            const { resource: item } = await this.container.item(userId, guildId).read();
            return !!item && item.lastCongratulatedOn === dateStr;
        } catch (error) {
            if (error.code === 404) return false;
            // Fail open (treat as "not congratulated") so a transient read error
            // never silently skips a real birthday.
            console.error(`Failed to read congratulation state for ${userId} in ${guildId}:`, error);
            return false;
        }
    }

    // Record that this user was congratulated on this server on the given date (idempotency marker).
    async markCongratulated(guildId, userId, dateStr) {
        await this.initialize();

        try {
            await this.container.item(userId, guildId).patch([
                { op: 'set', path: '/lastCongratulatedOn', value: dateStr }
            ]);
        } catch (error) {
            console.error(`Failed to mark congratulation for ${userId} in ${guildId}:`, error);
        }
    }

    async deleteBirthday(guildId, userId) {
        await this.initialize();

        try {
            await this.container.item(userId, guildId).delete();
            console.log(`Birthday deleted for user ${userId} in ${guildId}`);
        } catch (error) {
            if (error.code === 404) {
                return; // Item already doesn't exist
            }
            console.error(`Failed to delete birthday for user ${userId} in ${guildId}:`, error);
            throw error;
        }
    }

    /**
     * Once: copy the old shared list to the main server. Never overwrites a date
     * already set there, keeps the "congratulated" mark and leaves the old container
     * as it is. The done-mark is written only after every record was copied, so a
     * failed run simply repeats on the next start.
     * @returns {Promise<{ skipped: true } | { copied: number, existing: number }>}
     */
    async migrateLegacy(guildId) {
        await this.initialize();

        const marker = await this.container.item(LEGACY_MARKER_ID, META_PARTITION).read().then(r => r.resource).catch(error => {
            if (error.code === 404) return null;
            throw error;
        });
        if (marker) return { skipped: true };

        let items = [];
        try {
            ({ resources: items } = await this.database.container(LEGACY_CONTAINER).items.readAll().fetchAll());
        } catch (error) {
            if (error.code !== 404) throw error; // no old list at all
        }

        let copied = 0;
        let existing = 0;
        for (const old of items) {
            if (!old.userId) continue;
            const item = { id: old.userId, guildId, userId: old.userId, month: old.month, day: old.day, createdAt: old.createdAt || new Date().toISOString() };
            if (old.lastCongratulatedOn) item.lastCongratulatedOn = old.lastCongratulatedOn;
            try {
                await this.container.items.create(item);
                copied++;
            } catch (error) {
                if (error.code !== 409) throw error;
                existing++;
            }
        }

        await this.container.items.upsert({ id: LEGACY_MARKER_ID, guildId: META_PARTITION, targetGuildId: guildId, copied, existing, at: new Date().toISOString() });
        console.log(`Birthdays: copied ${copied} old record(s) to ${guildId} (${existing} already there)`);
        return { copied, existing };
    }
}

module.exports = new CosmosDBService();
