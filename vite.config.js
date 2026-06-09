import { defineConfig } from 'vite';

// getUserMedia needs a secure context. `localhost` counts as secure, so `npm run dev`
// works on the dev machine. To test on a phone over LAN, run with `--host` behind an
// https tunnel (e.g. `npx vite --host` + a reverse proxy, or `cloudflared`/`ngrok`).
export default defineConfig({
  server: { host: true },
  // tasks-vision ships its own wasm loader; let it resolve at runtime instead of pre-bundling.
  optimizeDeps: { exclude: ['@mediapipe/tasks-vision'] }
});
