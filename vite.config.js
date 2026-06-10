import { defineConfig, createLogger } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// @mediapipe/tasks-vision references a sourcemap file it doesn't ship, so Vite logs a noisy
// (harmless) "Failed to load source map" warning on every dev start. Filter just that line.
const logger = createLogger();
const origWarn = logger.warn;
logger.warn = (msg, options) => {
  if (typeof msg === 'string' && msg.includes('Failed to load source map')) return;
  origWarn(msg, options);
};

// getUserMedia needs a secure context. `localhost` is secure, and the basic-SSL plugin serves
// the dev server over HTTPS so phones on the same Wi-Fi can grant camera access too. After
// `npm run dev`, open the printed `https://<your-LAN-IP>:5173` URL on the phone and accept the
// self-signed-certificate warning once.
export default defineConfig({
  customLogger: logger,
  plugins: [basicSsl()],
  server: { host: true },
  // tasks-vision ships its own wasm loader; let it resolve at runtime instead of pre-bundling.
  optimizeDeps: { exclude: ['@mediapipe/tasks-vision'] }
});
