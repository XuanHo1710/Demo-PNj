import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// getUserMedia needs a secure context. `localhost` is secure, and the basic-SSL plugin serves
// the dev server over HTTPS so phones on the same Wi-Fi can grant camera access too. After
// `npm run dev`, open the printed `https://<your-LAN-IP>:5173` URL on the phone and accept the
// self-signed-certificate warning once.
export default defineConfig({
  plugins: [basicSsl()],
  server: { host: true },
  // tasks-vision ships its own wasm loader; let it resolve at runtime instead of pre-bundling.
  optimizeDeps: { exclude: ['@mediapipe/tasks-vision'] }
});
