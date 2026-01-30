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

const RETRY = {
  maxAccountRetries: 5,
  maxMissionRetries: 6,
  baseBackoffMs: 2000,
  maxBackoffMs: 45000,
  timeoutMs: 60000,
  ...(config.retry || {})
};

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) Chrome/123 Safari/537.36",
  "Mozilla/5.0 (Macintosh) Chrome/122 Safari/537.36"
];

const randInt = (a,b)=>Math.floor(Math.random()*(b-a+1))+a;
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const pickUA = ()=>USER_AGENTS[randInt(0,USER_AGENTS.length-1)];

const loadJsonSafe=(f,d)=>{try{if(fs.existsSync(f))return JSON.parse(fs.readFileSync(f,"utf8"));}catch{}return d;}
const saveJson=(f,d)=>fs.writeFileSync(f,JSON.stringify(d,null,2));

function loadAccounts(){
  const a=loadJsonSafe(ACCOUNTS_FILE,[]);
  if(!a.length){console.log(chalk.red("accounts.json kosong"));process.exit(1);}
  return a;
}

const tokenKeyForAccount = acc => new ethers.Wallet(acc.privateKey).address.toLowerCase();
const isTokenExpired = t => !t || Date.now()/1000 > t-300;

function createClient(proxy,ua){
  const cfg={
    baseURL:config.baseUrl,
    timeout:RETRY.timeoutMs,
    headers:{
      Accept:"application/json, text/plain, */*",
      "Content-Type":"application/json",
      Origin:"https://dgrid.ai",
      Referer:"https://dgrid.ai/",
      "User-Agent":ua
    }
  };
  if(proxy){cfg.httpsAgent=new HttpsProxyAgent(proxy.includes("://")?proxy:`http://${proxy}`);}
  return axios.create(cfg);
}

function isRetryable(err){
  const s=err?.response?.status;
  if([429,500,502,503,504].includes(s)) return true;
  const c=err?.code||"";
  if(["ECONNABORTED","ETIMEDOUT","ECONNRESET","EAI_AGAIN"].includes(c)) return true;
  return /timeout/i.test(err?.message||"");
}

async function withRetry(label,fn,maxR=RETRY.maxMissionRetries){
  let last;
  for(let i=1;i<=maxR;i++){
    try{return await fn();}
    catch(e){
      last=e;
      if(!isRetryable(e)) throw e;
      const w=Math.min(RETRY.maxBackoffMs,RETRY.baseBackoffMs*Math.pow(1.7,i-1))+randInt(0,1500);
      console.log(chalk.yellow(`[RETRY] ${label} ${i}/${maxR} → wait ${(w/1000).toFixed(1)}s`));
      await sleep(w);
    }
  }
  throw last;
}

// ---------- API ----------
const apiGetCode=(c,a)=>withRetry("getCode",async()=>{
  const r=await c.post(config.endpoints.getCode,{address:a});
  if(r.data.code==="200") return r.data.data;
  throw new Error(r.data.message);
});

const apiChallenge=(c,a,s,i)=>withRetry("challenge",async()=>{
  const r=await c.post(config.endpoints.challenge,{address:a,signature:s,inviteCode:i||undefined});
  if(r.data.code==="200") return r.data.data;
  throw new Error(r.data.message);
});

const apiMe=c=>withRetry("me",async()=>{
  const r=await c.get(config.endpoints.me);
  if(r.data.code==="200") return r.data.data;
  throw new Error(r.data.message);
});

const apiOverview=c=>withRetry("overview",async()=>{
  const r=await c.get(config.endpoints.arenaOverview);
  if(r.data.code==="200") return r.data.data;
  throw new Error(r.data.message);
});

const apiMissions=c=>withRetry("missions",async()=>{
  const r=await c.get(config.endpoints.arenaMissions);
  if(r.data.code==="200") return r.data.data;
  throw new Error(r.data.message);
});

const apiComplete=(c,g,q,o)=>withRetry(`mission ${q}`,async()=>{
  const r=await c.post(`${config.endpoints.arenaMissions}/${g}/questions/${q}/options/${o}`,{});
  if(r.data.code==="200") return r.data.data;
  throw new Error(r.data.message);
});

// ---------- LOGIN ----------
async function login(client,acc){
  const w=new ethers.Wallet(acc.privateKey);
  console.log(`[${acc.name}] login...`);
  const code=await apiGetCode(client,w.address);
  const sig=await w.signMessage(code.code);
  const auth=await apiChallenge(client,w.address,sig,acc.inviteCode||config.inviteCode||"");
  return {token:auth.token,expiredAt:auth.expiredAt,address:w.address};
}

// ---------- PROCESS ACCOUNT ----------
async function processAccount(acc,tokens){
  for(let attempt=1;attempt<=RETRY.maxAccountRetries;attempt++){
    try{
      const ua=pickUA();
      const c=createClient(acc.proxy,ua);
      const key=tokenKeyForAccount(acc);
      let t=tokens[key];
      if(!t||isTokenExpired(t.expiredAt)){
        t=await login(c,acc);
        tokens[key]=t; saveJson(TOKENS_FILE,tokens);
      }
      c.defaults.headers.common.Authorization=`Bearer ${t.token}`;

      await apiMe(c);
      const ov=await apiOverview(c);

      let done=0, total=0;

      for(let round=0;round<10;round++){
        const md=await apiMissions(c);
        const todo=(md.missions||[]).filter(x=>!x.dealt);
        total=md.missions.length;
        if(!todo.length) break;

        for(const m of todo){
          const opt=m.answers_ids?.[randInt(0,m.answers_ids.length-1)];
          if(!opt) continue;
          await apiComplete(c,md.group_id,m.question_id,opt);
          done++;
          await sleep(randInt(1500,3500));
        }
      }

      return {name:acc.name,address:t.address,points:ov.totalPoints||0,today:ov.todayPoints||0,done,total,status:"OK"};
    }catch(e){
      console.log(chalk.red(`[${acc.name}] attempt ${attempt} error: ${e.message}`));
      if(attempt===RETRY.maxAccountRetries)
        return {name:acc.name,address:"-",points:0,today:0,done:0,total:0,status:"ERR"};
      await sleep(RETRY.baseBackoffMs*attempt);
    }
  }
}

// ---------- TABLE ----------
function showTable(res){
  const t=new Table({head:["Account","Address","Total","Today","Missions","Status"]});
  res.forEach(r=>t.push([
    r.name,
    (r.address||"-").slice(0,12)+"...",
    r.points,
    r.today,
    `${r.done}/${r.total}`,
    r.status==="OK"?chalk.green("OK"):chalk.red("ERR")
  ]));
  console.log(t.toString());
}

// ---------- RUN CYCLE ----------
async function runOnce(){
  const accs=loadAccounts();
  const tokens=loadJsonSafe(TOKENS_FILE,{});
  const out=[];
  for(let i=0;i<accs.length;i++){
    console.log(`\n[${i+1}/${accs.length}] ${accs[i].name}`);
    out.push(await processAccount(accs[i],tokens));
    if(i<accs.length-1) await sleep(randInt(4000,7000));
  }
  showTable(out);
}

// ---------- RESET DETECT ----------
function msToUtcMidnight(buf=60){
  const n=new Date();
  const nx=new Date(Date.UTC(n.getUTCFullYear(),n.getUTCMonth(),n.getUTCDate()+1,0,0,0));
  return Math.max(nx-n+buf*1000,5000);
}

async function waitReset(acc){
  const ms=msToUtcMidnight(60);
  console.log(`[INFO] Sleep to UTC reset ${Math.floor(ms/1000)}s`);
  await sleep(ms);
}

// ---------- MAIN LOOP ----------
(async()=>{
  const accs=loadAccounts();
  const watcher=accs[0];
  while(true){
    await runOnce();
    await waitReset(watcher);
  }
})();
