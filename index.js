const fs = require("fs");
const path = require("path");
const axios = require("axios");
const chalk = require("chalk");
const Table = require("cli-table3");
const { ethers } = require("ethers");
const { HttpsProxyAgent } = require("https-proxy-agent");

const config = require("./config.json");

const ACCOUNTS_FILE = path.join(__dirname, "accounts.json");
const TOKENS_FILE = path.join(__dirname, "tokens.json");

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1",
];

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
async function randomDelay(min, max) {
  return sleep(randInt(min, max));
}
function pickUA() {
  return USER_AGENTS[randInt(0, USER_AGENTS.length - 1)];
}

function loadJsonSafe(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {}
  return fallback;
}
function saveJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function loadAccounts() {
  const accs = loadJsonSafe(ACCOUNTS_FILE, []);
  if (!Array.isArray(accs) || accs.length === 0) {
    console.log(chalk.red("[ERROR] accounts.json kosong / tidak valid"));
    process.exit(1);
  }
  return accs;
}

function tokenKeyForAccount(account) {
  // Simpan token per address (lebih aman daripada key=privateKey)
  const wallet = new ethers.Wallet(account.privateKey);
  return wallet.address.toLowerCase();
}

function isTokenExpired(expiredAt) {
  if (!expiredAt) return true;
  const now = Date.now() / 1000;
  return now > expiredAt - 300; // buffer 5 menit
}

function getHeaders(userAgent) {
  return {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    Origin: "https://dgrid.ai",
    Referer: "https://dgrid.ai/",
    "User-Agent": userAgent,
  };
}

function createClient(proxy, userAgent) {
  const axiosConfig = {
    baseURL: config.baseUrl,
    timeout: 30000,
    headers: getHeaders(userAgent),
  };

  if (proxy && typeof proxy === "string" && proxy.trim() !== "") {
    const proxyUrl = proxy.includes("://") ? proxy : `http://${proxy}`;
    axiosConfig.httpsAgent = new HttpsProxyAgent(proxyUrl);
  }

  return axios.create(axiosConfig);
}

// =========================
// API wrappers
// =========================
async function apiGetCode(client, address) {
  const res = await client.post(config.endpoints.getCode, { address });
  if (res?.data?.code === "200") return res.data.data;
  throw new Error(res?.data?.message || "get-code failed");
}

async function apiChallenge(client, address, signature, inviteCode) {
  const payload = { address, signature };

  // inviteCode opsional (tidak memaksa / tidak bypass)
  if (inviteCode && String(inviteCode).trim() !== "") {
    payload.inviteCode = String(inviteCode).trim();
  }

  const res = await client.post(config.endpoints.challenge, payload);
  if (res?.data?.code === "200") return res.data.data;
  throw new Error(res?.data?.message || "challenge failed");
}

async function apiMe(client) {
  const res = await client.get(config.endpoints.me);
  if (res?.data?.code === "200") return res.data.data;
  throw new Error(res?.data?.message || "/me failed");
}

async function apiArenaOverview(client) {
  const res = await client.get(config.endpoints.arenaOverview);
  if (res?.data?.code === "200") return res.data.data;
  throw new Error(res?.data?.message || "overview failed");
}

async function apiMissions(client) {
  const res = await client.get(config.endpoints.arenaMissions);
  if (res?.data?.code === "200") return res.data.data;
  throw new Error(res?.data?.message || "missions failed");
}

async function apiCompleteMission(client, groupId, questionId, optionId) {
  const url = `${config.endpoints.arenaMissions}/${groupId}/questions/${questionId}/options/${optionId}`;
  const res = await client.post(url, {});
  if (res?.data?.code === "200") return res.data.data;
  throw new Error(res?.data?.message || "complete mission failed");
}

// =========================
// Auth
// =========================
async function login(client, account) {
  const wallet = new ethers.Wallet(account.privateKey);
  const address = wallet.address;

  console.log(chalk.cyan(`[${account.name}] Requesting login code...`));
  const codeData = await apiGetCode(client, address);

  console.log(chalk.cyan(`[${account.name}] Signing challenge...`));
  const signature = await wallet.signMessage(codeData.code);

  await randomDelay(600, 1200);

  const invite = (account.inviteCode ?? config.inviteCode ?? "").trim();
  console.log(
    chalk.cyan(`[${account.name}] Submitting signature...${invite ? " (with inviteCode)" : ""}`)
  );

  const auth = await apiChallenge(client, address, signature, invite);
  console.log(chalk.green(`[${account.name}] ✓ Login OK`));
  return { token: auth.token, expiredAt: auth.expiredAt, address };
}

// =========================
// Main work per account
// =========================
async function processAccount(account, tokensStore) {
  const ua = pickUA();
  const client = createClient(account.proxy, ua);

  const result = {
    name: account.name,
    address: null,
    points: 0,
    todayPoints: 0,
    missionsCompleted: 0,
    totalMissions: 0,
    status: "OK",
  };

  try {
    const tKey = tokenKeyForAccount(account);
    let tokenData = tokensStore[tKey];

    if (!tokenData || isTokenExpired(tokenData.expiredAt)) {
      console.log(chalk.yellow(`[${account.name}] Token expired/not found → login...`));
      tokenData = await login(client, account);
      tokensStore[tKey] = tokenData;
      saveJson(TOKENS_FILE, tokensStore);
    }

    result.address = tokenData.address;
    client.defaults.headers.common.Authorization = `Bearer ${tokenData.token}`;

    await randomDelay(config.delays.minDelay, config.delays.maxDelay);

    console.log(chalk.cyan(`[${account.name}] Fetching profile...`));
    const me = await apiMe(client);
    console.log(chalk.gray(`[${account.name}] wallet=${me.walletAddress || tokenData.address}`));

    await randomDelay(800, 1600);

    console.log(chalk.cyan(`[${account.name}] Fetching overview...`));
    const overview = await apiArenaOverview(client);
    result.points = overview.totalPoints || 0;
    result.todayPoints = overview.todayPoints || 0;

    console.log(chalk.green(`[${account.name}] Points: total=${result.points} today=${result.todayPoints}`));

    await randomDelay(800, 1600);

    console.log(chalk.cyan(`[${account.name}] Fetching missions...`));
    const mdata = await apiMissions(client);
    const missions = mdata.missions || [];
    const groupId = mdata.group_id;

    result.totalMissions = missions.length;

    const todo = missions.filter((m) => !m.dealt);
    console.log(chalk.yellow(`[${account.name}] Incomplete: ${todo.length}/${missions.length}`));

    for (const mission of todo) {
      const answers = Array.isArray(mission.answers_ids) ? mission.answers_ids : [];
      if (answers.length === 0) continue;

      const selected = answers[randInt(0, answers.length - 1)];
      await randomDelay(config.delays.betweenMissions, config.delays.betweenMissions + 1200);

      try {
        await apiCompleteMission(client, groupId, mission.question_id, selected);
        result.missionsCompleted += 1;

        const plus = mission.expect_points || 0;
        result.todayPoints += plus;

        console.log(chalk.green(`[${account.name}] ✓ Mission done (+${plus})`));
      } catch (e) {
        console.log(chalk.red(`[${account.name}] ✗ Mission failed: ${e.message}`));
      }
    }
  } catch (e) {
    result.status = "ERROR";
    console.log(chalk.red(`[${account.name}] ERROR: ${e.message}`));
  }

  return result;
}

function showTable(results) {
  const table = new Table({
    head: ["Account", "Address", "Total", "Today", "Missions", "Status"],
    colWidths: [14, 16, 8, 8, 12, 10],
  });

  for (const r of results) {
    table.push([
      r.name,
      (r.address || "-").slice(0, 14) + "...",
      r.points,
      r.todayPoints,
      `${r.missionsCompleted}/${r.totalMissions}`,
      r.status === "OK" ? chalk.green("OK") : chalk.red("ERR"),
    ]);
  }

  console.log(table.toString());
}

async function runOnce() {
  const accounts = loadAccounts();
  const tokensStore = loadJsonSafe(TOKENS_FILE, {});

  console.log(chalk.cyan(`\n[${new Date().toISOString()}] Cycle start`));
  const results = [];

  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    console.log(chalk.white(`\n[${i + 1}/${accounts.length}] ${acc.name}`));
    console.log("─".repeat(40));

    const r = await processAccount(acc, tokensStore);
    results.push(r);

    if (i < accounts.length - 1) {
      const d = config.delays.betweenAccounts + randInt(0, 2500);
      console.log(chalk.gray(`Waiting ${(d / 1000).toFixed(1)}s...`));
      await sleep(d);
    }
  }

  console.log(chalk.cyan("\nSummary"));
  showTable(results);
  console.log(chalk.cyan("Cycle done.\n"));
}

// =========================
// Reset scheduler (UTC midnight + API auto-detect)
// =========================
function msUntilNextUtcMidnight(bufferSeconds = 60) {
  const now = new Date();
  const next = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0)
  );
  // minimal 5s supaya ga 0 / negatif karena clock skew
  return Math.max(next.getTime() - now.getTime() + bufferSeconds * 1000, 5000);
}

function formatCountdown(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${h}h ${m}m ${ss}s`;
}

async function hasNewMissions(client) {
  const mdata = await apiMissions(client);
  const missions = mdata?.missions || [];
  // "reset terdeteksi" kalau ada mission yang belum dealt
  return missions.some((m) => !m.dealt);
}

/**
 * Auto-detect reset:
 * 1) Sleep sampai mendekati 00:00 UTC (+buffer)
 * 2) Poll missions API sampai ada misi baru
 *    (backoff + jitter)
 */
async function waitForDailyResetViaApi(watcherAccount, bufferSeconds = 60) {
  const ua = pickUA();
  const client = createClient(watcherAccount.proxy, ua);

  // ensure token watcher valid
  const tokensStore = loadJsonSafe(TOKENS_FILE, {});
  const tKey = tokenKeyForAccount(watcherAccount);
  let tokenData = tokensStore[tKey];

  if (!tokenData || isTokenExpired(tokenData.expiredAt)) {
    console.log(chalk.yellow(`[${watcherAccount.name}] Token expired before reset-check → login...`));
    tokenData = await login(client, watcherAccount);
    tokensStore[tKey] = tokenData;
    saveJson(TOKENS_FILE, tokensStore);
  }

  client.defaults.headers.common.Authorization = `Bearer ${tokenData.token}`;

  // 1) sleep sampai dekat reset
  const waitMs = msUntilNextUtcMidnight(bufferSeconds);
  const wakeAt = new Date(Date.now() + waitMs);

  console.log(chalk.cyan(`[INFO] New missions available at 00:00 UTC`));
  console.log(chalk.cyan(`[INFO] Wake at: ${wakeAt.toISOString()}`));
  console.log(chalk.gray(`[INFO] Sleeping: ${formatCountdown(waitMs)} (Ctrl+C to stop)\n`));

  await sleep(waitMs);

  // 2) poll sampai reset beneran terjadi
  console.log(chalk.cyan(`[INFO] Checking API for new missions (watcher: ${watcherAccount.name})...`));

  let attempt = 0;
  let delayMs = 5000; // start 5s, backoff to 60s max

  while (true) {
    attempt += 1;
    try {
      const ok = await hasNewMissions(client);
      if (ok) {
        console.log(chalk.green(`[INFO] ✅ Reset detected by API (attempt ${attempt})\n`));
        return;
      }
      console.log(
        chalk.gray(
          `[INFO] Not reset yet (attempt ${attempt}). Waiting ${(delayMs / 1000).toFixed(1)}s...`
        )
      );
    } catch (e) {
      console.log(chalk.yellow(`[WARN] Reset-check error: ${e.message}. Retrying...`));

      // kalau token invalid/expired mendadak, relogin
      try {
        if (String(e.message || "").toLowerCase().includes("401")) {
          throw e;
        }
      } catch (_) {}
    }

    const jitter = randInt(0, 1500);
    await sleep(delayMs + jitter);
    delayMs = Math.min(Math.floor(delayMs * 1.4), 60000);
  }
}

// =========================
// App loop
// =========================
async function main() {
  const accounts = loadAccounts();
  const watcher = accounts[0]; // pakai akun pertama sebagai watcher reset

  while (true) {
    await runOnce();
    await waitForDailyResetViaApi(watcher, 60);
  }
}

process.on("SIGINT", () => {
  console.log(chalk.yellow("\n[INFO] Stopped."));
  process.exit(0);
});

main().catch((e) => {
  console.log(chalk.red(`[FATAL] ${e.message}`));
  process.exit(1);
});
