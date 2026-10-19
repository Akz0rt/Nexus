const { CosmosClient } = require('@azure/cosmos');
const crypto = require('node:crypto');
const config = require('../../config');
const AuditLogService = require('../../services/AuditLogService');

const NOTES_CONTAINER = 'member_notes';
const MAX_TEXT = 500;
const MAX_PER_MEMBER = 50;

/**
 * Moderator notes on a member («Просил не выключать микро на ивентах»).
 * Every moderator with panel access sees them; the author or an administrator
 * deletes them. The journal records that a note was added, never its text.
 */
class MemberNoteService {
    constructor() {
        this.client = null;
        this.container = null;
        this.initialized = false;
    }

    async initialize() {
        if (this.initialized) return;

        this.client = new CosmosClient({
            endpoint: config.cosmosEndpoint,
            key: config.cosmosKey
        });

        const database = this.client.database(config.cosmosDbName);
        await database.containers.createIfNotExists({
            id: NOTES_CONTAINER,
            partitionKey: { paths: ['/guildId'] }
        });

        this.container = database.container(NOTES_CONTAINER);
        this.initialized = true;
    }

    /** Newest first */
    async list(guildId, userId) {
        await this.initialize();
        const { resources } = await this.container.items.query({
            query: 'SELECT * FROM c WHERE c.guildId = @guildId AND c.userId = @userId ORDER BY c.createdAt DESC',
            parameters: [
                { name: '@guildId', value: guildId },
                { name: '@userId', value: userId }
            ]
        }, { partitionKey: guildId, maxItemCount: MAX_PER_MEMBER }).fetchNext();
        return resources || [];
    }

    async add(guildId, userId, text, actor, source = 'panel') {
        const clean = String(text || '').trim();
        if (!clean) return { ok: false, code: 'note_empty' };
        if (clean.length > MAX_TEXT) return { ok: false, code: 'note_too_long' };
        if ((await this.list(guildId, userId)).length >= MAX_PER_MEMBER) return { ok: false, code: 'too_many_notes' };

        const note = {
            id: crypto.randomUUID(),
            guildId,
            userId,
            text: clean,
            authorId: actor.id,
            createdAt: new Date().toISOString()
        };
        await this.container.items.create(note);
        await this.log(guildId, 'member.note_added', userId, actor, source);
        return { ok: true, note };
    }

    /** @param {boolean} senior an administrator may delete anyone's note */
    async remove(guildId, userId, noteId, actor, senior, source = 'panel') {
        await this.initialize();
        let note = null;
        try {
            ({ resource: note } = await this.container.item(noteId, guildId).read());
        } catch (error) {
            if (error.code !== 404) throw error;
        }
        if (!note || note.userId !== userId) return { ok: false, code: 'note_not_found' };
        if (note.authorId !== actor.id && !senior) return { ok: false, code: 'not_note_author' };

        await this.container.item(noteId, guildId).delete();
        await this.log(guildId, 'member.note_deleted', userId, actor, source);
        return { ok: true };
    }

    async log(guildId, action, userId, actor, source) {
        await AuditLogService.log({
            guildId,
            action,
            actorId: actor?.id || null,
            actorTag: actor?.tag || null,
            targetIds: [userId],
            source
        });
    }
}

module.exports = new MemberNoteService();
module.exports.MAX_TEXT = MAX_TEXT;
