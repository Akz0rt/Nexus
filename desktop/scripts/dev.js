// Dev mode: Vite dev server for the renderer + Electron pointed at it.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { createServer } = require('vite');
const electronPath = require('electron');

(async () => {
    const server = await createServer({ configFile: path.join(__dirname, '..', 'vite.config.js') });
    await server.listen();
    const url = server.resolvedUrls.local[0];
    console.log(`Renderer dev server: ${url}`);

    const electron = spawn(electronPath, ['.'], {
        cwd: path.join(__dirname, '..'),
        stdio: 'inherit',
        env: { ...process.env, VITE_DEV_SERVER_URL: url }
    });
    electron.on('exit', code => {
        server.close();
        process.exit(code ?? 0);
    });
})();
