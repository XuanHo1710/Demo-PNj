// Crawl a PNJ category page → download transparent product cutouts → emit a local catalog.
// Usage:  node scripts/fetch-pnj.mjs <key> <categoryUrl> [limit]
//   e.g.  node scripts/fetch-pnj.mjs ring https://www.pnj.com.vn/trang-suc-cuoi/nhan-cau-hon/ 12
// Writes src/catalog/<key>.json and public/products/<key>/<sku>.png.
// Lets PNJ refresh the demo catalog from live inventory without code changes.
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';

const KEY = process.argv[2];
const URL_ARG = process.argv[3];
const LIMIT = Number(process.argv[4] || 12);
if (!KEY || !URL_ARG) {
  console.error('usage: node scripts/fetch-pnj.mjs <key> <categoryUrl> [limit]');
  process.exit(1);
}

async function main() {
  console.log(`→ [${KEY}] fetching`, URL_ARG);
  const html = await (await fetch(URL_ARG, { headers: { 'User-Agent': UA } })).text();

  // Product cards are <a data-sku=... data-price=... title=...><img (data-src|src)=...></a>
  const cards = html.split(/(?=data-sku=")/);
  const seen = new Set();
  const products = [];
  for (const c of cards) {
    const sku = c.match(/data-sku="([^"]+)"/)?.[1];
    if (!sku || seen.has(sku)) continue;
    const name = c.match(/title="([^"]+)"/)?.[1];
    const price = c.match(/data-price="([0-9.]+)"/)?.[1];
    const url = c.match(/href="(https:\/\/www\.pnj\.com\.vn\/site\/san-pham\/[^"]+)"/)?.[1];
    const image = c
      .slice(0, 1500)
      .match(/<img[^>]+(?:data-src|data-original|src)="([^"]+\.(?:png|jpg|jpeg|webp))"/)?.[1];
    if (!name || !price || !image) continue;
    seen.add(sku);
    products.push({ sku, name, price: Math.round(parseFloat(price)), url, remote: image });
    if (products.length >= LIMIT) break;
  }
  console.log(`→ [${KEY}] parsed ${products.length} products`);

  const outDir = join(ROOT, 'public/products', KEY);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const catalog = [];
  for (const p of products) {
    const file = `products/${KEY}/${p.sku}.png`;
    const res = await fetch(p.remote, { headers: { 'User-Agent': UA } });
    if (!res.ok) {
      console.warn('  ! skip (image ' + res.status + '):', p.sku);
      continue;
    }
    await writeFile(join(ROOT, 'public', file), Buffer.from(await res.arrayBuffer()));
    catalog.push({
      id: p.sku,
      sku: p.sku,
      name: cleanName(p.name),
      price: p.price,
      url: p.url,
      image: '/' + file
    });
    console.log('  ✓', p.sku, formatVnd(p.price), '·', cleanName(p.name));
  }

  await writeFile(
    join(ROOT, `src/catalog/${KEY}.json`),
    JSON.stringify({ source: URL_ARG, fetchedAt: new Date().toISOString(), items: catalog }, null, 2)
  );
  console.log(`→ [${KEY}] wrote src/catalog/${KEY}.json (${catalog.length} items + images)\n`);
}

// Build a short, readable chip label from PNJ's long product titles.
function cleanName(raw) {
  const karat = raw.match(/\((\d{1,2}K)\)/)?.[1] || '';
  const gold = /trắng/i.test(raw) ? 'Vàng trắng' : /hồng|rose/i.test(raw) ? 'Vàng hồng' : 'Vàng';
  const stone = /kim cương/i.test(raw) ? 'Kim cương' : /ECZ/i.test(raw) ? 'Đá ECZ' : /CZ/i.test(raw) ? 'Đá CZ' : '';
  const collection = raw.match(/PNJ\s+([A-Za-zÀ-ỹ][A-Za-zÀ-ỹ ]{1,20}?)\s+(?:DD|GM|GN|GB|[A-Z]{2}\d|\d)/)?.[1]?.trim();
  const head = collection && collection.length > 1 ? `PNJ ${collection}` : 'PNJ ' + (stone || 'Diamond');
  const tail = [stone && !head.includes(stone) ? stone : '', gold, karat].filter(Boolean).join(' ');
  return tail ? `${head} · ${tail}` : head;
}

function formatVnd(n) {
  return n.toLocaleString('vi-VN') + '₫';
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
