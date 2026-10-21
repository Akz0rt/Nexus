const OpenAI = require('openai');
const config = require('../config');
const CosmosDBService = require('./CosmosDBService');
const GuildSettingsService = require('./GuildSettingsService');
const { getDaysUntilBirthday } = require('../utils/dateUtils');

const MAX_ITERATIONS = 5;

const TOOLS = [
    {
        type: 'function',
        function: {
            name: 'get_birthday',
            description: 'Get the birthday of a specific Discord user by their ID.',
            parameters: {
                type: 'object',
                properties: {
                    user_id: {
                        type: 'string',
                        description: 'The Discord user ID (snowflake). Extract from <@USER_ID> mention syntax in the message.'
                    }
                },
                required: ['user_id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_all_birthdays',
            description: 'Get all birthdays stored in the database.',
            parameters: { type: 'object', properties: {} }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_upcoming_birthdays',
            description: 'Get birthdays occurring within the next N days.',
            parameters: {
                type: 'object',
                properties: {
                    days: {
                        type: 'integer',
                        description: 'Number of days to look ahead (1-365). Default is 7.',
                        minimum: 1,
                        maximum: 365
                    }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_todays_birthdays',
            description: 'Get a list of user IDs whose birthday is today.',
            parameters: { type: 'object', properties: {} }
        }
    },
    {
        type: 'function',
        function: {
            name: 'set_birthday',
            description: 'Set or update the birthday for a user. Can ONLY be used to set the birthday of the user who sent the message.',
            parameters: {
                type: 'object',
                properties: {
                    user_id: {
                        type: 'string',
                        description: 'The Discord user ID of the person whose birthday to set. Must match the message author.'
                    },
                    month: {
                        type: 'integer',
                        description: 'Month number (1-12)',
                        minimum: 1,
                        maximum: 12
                    },
                    day: {
                        type: 'integer',
                        description: 'Day of month (1-31)',
                        minimum: 1,
                        maximum: 31
                    }
                },
                required: ['user_id', 'month', 'day']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'find_user_by_name',
            description: 'Search guild members by display name or username. Use when someone refers to a member by name without an @mention.',
            parameters: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: 'The name or partial name to search for'
                    }
                },
                required: ['name']
            }
        }
    }
];

class AIService {
    constructor() {
        this.client = null;
        this.initialized = false;
        this.conversationHistory = new Map(); // Map<channelId, Array<message>>
    }

    initialize() {
        if (this.initialized) return;
        this.client = new OpenAI({ apiKey: config.openaiKey });
        this.initialized = true;
        console.log('AIService initialized');
    }

    buildSystemPrompt(authorId, authorDisplayName, authorGender = null) {
        const dateStr = new Date().toLocaleDateString('en-US', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
        });
        return `You are Nexus, an AI assistant for a Discord server. Today is ${dateStr}.

Personality: Friendly, warm, and celebratory. Respond in the same language the user writes in (Russian or English).

SPEAKER GENDER: ${authorGender === 'male' ? 'The user is male — use masculine grammatical forms and addressing when speaking to them.' : authorGender === 'female' ? 'The user is female — use feminine grammatical forms and addressing when speaking to them.' : 'Gender is unknown — use gender-neutral or non-gendered forms when addressing the user.'}

Capabilities:
- Look up anyone's birthday
- List all birthdays or upcoming birthdays
- Help users set their OWN birthday

PERMISSION RULES (strictly enforced):
- A user may ONLY set their own birthday. Never call set_birthday with a user_id that differs from the message author's ID.
- Current message author: ${authorDisplayName} (ID: ${authorId})
- If asked to set another person's birthday, politely refuse.

DISCORD MENTION PARSING:
- User mentions appear as <@USER_ID> in raw message text, e.g. <@123456789>
- Extract the numeric USER_ID for tool calls
- If someone uses a plain name without @mention, use find_user_by_name first
- If multiple users match a name, ask the user to clarify with an @mention

OUTPUT FORMAT:
- Keep responses concise and conversational
- When referencing users, use <@USER_ID> format so Discord renders their name
- Format dates as "15 March" or "March 15"
- If a user has no birthday set, mention they can use /birthday-set`;
    }

    getHistory(channelId) {
        if (!this.conversationHistory.has(channelId)) {
            this.conversationHistory.set(channelId, []);
        }
        return this.conversationHistory.get(channelId);
    }

    pruneHistory(channelId) {
        const history = this.getHistory(channelId);
        while (history.length > config.aiMaxHistory) {
            history.splice(0, 2);
        }
    }

    async executeTool(toolName, args, guild, authorId) {
        try {
            // Birthdays are per server: the assistant only knows the list of the server it's asked on
            if (!guild && toolName !== 'find_user_by_name') {
                return JSON.stringify({ error: 'No guild context' });
            }
            switch (toolName) {
                case 'get_birthday': {
                    const birthday = await CosmosDBService.getBirthday(guild.id, args.user_id);
                    if (!birthday) {
                        return JSON.stringify({ found: false, user_id: args.user_id });
                    }
                    return JSON.stringify({
                        found: true,
                        user_id: args.user_id,
                        month: birthday.month,
                        day: birthday.day,
                        days_until: getDaysUntilBirthday(birthday.month, birthday.day)
                    });
                }

                case 'get_all_birthdays': {
                    const all = await CosmosDBService.getAllBirthdays(guild.id);
                    const enriched = {};
                    for (const [userId, data] of Object.entries(all)) {
                        enriched[userId] = {
                            ...data,
                            days_until: getDaysUntilBirthday(data.month, data.day)
                        };
                    }
                    return JSON.stringify(enriched);
                }

                case 'get_upcoming_birthdays': {
                    const days = args.days || 7;
                    const all = await CosmosDBService.getAllBirthdays(guild.id);
                    const upcoming = Object.entries(all)
                        .map(([userId, data]) => ({
                            user_id: userId,
                            month: data.month,
                            day: data.day,
                            days_until: getDaysUntilBirthday(data.month, data.day)
                        }))
                        .filter(b => b.days_until <= days)
                        .sort((a, b) => a.days_until - b.days_until);
                    return JSON.stringify(upcoming);
                }

                case 'get_todays_birthdays': {
                    const { timezone } = await GuildSettingsService.get(guild.id);
                    const userIds = await CosmosDBService.getTodaysBirthdays(guild.id, timezone);
                    return JSON.stringify({ user_ids: userIds, count: userIds.length });
                }

                case 'set_birthday': {
                    if (args.user_id !== authorId) {
                        return JSON.stringify({
                            success: false,
                            error: 'PERMISSION_DENIED',
                            message: 'You can only set your own birthday'
                        });
                    }
                    await CosmosDBService.setBirthday(guild.id, args.user_id, args.month, args.day);
                    return JSON.stringify({ success: true, user_id: args.user_id, month: args.month, day: args.day });
                }

                case 'find_user_by_name': {
                    if (!guild) {
                        return JSON.stringify({ found: false, error: 'No guild context' });
                    }
                    const members = await guild.members.fetch({ query: args.name, limit: 10 });
                    const matches = members
                        .map(m => ({
                            user_id: m.user.id,
                            display_name: m.displayName,
                            username: m.user.username
                        }));
                    return JSON.stringify({ found: matches.length > 0, matches });
                }

                default:
                    return JSON.stringify({ error: `Unknown tool: ${toolName}` });
            }
        } catch (error) {
            console.error(`Tool execution error [${toolName}]:`, error);
            return JSON.stringify({ error: error.message });
        }
    }

    async processMessage(content, authorId, authorDisplayName, channelId, guild, authorGender = null) {
        this.initialize();

        const history = this.getHistory(channelId);
        const systemMessage = {
            role: 'system',
            content: this.buildSystemPrompt(authorId, authorDisplayName, authorGender)
        };

        history.push({ role: 'user', content });
        this.pruneHistory(channelId);

        let messages = [systemMessage, ...history];

        for (let i = 0; i < MAX_ITERATIONS; i++) {
            const response = await this.client.chat.completions.create({
                model: config.openaiModel,
                messages,
                tools: TOOLS,
                tool_choice: 'auto'
            });

            const choice = response.choices[0];
            const assistantMessage = choice.message;

            messages.push(assistantMessage);

            if (choice.finish_reason === 'stop' || !assistantMessage.tool_calls) {
                history.push({ role: 'assistant', content: assistantMessage.content });
                return assistantMessage.content;
            }

            for (const toolCall of assistantMessage.tool_calls) {
                let toolArgs;
                try {
                    toolArgs = JSON.parse(toolCall.function.arguments);
                } catch {
                    toolArgs = {};
                }

                console.log(`AI tool call: ${toolCall.function.name}`, toolArgs);
                const result = await this.executeTool(toolCall.function.name, toolArgs, guild, authorId);

                messages.push({
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    content: result
                });
            }
        }

        const fallback = 'Извини, не удалось обработать запрос. Попробуй ещё раз.';
        history.push({ role: 'assistant', content: fallback });
        return fallback;
    }
}

module.exports = new AIService();
