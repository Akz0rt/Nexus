const express = require('express');
const LockdownService = require('../../../modules/lockdown/LockdownService');
const { actorOf, sendResult } = require('../result');

const router = express.Router({ mergeParams: true });

const STATUS = {
    forbidden: 403,
    already_active: 409,
    not_active: 409,
    in_progress: 409,
    bot_missing_manage_guild: 409
};

// GET /lockdown — everyone with panel access sees whether the server is closed
router.get('/', async (req, res, next) => {
    try {
        res.json(await LockdownService.status(req.guild));
    } catch (error) {
        next(error);
    }
});

// POST /lockdown/on, /lockdown/off — administrators only (checked by the service)
for (const [path, method] of [['/on', 'enable'], ['/off', 'disable']]) {
    router.post(path, async (req, res, next) => {
        try {
            sendResult(res, await LockdownService[method](req.guild, actorOf(req), 'panel'), STATUS);
        } catch (error) {
            next(error);
        }
    });
}

module.exports = router;
