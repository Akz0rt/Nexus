# File Reference Guide - Birthday Bot

## Directory Structure

```
Birthday-Bot/
│
├── Documentation
│   ├── README.md                         Main project overview and setup
│   ├── INDEX.md                          Project navigation guide
│   ├── QUICK_SETUP.md                    Concise setup checklist
│   ├── AZURE_DEPLOYMENT.md               Full Azure deployment guide
│   ├── DEPLOYMENT_CHECKLIST.md           Pre-deployment verification checklist
│   ├── FILE_REFERENCE.md                 This file
│   └── MIGRATION_SUMMARY.md              Changelog / what's new
│
├── Configuration
│   ├── .env                              Environment variables (never commit)
│   ├── .gitignore                        Git ignore rules
│   └── package.json                      Node.js dependencies and scripts
│
├── CI/CD
│   └── .github/
│       └── workflows/
│           └── main_birthday-bot.yml     Auto-deploy on push to main
│
└── src/
    ├── index.js                          Bot entry point and event handlers
    ├── config.js                         Environment variable loader
    ├── deploy-commands.js                Registers slash commands with Discord
    │
    ├── commands/
    │   ├── birthday-set.js               /birthday-set slash command
    │   ├── birthday.js                   /birthday @user slash command
    │   └── birthdays-coming.js           /birthdays-coming slash command
    │
    ├── services/
    │   ├── AIService.js                  NEW: OpenAI assistant with function calling
    │   ├── BirthdayService.js            DEPRECATED: unused, kept for reference
    │   ├── CosmosDBService.js            Azure Cosmos DB read/write service
    │   ├── NotificationService.js        Birthday announcement logic
    │   └── SchedulerService.js           Daily birthday check scheduler
    │
    └── utils/
        └── dateUtils.js                  Date parsing and formatting helpers
```

## File Descriptions

### Entry Point

#### src/index.js
The bot's main file. Handles:
- Discord client initialization
- Slash command interaction routing
- MessageCreate event — routes @mentions and AI_CHANNEL_ID messages to AIService
- SchedulerService startup

#### src/config.js
Loads all environment variables from `.env` into a config object used across the application. Includes all 15 variables.

#### src/deploy-commands.js
One-time (or on-change) script that registers slash command definitions with the Discord API for the configured guild.

### Commands

#### src/commands/birthday-set.js
Handles the `/birthday-set` slash command. Opens a modal dialog asking for the user's birthday in DD/MM format, validates the input, and saves it to Cosmos DB via CosmosDBService.

#### src/commands/birthday.js
Handles the `/birthday @user` slash command. Looks up a user's birthday in Cosmos DB and displays the date along with the number of days until the next occurrence.

#### src/commands/birthdays-coming.js
Handles the `/birthdays-coming` slash command. Queries Cosmos DB for all birthdays occurring in the next 7 days and returns a formatted list.

### Services

#### src/services/AIService.js
NEW — Added in v2.0.

Implements the conversational AI assistant using the OpenAI API (gpt-4o-mini). Key behaviors:
- Triggered by @mention in any channel, or any message in AI_CHANNEL_ID
- Maintains per-channel conversation history (capped at 20 messages)
- Uses OpenAI function calling (tool use) to interact with Cosmos DB
- Available tools: query a birthday, list upcoming birthdays, set own birthday
- Permission enforcement: users can only set their own birthday

#### src/services/CosmosDBService.js
Provides the data access layer for Azure Cosmos DB. Methods include:
- `initialize()` — connects and ensures database/container exist
- `setBirthday(userId, month, day)` — upserts a birthday record
- `getBirthday(userId)` — fetches one user's birthday
- `getAllBirthdays()` — fetches all birthday records
- `getBirthdaysByDate(month, day)` — queries by month and day
- `getTodaysBirthdays()` — returns today's celebrants

#### src/services/BirthdayService.js
DEPRECATED. The original local JSON file-based birthday service. Kept for reference. Not used by any active code.

#### src/services/NotificationService.js
Handles sending birthday announcement messages to the configured Discord channels and assigning birthday roles.

#### src/services/SchedulerService.js
Sets up a cron-style scheduler that runs the birthday check daily at the configured CHECK_TIME and TIMEZONE.

### Utilities

#### src/utils/dateUtils.js
Date parsing, formatting, and calculation helpers used across commands and services.

### Configuration

#### .env
Local secrets file. Must never be committed to Git (it is listed in .gitignore).

All 15 required variables:

```env
DISCORD_TOKEN=
CLIENT_ID=
GUILD_ID=
BIRTHDAY_CHANNEL_ID=
CONGRATS_CHANNEL_ID=
AI_CHANNEL_ID=
MALE_ROLE_ID=
FEMALE_ROLE_ID=
CHECK_TIME=00:00
TIMEZONE=UTC
COSMOS_ENDPOINT=
COSMOS_KEY=
COSMOS_DB_NAME=BirthdayBotDB
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini
```

#### package.json
Node.js project manifest. Key production dependencies:
- `discord.js` v14 — Discord API client
- `@azure/cosmos` — Azure Cosmos DB SDK
- `openai` — OpenAI API client
- `node-cron` — Scheduler

## What Changed (Summary)

### v2.0 — AI Assistant

| Item | Change |
|------|--------|
| `src/services/AIService.js` | NEW — OpenAI-powered AI assistant |
| `src/index.js` | Updated — added MessageCreate handler for AI |
| `src/config.js` | Updated — added AI_CHANNEL_ID, OPENAI_API_KEY, OPENAI_MODEL |
| `package.json` | Updated — added `openai` dependency |
| `.env` | Updated — added AI_CHANNEL_ID, OPENAI_API_KEY, OPENAI_MODEL |

### v1.0 — Cosmos DB Migration

| Item | Change |
|------|--------|
| `src/services/CosmosDBService.js` | NEW — replaced local JSON storage |
| `src/commands/*.js` | Updated — all use CosmosDBService |
| `src/services/NotificationService.js` | Updated — uses CosmosDBService |
| `src/config.js` | Updated — added COSMOS_* variables |
| `package.json` | Updated — added `@azure/cosmos` dependency |

### Removed (no longer in project)
- `migrate.js` — data migration script (deleted, no longer needed)
- `verify-setup.js` — pre-deployment verification script (deleted)
- `birthdays.json` — local JSON birthday storage (deleted, data is in Cosmos DB)
- `run_test.js` — test runner (deleted)

## Quick Navigation

| Need | File |
|------|------|
| Initial setup | [QUICK_SETUP.md](QUICK_SETUP.md) |
| Full deployment guide | [AZURE_DEPLOYMENT.md](AZURE_DEPLOYMENT.md) |
| Pre-launch verification | [DEPLOYMENT_CHECKLIST.md](DEPLOYMENT_CHECKLIST.md) |
| Project overview | [README.md](README.md) |
| Changelog | [MIGRATION_SUMMARY.md](MIGRATION_SUMMARY.md) |
| AI assistant code | [src/services/AIService.js](src/services/AIService.js) |
| Database code | [src/services/CosmosDBService.js](src/services/CosmosDBService.js) |
