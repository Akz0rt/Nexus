# Discord Birthday Bot

A Discord bot that manages and celebrates server members' birthdays, with an AI assistant powered by OpenAI.

## Features

- Set birthdays via a slash command modal (DD/MM format)
- Look up any member's birthday and days remaining
- List all birthdays coming in the next 7 days
- Automatic birthday announcements in a designated channel
- Role assignment on a member's birthday
- Daily birthday checks at a configurable time and timezone
- AI assistant that responds to @mentions or in a dedicated channel, with natural language support for querying and setting birthdays
- Verification queue: members holding the unverified role get a card in the moderators' channel with **Male / Female / Kick** buttons; approving swaps the unverified role for the gender role in one call
- Action log in Cosmos DB (`audit_log`, kept 30 days); it will be shown in the new admin panel

## Slash Commands

| Command | Description |
|---------|-------------|
| `/birthday-set` | Opens a modal to set your own birthday (DD/MM format) |
| `/birthday @user` | Shows a user's birthday and how many days until it |
| `/birthdays-coming` | Lists all birthdays occurring in the next 7 days |

## AI Assistant

The bot includes a conversational AI assistant backed by OpenAI (gpt-4o-mini).

### How to trigger it

- **@mention** the bot in any channel: `@BirthdayBot when is @Alice's birthday?`
- **Send any message** in the channel configured as `AI_CHANNEL_ID`

### What it can do

- Look up a member's birthday
- List upcoming birthdays
- Set your own birthday via natural language ("set my birthday to March 15")
- Hold general conversation

### Permissions

Users may only set their **own** birthday through the AI. Requests to set another user's birthday are refused.

### Example interactions

```
User: @BirthdayBot when is @Sarah's birthday?
Bot:  Sarah's birthday is on 24 June. That's 47 days away!

User: @BirthdayBot set my birthday to 10/08
Bot:  Done! I've set your birthday to 10 August.

User: @BirthdayBot who has a birthday this week?
Bot:  Coming up in the next 7 days: Alex (tomorrow), Jordan (in 5 days).
```

The assistant maintains per-channel conversation history (up to 20 messages) and uses OpenAI function calling to read and write Cosmos DB directly.

## Setup

### 1. Clone and install

```bash
git clone <repo-url>
cd Birthday-Bot
npm install
```

### 2. Create a .env file

Copy the template below into a file named `.env` at the project root and fill in all values.

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
UNVERIFIED_ROLE_ID=
VERIFY_QUEUE_CHANNEL_ID=
```

### 3. Enable Message Content Intent

In the [Discord Developer Portal](https://discord.com/developers/applications):

1. Select your application
2. Go to **Bot**
3. Under **Privileged Gateway Intents**, enable **Message Content Intent**
4. Save changes

The AI assistant will not receive message content without this intent.

Also enable **Server Members Intent** on the same page. The bot requests `GuildMembers` for the verification queue, and **login fails ("disallowed intents") if it is not enabled** — this takes down every feature, not just the queue.

For the verification queue the bot needs **Manage Roles** and **Kick Members**, and its role must sit above the unverified role and both gender roles.

### 4. Register slash commands

```bash
node src/deploy-commands.js
```

### 5. Run the bot

```bash
node src/index.js
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCORD_TOKEN` | Yes | — | Discord bot token |
| `CLIENT_ID` | Yes | — | Discord application client ID |
| `GUILD_ID` | Yes | — | Discord server (guild) ID |
| `BIRTHDAY_CHANNEL_ID` | Yes | — | Channel for birthday announcements |
| `CONGRATS_CHANNEL_ID` | Yes | — | Channel for congratulations messages |
| `AI_CHANNEL_ID` | Yes | — | Channel where all messages are routed to the AI assistant |
| `MALE_ROLE_ID` | Yes | — | Role ID assigned to male members on their birthday |
| `FEMALE_ROLE_ID` | Yes | — | Role ID assigned to female members on their birthday |
| `CHECK_TIME` | No | `00:00` | Time of day to run the birthday check (HH:MM) |
| `TIMEZONE` | No | `UTC` | Timezone for the birthday check scheduler |
| `COSMOS_ENDPOINT` | Yes | — | Azure Cosmos DB endpoint URL (ends with `:443/`) |
| `COSMOS_KEY` | Yes | — | Azure Cosmos DB primary key |
| `COSMOS_DB_NAME` | No | `BirthdayBotDB` | Cosmos DB database name |
| `OPENAI_API_KEY` | Yes | — | OpenAI API key |
| `OPENAI_MODEL` | No | `gpt-4o-mini` | OpenAI model name |
| `UNVERIFIED_ROLE_ID` | No | — | Unverified role (set by a third-party bot); enables the verification queue |
| `VERIFY_QUEUE_CHANNEL_ID` | No | — | Moderators' channel for queue cards |
| `MODULE_VERIFICATION_ENABLED` | No | `true` if `UNVERIFIED_ROLE_ID` is set | Set `false` to turn the queue off |

The verification variables are defaults for `GUILD_ID`. Per-guild values can override them in the Cosmos `guild_settings` container (document `id` = guild ID), which the new panel will edit.

## Project Structure

```
Birthday-Bot/
├── src/
│   ├── commands/
│   │   ├── birthday-set.js        # /birthday-set slash command
│   │   ├── birthday.js            # /birthday @user slash command
│   │   └── birthdays-coming.js    # /birthdays-coming slash command
│   ├── modules/                   # Bot features: each registers its own event handlers
│   │   ├── index.js               # Module loader + interaction routing by customId prefix
│   │   ├── birthdays/             # Notification channels + daily scheduler
│   │   ├── ai/                    # AI channel message handler
│   │   ├── activity/              # Voice sessions + activity sync crons
│   │   └── verification/          # Verification queue: cards, buttons, startup rebuild
│   ├── services/
│   │   ├── AIService.js           # OpenAI assistant + function calling
│   │   ├── BirthdayService.js     # Deprecated, unused
│   │   ├── CosmosDBService.js     # Cosmos DB read/write operations
│   │   ├── AuditLogService.js     # Action log (audit_log, TTL 30 days)
│   │   ├── GuildSettingsService.js # Per-guild settings (guild_settings) with env fallback
│   │   ├── NotificationService.js # Birthday announcement logic
│   │   └── SchedulerService.js    # Daily birthday check scheduler
│   ├── utils/
│   │   └── dateUtils.js           # Date parsing and formatting helpers
│   ├── config.js                  # Environment variable loader
│   ├── deploy-commands.js         # Registers slash commands with Discord
│   └── index.js                   # Bot entry point
├── .github/
│   └── workflows/
│       ├── azure-webapp.yml
│       └── main_birthday-bot.yml  # CI/CD: auto-deploy on push to main
├── .env                           # Local secrets (never commit)
├── .gitignore
├── package.json
└── package-lock.json
```

## Architecture

```
Discord Gateway
      |
      |-- Slash command interaction
      |         |
      |         v
      |   commands/*.js
      |         |
      |         v
      |   CosmosDBService  ------>  Azure Cosmos DB
      |                             (BirthdayBotDB / birthdays)
      |
      |-- MessageCreate event (@mention or AI_CHANNEL_ID)
                |
                v
          AIService.js
                |
                |-- conversation history (per channel, up to 20 msgs)
                |
                v
          OpenAI API (gpt-4o-mini)
          function calling tools:
            - queryBirthday
            - listUpcomingBirthdays
            - setOwnBirthday
                |
                v
          CosmosDBService  ------>  Azure Cosmos DB
```

## Deployment

The bot is hosted on Azure App Service and deployed automatically via GitHub Actions on every push to `main`. See [AZURE_DEPLOYMENT.md](AZURE_DEPLOYMENT.md) for the full deployment guide or [QUICK_SETUP.md](QUICK_SETUP.md) for a concise checklist.

## Cost Estimate

| Component | Estimated Cost |
|-----------|---------------|
| Azure App Service B1 | ~$13/month |
| Azure Cosmos DB serverless | ~$0–1/month |
| OpenAI gpt-4o-mini (small server) | ~$0.10–1/month |
| **Total** | **~$14–15/month** |
