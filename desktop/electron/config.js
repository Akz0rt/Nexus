// Bot server the app talks to. Override with PANEL_API_URL (e.g. http://localhost:3000) for local work.
const DEFAULT_API_URL = 'https://birthday-bot-c5a0fydvcmebeqag.canadacentral-01.azurewebsites.net';

module.exports = {
    apiUrl: (process.env.PANEL_API_URL || DEFAULT_API_URL).replace(/\/+$/, ''),
    // Must match APP_SCHEME in src/web/v2/auth.js on the server
    appScheme: 'birthdaybot-panel'
};
