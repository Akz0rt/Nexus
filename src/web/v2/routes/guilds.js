const express = require('express');
const state = require('../../../state');
const { getPanelRole } = require('../access');

const router = express.Router();

// GET /api/v2/guilds — servers where the bot is and the user has panel access
router.get('/', async (req, res, next) => {
    try {
        const client = state.client;
        if (!client?.isReady?.()) return res.status(503).json({ error: 'bot_offline' });

        const guilds = [];
        for (const guild of client.guilds.cache.values()) {
            const role = await getPanelRole(guild, req.session.userId);
            if (role === 'none') continue;
            guilds.push({
                id: guild.id,
                name: guild.name,
                iconURL: guild.iconURL({ size: 128, extension: 'png' }),
                panelRole: role
            });
        }
        res.json({ guilds });
    } catch (error) {
        next(error);
    }
});

module.exports = router;
