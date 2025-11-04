import express from "express";
import fs from "fs";
import path from "path";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { fileURLToPath } from "url";

puppeteer.use(StealthPlugin());

// --- Fix __dirname for ES modules ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

const IG_LOGIN = { username: "test", password: "1234" };
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig;
const PHONE_RE = /(?:\+?\d{1,3}[.\-\s]?)?(?:\(?\d{2,4}\)?[.\-\s]?)?\d{3,4}[.\-\s]?\d{3,4}/g;
const unique = arr => Array.from(new Set((arr || []).filter(Boolean)));

async function extractContactInfoFromHtml(html, pageUrl) {
  const emails = (html.match(EMAIL_RE) || []).map(e => e.toLowerCase());
  const phones = (html.match(PHONE_RE) || []).map(p => p.trim());
  const mailto = [], tel = [], links = [];
  const HREF_RE = /href\s*=\s*["']([^"']+)["']/ig;
  let m;
  while ((m = HREF_RE.exec(html)) !== null) {
    const href = m[1];
    if (!href) continue;
    links.push(href);
    if (href.startsWith("mailto:"))
      mailto.push(href.replace(/^mailto:/i, "").split("?")[0].toLowerCase());
    if (href.startsWith("tel:"))
      tel.push(href.replace(/^tel:/i, ""));
  }
  const absoluteLinks = links.map(link => {
    try { return new URL(link, pageUrl).toString(); }
    catch { return link; }
  });
  return {
    emails: unique([...emails, ...mailto]),
    phones: unique([...phones, ...tel]),
    links: unique(absoluteLinks)
  };
}

async function scrapeReelContacts(reelUrl) {
  const userDataDirPath = path.resolve(__dirname, "puppeteer_user_data");
  if (!fs.existsSync(userDataDirPath)) fs.mkdirSync(userDataDirPath, { recursive: true });

  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: { width: 1200, height: 800 },
    userDataDir: userDataDirPath,  // ✅ valid absolute path
    args: ["--no-sandbox", "--disable-setuid-sandbox"]
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );

  async function isLoggedIn() {
    const navPresent = await page.$("nav");
    if (navPresent) return true;
    const loginInput = await page.$('input[name="username"], input[name="password"]');
    return !loginInput;
  }

  await page.goto("https://www.instagram.com/", { waitUntil: "networkidle2" });
  let loggedIn = await isLoggedIn();

  if (!loggedIn) {
    console.log("Logging into Instagram...");
    await page.goto("https://www.instagram.com/accounts/login/", { waitUntil: "networkidle2" });
    await page.waitForSelector('input[name="username"]', { timeout: 15000 });
    await page.type('input[name="username"]', IG_LOGIN.username, { delay: 50 });
    await page.type('input[name="password"]', IG_LOGIN.password, { delay: 50 });
    await page.click('button[type="submit"]');
    await page.waitForTimeout(8000);
    loggedIn = await isLoggedIn();
    if (!loggedIn)
      console.warn("Manual login/2FA might be required.");
  }

  // --- Go to reel ---
  console.log("Navigating to reel:", reelUrl);
  await page.goto(reelUrl, { waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);

  const reelData = await page.evaluate(() => {
    const out = {};
    const userAnchor = document.querySelector("header a[href^='/']");
    out.username = userAnchor ? userAnchor.getAttribute("href").replace(/\//g, "") : null;
    const captionNode = document.querySelector("div[role='dialog']")?.innerText || document.body.innerText;
    out.caption = captionNode || "";
    const anchors = Array.from(document.querySelectorAll("a"));
    out.links = anchors.map(a => a.href).filter(Boolean);
    out.html = document.documentElement.innerHTML;
    return out;
  });

  const reelContacts = await extractContactInfoFromHtml(reelData.html || reelData.caption, reelUrl);

  const result = {
    sourceReel: reelUrl,
    reelUsername: reelData.username || null,
    reelCaption: reelData.caption || null,
    reelContacts,
    timestamp: new Date().toISOString()
  };

  await browser.close();
  return result;
}

// --- API Endpoint ---
app.post("/scrape-reel", async (req, res) => {
  const { reelUrl } = req.body;
  if (!reelUrl) return res.status(400).json({ error: "Missing reelUrl" });

  try {
    const data = await scrapeReelContacts(reelUrl);
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
