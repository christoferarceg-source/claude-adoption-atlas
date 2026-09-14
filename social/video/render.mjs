// Render social/video/index.html to an MP4, one deterministic frame at a time.
// Usage (from the repo root, with a static server on :8770 serving the repo):
//   node social/video/render.mjs http://localhost:8770/social/video/index.html social/claude-adoption-video.mp4
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import puppeteer from "puppeteer-core";

const [url, out, poster = out.replace(/\.mp4$/, "-poster.png")] = process.argv.slice(2);
const FPS = 30;
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--hide-scrollbars", "--force-color-profile=srgb"] });
const page = await browser.newPage();
await page.setViewport({ width: 1080, height: 1350, deviceScaleFactor: 1 });
await page.goto(url, { waitUntil: "networkidle0" });
await page.waitForFunction("window.ready === true", { timeout: 60000 });
const [total, posterTime] = await page.evaluate(() => [window.TOTAL, window.POSTER]);
const frames = Math.round(total * FPS);

const ffmpeg = spawn(ffmpegPath, [
  "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-i", "-",
  "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out,
], { stdio: ["pipe", "inherit", "inherit"] });
const finished = new Promise((resolve, reject) => ffmpeg.on("close", code => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)))));

for (let i = 0; i < frames; i++) {
  await page.evaluate(t => window.seek(t), i / FPS);
  const frame = await page.screenshot({ type: "png" });
  if (!ffmpeg.stdin.write(frame)) await new Promise(r => ffmpeg.stdin.once("drain", r));
  if (i % 150 === 0) console.log(`frame ${i}/${frames}`);
}
ffmpeg.stdin.end();
await finished;

await page.evaluate(t => window.seek(t), posterTime);
await page.screenshot({ path: poster, type: "png" });
await browser.close();
console.log(`wrote ${out} (${(frames / FPS).toFixed(1)}s, ${frames} frames) and ${poster}`);
