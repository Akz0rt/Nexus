/**
 * Bot modules. Each module is { name, register(client), onReady?(client),
 * interactionPrefix?, handleInteraction?(interaction) }.
 * onReady hooks run concurrently so a slow one (activity backfill) doesn't
 * delay the others (queue rebuild).
 */
const modules = [
    require('./birthdays'),
    require('./ai'),
    require('./activity'),
    require('./invites'),
    require('./verification'),
    require('./moderation'),
    require('./voice'),
    require('./roles'),
    require('./messagelog'),
    require('./reports'),
    require('./events'),
    require('./rolemenus'),
    require('./economy')
];

function registerModules(client) {
    for (const mod of modules) {
        mod.register(client);
    }
}

async function runReadyHooks(client) {
    await Promise.all(modules
        .filter(mod => mod.onReady)
        .map(async mod => {
            try {
                await mod.onReady(client);
            } catch (error) {
                console.error(`Module ${mod.name} onReady error:`, error.message || error);
            }
        }));
}

/** Route a component/modal interaction to the module owning its customId prefix. */
function findInteractionHandler(customId) {
    const prefix = String(customId || '').split(':')[0];
    return modules.find(mod => mod.interactionPrefix && mod.interactionPrefix === prefix) || null;
}

module.exports = { modules, registerModules, runReadyHooks, findInteractionHandler };
