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
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1"
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
  // Simpan token per address agar aman walau privateKey tidak dipakai sebagai key
  const wallet = new ethers.Wallet(account.privateKey);
  return wallet.address.toLowerCase();
}

function isTokenExpired(expiredAt) {
  if (!expiredAt) return true;
  const now = Date.now() / 1000;
  return now > (expiredAt - 300); // buffer 5 menit
}

function getHeaders(userAgent) {
  return {
    "Accept": "application/json, text/plain, */*",
    "Content-Type": "application/json",
    "Origin": "https://dgrid.ai",
    "Referer": "https://dgrid.ai/",
    "User-Agent": userAgent
  };
}

function createClient(proxy, userAgent) {
  const axiosConfig = {
    baseURL: config.baseUrl,
    timeout: 30000,
    headers: getHeaders(userAgent)
  };

  if (proxy && typeof proxy === "string" && proxy.trim() !== "") {
    const proxyUrl = proxy.includes("://") ? proxy : `http://${proxy}`;
    axiosConfig.httpsAgent = new HttpsProxyAgent(proxyUrl);
  }

  return axios.create(axiosConfig);
}

async function apiGetCode(client, address) {
  const res = await client.post(config.endpoints.getCode, { address });
  if (res?.data?.code === "200") return res.data.data; // { code: "...." }
  throw new Error(res?.data?.message || "get-code failed");
}

async function apiChallenge(client, address, signature, inviteCode) {
  const payload = { address, signature };

  // inviteCode opsional — tidak memaksa / tidak bypass
  if (inviteCode && String(inviteCode).trim() !== "") {
    payload.inviteCode = String(inviteCode).trim();
  }

  const res = await client.post(config.endpoints.challenge, payload);
  if (res?.data?.code === "200") return res.data.data; // { token, expiredAt, ... }
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

async function login(client, account) {
  const wallet = new ethers.Wallet(account.privateKey);
  const address = wallet.address;

  console.log(chalk.cyan(`[${account.name}] Requesting login code...`));
  const codeData = await apiGetCode(client, address);

  console.log(chalk.cyan(`[${account.name}] Signing challenge...`));
  const signature = await wallet.signMessage(codeData.code);

  await randomDelay(600, 1200);

  const invite = (account.inviteCode ?? config.inviteCode ?? "").trim();
  console.log(chalk.cyan(`[${account.name}] Submitting signature...${invite ? " (with inviteCode)" : ""}`));
  const auth = await apiChallenge(client, address, signature, invite);

  console.log(chalk.green(`[${account.name}] ✓ Login OK`));
  return { token: auth.token, expiredAt: auth.expiredAt, address };
}

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
    status: "OK"
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
    client.defaults.headers.common["Authorization"] = `Bearer ${tokenData.token}`;

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
      // pilih jawaban random dari answers_ids
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
    colWidths: [14, 16, 8, 8, 12, 10]
  });

  for (const r of results) {
    table.push([
      r.name,
      (r.address || "-").slice(0, 14) + "...",
      r.points,
      r.todayPoints,
      `${r.missionsCompleted}/${r.totalMissions}`,
      r.status === "OK" ? chalk.green("OK") : chalk.red("ERR")
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

async function main() {
  while (true) {
    await runOnce();
    const mins = config.scheduler?.checkIntervalMinutes ?? 60;
    const waitMs = mins * 60 * 1000;
    console.log(chalk.gray(`Next cycle in ${mins} minutes. Ctrl+C to stop.`));
    await sleep(waitMs);
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
