# PNJ · Virtual Try-On Demo

Camera-based jewelry try-on for **PNJ** — try a **ring** (hand tracking), **earrings** or a
**diamond pendant / necklace** (face tracking) live in the browser. **All three modes overlay
real PNJ product photos** — actual cutouts, names and VND prices crawled from pnj.com.vn —
composited onto your finger, earlobes and neckline. No install.

> Built to win the pitch: a link PNJ can open on their own phone and try on their own hand/face.

---

## Quick start

```bash
npm install
npm run dev
# open the printed http://localhost:5173  (localhost is a secure context, so the camera works)
```

To try it on a **phone**, the page must be served over **https** (camera requirement). Easiest:

```bash
npm run dev -- --host          # serves on your LAN
npx cloudflared tunnel --url http://localhost:5173   # gives an https URL for the phone
```

Production bundle: `npm run build` → static files in `dist/` (drop on any static host / CDN).

---

## Using it (and filming the 10–15s clip)

- **Mode** (top-right): `💍 Ring` (finger, hand tracking) · `👂 Earrings` (earlobes) ·
  `📿 Necklace` (neckline + procedural gold chain). All overlay real PNJ product photos.
- **Quality** (top-right): `Fast` = flat photo composite · `Premium` = adds a soft contact
  drop-shadow that grounds the piece on the skin. (See "Two options" for the full roadmap.)
- **Catalog** (bottom): every chip shows the real PNJ product photo, name and **VND price** —
  tap to swap live. The "this is real inventory" beat.

**Shot list (matches the pitch storyboard):**
1. `0–3s` Ring mode → raise hand (palm toward you, fingers up), rotate slightly.
2. `3–7s` Earrings mode → face camera, slight head turn.
3. `7–11s` Necklace mode → tap two different catalog chips → instant design swap.
4. `11–15s` End card: *"Ướm thử trang sức PNJ ngay tại nhà"* + PNJ logo.

Placement constants live in [`src/config.js`](src/config.js) — nudge `RING_SIZE`/`BAND_ALONG`
(ring), `EARLOBE_DROP`/`EARRING_SIZE`/`EARRING_CROP` (earrings), and `PENDANT.DROP`/`SIZE`
(necklace) while you frame the real shot.

---

## The two options, in one app

This web demo *is* **Option 1 (Web AR)**: real PNJ photos composited onto the body in-browser,
no install — fast and cheap to ship. The `Fast ↔ Premium` toggle previews the polish jump
(flat composite → grounded with a contact shadow). **Option 2 (premium / native)** is the
priced production build below: PNJ's own hi-res / 3D assets, native ARKit/ARCore tracking with
depth occlusion, and true PBR sparkle.

| | **Option 1 — this Web AR demo** | **Option 2 — native production** |
|---|---|---|
| Assets | crawled product photos (2.5D) | PNJ hi-res / glTF 3D models |
| Tracking | MediaPipe, markerless | ARKit/ARCore + depth occlusion |
| Realism | real pieces, flat composite | photoreal, sized, occluded |
| Cost / speed | low, instant link | higher, app build |

---

## Real PNJ catalog (live crawl)

All three catalogs are pulled straight from PNJ category pages — transparent product cutouts +
names + prices — so the demo shows **actual inventory**, not mockups. Re-runnable per category:

```bash
node scripts/fetch-pnj.mjs ring     "https://www.pnj.com.vn/trang-suc-cuoi/nhan-cau-hon/"          12
node scripts/fetch-pnj.mjs earring  "https://www.pnj.com.vn/bong-tai/bong-tai-dinh-ecz/"           12
node scripts/fetch-pnj.mjs necklace "https://www.pnj.com.vn/mat-day-chuyen/mat-day-chuyen-kim-cuong/" 12
```

Each run writes `public/products/<key>/*.png` + `src/catalog/<key>.json`. PNJ can re-run it
anytime to refresh from live stock.

Notes: PNJ's `/site/danh-muc/...` listings (incl. the diamond-ring URL) are JS-rendered shells
that curl can't read, so the **ring** catalog uses the server-rendered diamond proposal-ring
listing instead. Images are 300×300 transparent PNGs (the largest the CDN serves publicly);
production would use PNJ's hi-res / 3D assets directly.

## Architecture

```
camera (getUserMedia, mirrored)
        │  video frames
        ▼
MediaPipe Tasks-Vision            ← src/tracking/{hand,face}Tracker.js
  HandLandmarker / FaceLandmarker
        │  normalized landmarks
        ▼
anchors  ← src/render/anchors.js  (contain-fit + mirror mapping; finger/lobe/neck placement)
        │  screen px
        ▼
Three.js orthographic stage       ← src/render/scene.js  (pixel-accurate, env map for chain)
  real PNJ product cutouts        ← src/render/productPlane.js (alpha composite + crop + shadow)
  ring / earrings / pendant+chain ← src/render/jewelry/{ring,earring,pendant}.js
        │
        ▼
transparent canvas over the video
```

- **Real PNJ photos, composited via alpha** — the product cutouts (transparent PNGs) sit on the
  finger/earlobes/neckline; the ring's transparent centre lets the finger show through the band.
- **Pixel-accurate orthographic stage** (world units == screen pixels) keeps pieces glued to
  landmarks regardless of screen size / orientation.
- Models + wasm load from CDN at runtime (URLs in `src/config.js`) — verified reachable.

---

## Production roadmap → the real Option 2 (priced scope)

The demo is the teaser. The shippable product adds:

1. **Real PNJ assets** — swap procedural geometry for glTF/USDZ exported from PNJ's product 3D
   pipeline (`createRing`/`createEarring` already isolate geometry from placement). *Biggest
   dependency — see below.*
2. **Native AR for best tracking & realism** — ARKit (iOS) / ARCore (Android) or Unity AR
   Foundation; depth-based **occlusion** (fingers in front of the band, hair over earrings) and
   true **finger-size measurement** for purchase intent.
3. **More categories** — necklace (neck/collarbone) and bracelet (wrist); flagged as harder
   tracking, scoped as a second phase.
4. **Catalog / CMS integration** — designs driven by PNJ SKUs, pricing, stock, "add to cart" /
   "book in-store" CTAs.
5. **Analytics** — try-on counts, dwell per SKU, try-on → purchase funnel.

**What we need from PNJ to quote firmly:** 3D models (or high-res product shots → modeling cost),
target SKUs for phase 1, and brand kit. Scope phase 1 to **ring + earrings** explicitly.

---

## Notes / limits

- Tracking is markerless and 2.5D in the web build — great for the demo; native build adds true
  depth + occlusion.
- MediaPipe uses the **GPU** delegate; on browsers without WebGL2/GPU support it may need a CPU
  fallback (a small change in the tracker factories).
- Gem refraction in the web build reflects the environment map (not the live background) — reads
  as a lit stone; full background refraction is a native-build enhancement.
