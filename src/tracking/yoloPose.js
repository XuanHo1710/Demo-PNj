import { YOLO } from '../config.js';

// Optional YOLOv8-pose tracker running in the browser via onnxruntime-web. It returns a robust
// read of the two shoulders that the necklace fuses with MediaPipe Pose to cut jitter and
// improve accuracy. Everything here is FAIL-SAFE: onnxruntime-web is loaded with a dynamic
// import and the model is fetched at runtime, so if either is missing the caller just falls
// back to MediaPipe. Inference is throttled (YOLO.intervalMs) so it never tanks mobile FPS.
export async function createYoloPose() {
  const ort = await import('onnxruntime-web');
  if (YOLO.wasmPaths) ort.env.wasm.wasmPaths = YOLO.wasmPaths;
  // Single-threaded SIMD wasm: avoids the COOP/COEP cross-origin-isolation headers that
  // multi-threaded wasm needs (the dev server doesn't set them), so it just works everywhere.
  ort.env.wasm.numThreads = 1;

  const session = await ort.InferenceSession.create(YOLO.modelPath, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all'
  });
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];

  const S = YOLO.inputSize;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const chw = new Float32Array(S * S * 3);

  let busy = false;
  let lastRun = 0;
  let cached = null; // last shoulders result (normalized image coords), reused between runs

  // Letterbox the video frame into the square model input, returning the transform to undo it.
  function preprocess(video) {
    const w0 = video.videoWidth;
    const h0 = video.videoHeight;
    const scale = S / Math.max(w0, h0);
    const nw = Math.round(w0 * scale);
    const nh = Math.round(h0 * scale);
    const padX = (S - nw) / 2;
    const padY = (S - nh) / 2;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, S, S);
    ctx.drawImage(video, padX, padY, nw, nh);
    const { data } = ctx.getImageData(0, 0, S, S); // RGBA, row-major
    const area = S * S;
    for (let i = 0; i < area; i++) {
      chw[i] = data[i * 4] / 255; // R plane
      chw[i + area] = data[i * 4 + 1] / 255; // G plane
      chw[i + area * 2] = data[i * 4 + 2] / 255; // B plane
    }
    return { scale, padX, padY, w0, h0 };
  }

  // Decode YOLOv8-pose output [1, 4+1+17*3, anchors]. If `target` is provided (the selected
  // face nose in normalized image coords), choose the body whose shoulder midpoint sits under
  // that face; otherwise fall back to the largest person.
  function decode(out, tf, target) {
    const dims = out.dims; // [1, C, A]
    const C = dims[1];
    const A = dims[2];
    const d = out.data;
    const at = (c, i) => d[c * A + i]; // channel-major layout

    const kpAt = (k, i) => {
      const base = 5 + k * 3;
      return {
        x: (at(base, i) - tf.padX) / tf.scale / tf.w0,
        y: (at(base + 1, i) - tf.padY) / tf.scale / tf.h0,
        score: at(base + 2, i)
      };
    };

    let bestI = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < A; i++) {
      const score = at(4, i);
      if (score < YOLO.scoreThreshold) continue;
      const L = kpAt(YOLO.L_SHOULDER, i);
      const R = kpAt(YOLO.R_SHOULDER, i);
      if (L.score < YOLO.minKpScore || R.score < YOLO.minKpScore) continue;

      const area = at(2, i) * at(3, i);
      let rank = area;
      if (target) {
        const mx = (L.x + R.x) / 2;
        const my = (L.y + R.y) / 2;
        // Shoulders should be below the face nose and horizontally close to the selected face.
        const d = Math.hypot(mx - target.x, (my - target.y) * 0.65);
        const below = my > target.y ? 0 : 1.5;
        rank = -(d + below) + score * 0.15;
      }
      if (rank > bestScore) {
        bestScore = rank;
        bestI = i;
      }
    }
    if (bestI < 0 || C < 5 + (YOLO.R_SHOULDER + 1) * 3) return null;

    const L = kpAt(YOLO.L_SHOULDER, bestI);
    const R = kpAt(YOLO.R_SHOULDER, bestI);
    return { left: L, right: R, visL: L.score, visR: R.score };
  }

  // Returns { left, right, visL, visR } in normalized image coords (like MediaPipe), or null.
  // Non-blocking: kicks off at most one inference per interval and returns the cached result
  // immediately so the render loop never stalls waiting on YOLO.
  function detect(video, tsMs, target) {
    if (!busy && tsMs - lastRun >= YOLO.intervalMs && video.videoWidth) {
      busy = true;
      lastRun = tsMs;
      const tf = preprocess(video);
      const tensor = new ort.Tensor('float32', chw, [1, 3, S, S]);
      session
        .run({ [inputName]: tensor })
        .then((res) => {
          cached = decode(res[outputName], tf, target);
        })
        .catch(() => {
          cached = null;
        })
        .finally(() => {
          busy = false;
        });
    }
    return cached;
  }

  return { detect };
}
