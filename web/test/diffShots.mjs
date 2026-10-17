// 双截图像素 diff（Chrome canvas 内比对，零依赖）。
// 用法：OMNI_CHROME_PATH=<chrome.exe> node web/test/diffShots.mjs <a.png> <b.png>
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  findBrowser, serveStatic, getFreePort,
  launchChromeForCdp, killChromeTree, waitForPageWs, CdpSession,
} from './browserHarness.mjs';

const [aPath, bPath] = process.argv.slice(2);
const a64 = readFileSync(aPath).toString('base64');
const b64 = readFileSync(bPath).toString('base64');

const html = `<!DOCTYPE html><html><body><script>
window.__DIFF__ = (async () => {
  const load = (b64) => new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = 'data:image/png;base64,' + b64;
  });
  const [a, b] = await Promise.all([load(${JSON.stringify(a64)}), load(${JSON.stringify(b64)})]);
  if (a.width !== b.width || a.height !== b.height) return { sizeDiff: [a.width, a.height, b.width, b.height] };
  const ca = new OffscreenCanvas(a.width, a.height);
  const cb = new OffscreenCanvas(b.width, b.height);
  ca.getContext('2d').drawImage(a, 0, 0);
  cb.getContext('2d').drawImage(b, 0, 0);
  const da = ca.getContext('2d').getImageData(0, 0, a.width, a.height).data;
  const db = cb.getContext('2d').getImageData(0, 0, b.width, b.height).data;
  let diff = 0; let minX = 1e9, maxX = -1, minY = 1e9, maxY = -1; const samples = [];
  for (let i = 0; i < da.length; i += 4) {
    if (da[i] !== db[i] || da[i+1] !== db[i+1] || da[i+2] !== db[i+2] || da[i+3] !== db[i+3]) {
      diff++;
      const p = i / 4; const x = p % a.width; const y = (p / a.width) | 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (samples.length < 8) samples.push([x, y, [...da.slice(i, i + 3)], [...db.slice(i, i + 3)]]);
    }
  }
  return { width: a.width, height: a.height, diff, bbox: [minX, minY, maxX, maxY], samples };
})();
</script></body></html>`;

const browser = findBrowser();
if (!browser) { console.error('未找到浏览器'); process.exit(1); }
const server = await serveStatic('/dev/null', { '/_diff.html': html });
const { mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const userDataDir = mkdtempSync(join(tmpdir(), 'omni-diff-ud-'));
let cdp, proc;
try {
  const port = await getFreePort();
  proc = launchChromeForCdp(browser, `http://127.0.0.1:${server.port}/_diff.html`, userDataDir, port);
  const wsUrl = await waitForPageWs(port, '_diff.html');
  cdp = new CdpSession(wsUrl);
  const r = await cdp.evaluate('window.__DIFF__');
  console.log(JSON.stringify(r, null, 1));
} finally {
  if (cdp) cdp.close();
  killChromeTree(proc, userDataDir);
  await server.close();
}
