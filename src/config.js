require('dotenv').config();

module.exports = {
    token: process.env.DISCORD_TOKEN,
    clientId: process.env.CLIENT_ID,
    guildId: process.env.GUILD_ID,
    timezone: process.env.TIMEZONE || 'UTC',
    birthdayChannel: process.env.BIRTHDAY_CHANNEL_ID,
    checkTime: process.env.CHECK_TIME || '00:00',
    maleRoleId: process.env.MALE_ROLE_ID,
    femaleRoleId: process.env.FEMALE_ROLE_ID,
    // Channel where congratulations (birthday announcements) are posted
    congratsChannel: process.env.CONGRATS_CHANNEL_ID,
    
    // Azure CosmosDB Configuration
    cosmosEndpoint: process.env.COSMOS_ENDPOINT,
    cosmosKey: process.env.COSMOS_KEY,
    cosmosDbName: process.env.COSMOS_DB_NAME || 'BirthdayBotDB',

    // OpenAI (AI assistant)
    openaiKey: process.env.OPENAI_API_KEY,
    openaiModel: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    aiChannelId: process.env.AI_CHANNEL_ID,
    aiMaxHistory: parseInt(process.env.AI_MAX_HISTORY || '20', 10),

    // Admin web dashboard
    adminUser: process.env.ADMIN_USER || 'admin',
    adminPassword: process.env.ADMIN_PASSWORD || '',
    port: parseInt(process.env.PORT || process.env.WEBSITES_PORT || '3000', 10),

    // Verification queue (defaults for GUILD_ID; per-guild overrides live in Cosmos guild_settings)
    unverifiedRoleId: process.env.UNVERIFIED_ROLE_ID,
    verifyQueueChannelId: process.env.VERIFY_QUEUE_CHANNEL_ID,
    moduleVerificationEnabled: process.env.MODULE_VERIFICATION_ENABLED,
    assignUnverifiedOnJoin: process.env.ASSIGN_UNVERIFIED_ON_JOIN,

    // Activity sync
    activitySyncIntervalMinutes: parseInt(process.env.ACTIVITY_SYNC_INTERVAL_MINUTES || '5', 10),
    activityBackfillDays: parseInt(process.env.ACTIVITY_BACKFILL_DAYS || '30', 10),
    activityBackfillPagesPerRun: parseInt(process.env.ACTIVITY_BACKFILL_PAGES_PER_RUN || '20', 10),
    activityIncrementalPagesPerRun: parseInt(process.env.ACTIVITY_INCREMENTAL_PAGES_PER_RUN || '10', 10),

    // Azure Management API (for syncing App Settings — requires Managed Identity)
    azureSubscriptionId: process.env.AZURE_SUBSCRIPTION_ID || '',
    azureResourceGroup: process.env.AZURE_RESOURCE_GROUP || '',
    azureWebAppName: process.env.AZURE_WEBAPP_NAME || ''
};