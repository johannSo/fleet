// Captures the main screens with system Chromium for visual review.
// usage: node scripts/screenshot.mjs [outDir] [baseUrl] [machine]   (machine: the node view to capture; default: the first one)
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const out = process.argv[2] ?? "screenshots";
const base = process.argv[3] ?? "http://localhost:4747";
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium", args: ["--disable-gpu"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

const shot = async (name) => {
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log("saved", name);
};

// Warm up: the dev server compiles each route on first hit and reloads once.
await page.goto(base, { waitUntil: "load" }).catch(() => {});
await page.waitForTimeout(3000);
const node = process.argv[4] ?? (await page.locator('main a[href^="/nodes/"]').first().getAttribute("href").catch(() => null))?.slice("/nodes/".length) ?? "";
for (const path of [`/nodes/${node}`, "/activity", "/"]) {
  await page.goto(base + path, { waitUntil: "load" }).catch(() => {});
  await page.waitForTimeout(3000);
}
await page.goto(base, { waitUntil: "load" });
await page.waitForTimeout(13000); // let a few samples accumulate for sparklines
await shot("01-overview");

await page.keyboard.press("Control+k");
await shot("02-palette");
await page.keyboard.press("Escape");
await page.waitForTimeout(400);

await page.goto(`${base}/nodes/${node}`, { waitUntil: "load" });
await page.waitForTimeout(10000);
await shot("03-node-overview");

await page.getByRole("tab", { name: /Services/ }).click();
await page.waitForTimeout(4000);
await shot("04-node-services");

await page.getByRole("tab", { name: /Processes/ }).click();
await page.waitForTimeout(4000);
await shot("05-node-processes");

await page.getByRole("tab", { name: /Updates/ }).click();
await page.waitForTimeout(4000);
await shot("06-node-updates");

await page.getByRole("button", { name: "Open shell" }).click();
await page.waitForTimeout(3500);
await page.keyboard.type("uptime && ls --color=auto /\n");
await page.waitForTimeout(1500);
await shot("07-terminal");

await page.getByRole("button", { name: "Reboot", exact: true }).first().click();
await shot("08-reboot-dialog");
await page.keyboard.press("Escape");

await page.getByRole("button", { name: /^Update/ }).first().click();
await page.waitForTimeout(1500);
await shot("09-update-dialog");
await page.keyboard.press("Escape");

await page.goto(`${base}/activity`, { waitUntil: "load" });
await page.waitForTimeout(2000);
await shot("10-activity");

await page.setViewportSize({ width: 1280, height: 800 });
await page.goto(base, { waitUntil: "load" });
await page.waitForTimeout(6000);
await page.getByRole("button", { name: "Run command" }).first().click();
await shot("11-run-dialog-1280");

if (errors.length) console.log("PAGE ERRORS:\n" + [...new Set(errors)].join("\n"));
await browser.close();
