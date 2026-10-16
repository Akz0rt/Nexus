const { defineConfig } = require('vite');
const react = require('@vitejs/plugin-react');

// Renderer only; Electron main/preload are plain CommonJS and are not bundled.
module.exports = defineConfig({
    root: 'renderer',
    base: './', // loaded from file:// in production
    plugins: [react()],
    build: {
        outDir: '../dist',
        emptyOutDir: true
    },
    server: {
        port: 5173,
        strictPort: true
    }
});
