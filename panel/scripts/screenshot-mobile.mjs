// Phone-sized captures through the LAN address (so login is exercised).
// usage: FLEET_USERNAME=… FLEET_PASSWORD=… node scripts/screenshot-mobile.mjs <outDir> <baseUrl> (an account without two-factor)
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const out = process.argv[2] ?? "screenshots-mobile";
const base = process.argv[3] ?? "http://localhost:4747";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium", args: ["--disable-gpu"] });
const ctx = await browser.newContext({
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36",
});
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const shot = async (name, opts = {}) => {
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/${name}.png`, ...opts });
  console.log("saved", name);
};

await page.goto(base, { waitUntil: "load" });
await page.waitForTimeout(1500);
await shot("01-login");
await page.fill("#username", process.env.FLEET_USERNAME ?? "admin");
await page.fill("#pw", process.env.FLEET_PASSWORD ?? "");
await page.tap("button[type=submit]");
await page.waitForURL((u) => !u.pathname.startsWith("/login"));
await page.waitForTimeout(6000);
await shot("02-overview");
await page.evaluate(() => document.querySelector("main")?.scrollTo(0, 650));
await shot("03-overview-scrolled");
await page.evaluate(() => document.querySelector("main")?.scrollTo(0, 0));

await page.getByRole("link", { name: "Machines", exact: true }).tap();
await page.waitForTimeout(1500);
await shot("04-machines");
await page.locator('main a[href^="/nodes/"]').first().tap();
await page.waitForTimeout(4000);
await shot("05-node");
await page.evaluate(() => document.querySelector("main")?.scrollTo(0, 560));
await shot("06-node-scrolled");
await page.evaluate(() => document.querySelector("main")?.scrollTo(0, 0));
await page.getByRole("tab", { name: /Services/ }).tap();
await page.waitForTimeout(3500);
await shot("07-services");
await page.getByRole("tab", { name: /Procs|Processes/ }).tap();
await page.waitForTimeout(3500);
await shot("08-processes");

await page.locator("main").getByRole("button", { name: "Power", exact: true }).tap();
await page.getByRole("menuitem", { name: /Reboot/ }).tap();
await shot("09-reboot-sheet");
await page.keyboard.press("Escape");
await page.waitForTimeout(400);

await page.locator("main").getByRole("button", { name: "Shell", exact: true }).tap();
await page.waitForTimeout(3500);
await page.keyboard.type("uptime; ls /\n");
await page.waitForTimeout(1500);
await shot("10-terminal");
await page.getByRole("button", { name: "Close terminal" }).tap();

await page.getByRole("button", { name: "More", exact: true }).tap();
await shot("11-more-sheet");
await page.keyboard.press("Escape");
await page.getByRole("button", { name: "Search", exact: true }).tap();
await shot("12-palette");
await page.keyboard.press("Escape");

await page.goto(`${base}/activity`, { waitUntil: "load" });
await page.waitForTimeout(2500);
await shot("13-activity");

if (errors.length) console.log("PAGE ERRORS:\n" + [...new Set(errors)].join("\n"));
await browser.close();
