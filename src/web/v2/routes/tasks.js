const express = require('express');
const TaskService = require('../../../services/TaskService');
const { actorOf, sendResult } = require('../result');

// Background group actions of the person asking (the TaskTray in the app)
const router = express.Router({ mergeParams: true });

const STATUS = { task_not_found: 404, forbidden: 403, not_revertable: 409, task_running: 409, nothing_to_retry: 409 };

// GET /tasks — my running and recently finished tasks on this server
router.get('/', (req, res) => {
    res.json({ items: TaskService.list(req.guild.id, req.session.userId) });
});

const handle = run => async (req, res, next) => {
    try {
        sendResult(res, await run(req, actorOf(req)), STATUS);
    } catch (error) {
        next(error);
    }
};

// POST /tasks/:id/cancel — stop; members not reached yet stay as they are
router.post('/:id/cancel', handle((req, actor) => TaskService.cancel(req.params.id, req.guild.id, actor.id)));
// POST /tasks/:id/revert — «Отменить всё»: stop, then undo what was done (a new task)
router.post('/:id/revert', handle((req, actor) => TaskService.revert(req.params.id, req.guild.id, actor)));
// POST /tasks/:id/retry — «Повторить для неудачных» (a new task)
router.post('/:id/retry', handle((req, actor) => TaskService.retry(req.params.id, req.guild.id, actor)));

module.exports = router;
