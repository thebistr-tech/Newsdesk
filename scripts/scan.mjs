/* NEWSDESK cloud scanner — runs on GitHub Actions daily.
   Reads config.json, scans each project via Anthropic API + web search,
   dedupes against data/archive.json, classifies NEW vs UPDATE, writes the
   digest, renders index.html, and sends Telegram alerts for urgent items. */

import { readFileSync, writeFileSync } from "node:fs";

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) { console.error("Missing ANTHROPIC_API_KEY secret"); process.exit(1); }
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || "";

const config = JSON.parse(readFileSync("config.json", "utf8"));
const archive = JSON.parse(readFileSync("data/archive.json", "utf8"));
archive.articles ||= []; archive.summaries ||= {};

const today = new Date().toISOString().slice(0, 10);
const daysAgo = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const uid = () => Math.random().toString(36).slice(2, 10);

/* ---------- Anthropic ---------- */
async function askClaude(prompt, useSearch, maxTokens = 2000) {
  const body = {
    model: "claude-sonnet-4-6",
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  };
  if (useSearch) body.tools = [{ type: "web_search_20250305", name: "web_search" }];
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.content) throw new Error(data.error?.message || "no response");
  return data.content.filter(b => b.type === "text").map(b => b.text).join("\n");
}

function parseLoose(text) {
  if (!text) return null;
  let t = text.replace(/```json|```/g, "").trim();
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf("["), b = t.indexOf("{");
  let start = a === -1 ? b : b === -1 ? a : Math.min(a, b);
  if (start === -1) return null;
  t = t.slice(start);
  for (let end = t.length; end > 2; end--) {
    const ch = t[end - 1];
    if (ch !== "]" && ch !== "}") continue;
    try { return JSON.parse(t.slice(0, end)); } catch {}
  }
  const lastObj = t.lastIndexOf("},");
  if (lastObj > 0) { try { return JSON.parse(t.slice(0, lastObj + 1) + "]"); } catch {} }
  return null;
}

/* ---------- scan ---------- */
const fresh = [];
const knownUrls = new Set(archive.articles.map(a => a.url).filter(Boolean));

for (const proj of config.projects) {
  console.log(`▸ ${proj.name}: [${proj.keywords.join(", ")}]`);
  const prior = archive.articles
    .filter(a => a.projectId === proj.id).slice(-40)
    .map(a => `- [${a.scanDate}] ${a.title}`).join("\n") || "(none yet)";
  const prompt = `You are a news wire editor. Today is ${today}.
Search the web for news from the LAST 24-48 HOURS about these keywords: ${proj.keywords.join(", ")}.
${proj.brief ? `\nEDITORIAL BRIEF for this project — follow strictly, DISCARD anything that violates it:\n${proj.brief}\n` : ""}
Stories I have ALREADY seen on previous days (my archive — do NOT repeat them; if there is a genuine NEW development on one of them, report it with status "update" and name which prior story it develops):
${prior}

Return ONLY a JSON array (no prose, no markdown fences), max 6 items, most important first. Each item:
{"title":str, "source":str (outlet name), "url":str, "published":str (ISO date),
"topic":str (1-2 word category), "urgency":1-5 (5=breaking/critical),
"quality":1-5 (5=top-tier outlet like Reuters/AP/FT, 1=blog/unverified),
"status":"new"|"update", "update_of":str|null (the prior headline it develops),
"summary":str (ONE terse sentence)}
"new" = story/event never in my archive. "update" = development of an archived story.
Only include genuinely new items or genuine developments. If nothing, return [].`;
  try {
    const items = parseLoose(await askClaude(prompt, true));
    if (!Array.isArray(items)) { console.log("  ⚠ parse failed"); continue; }
    let added = 0;
    for (const it of items) {
      if (!it?.title || (it.url && knownUrls.has(it.url))) continue;
      if (it.url) knownUrls.add(it.url);
      fresh.push({
        id: uid(), projectId: proj.id, projectName: proj.name, scanDate: today,
        title: it.title, source: it.source || "Unknown", url: it.url || "",
        published: it.published || today, topic: (it.topic || "General").trim(),
        urgency: Math.min(5, Math.max(1, +it.urgency || 3)),
        quality: Math.min(5, Math.max(1, +it.quality || 3)),
        status: it.status === "update" ? "update" : "new",
        updateOf: it.update_of || null, summary: it.summary || "",
      });
      added++;
    }
    console.log(`  ✓ ${added} items`);
  } catch (e) { console.log(`  ✗ ${e.message}`); }
}

/* ---------- digest ---------- */
if (fresh.length > 0) {
  const listTxt = fresh.map(a =>
    `[${a.projectName}] (${a.status.toUpperCase()}, urgency ${a.urgency}) ${a.title} — ${a.summary}`).join("\n");
  const names = config.projects.map(p => p.name);
  try {
    const d = parseLoose(await askClaude(
      `Today's monitored news items:\n${listTxt}\n\nReturn ONLY JSON (no fences): {"overall":str (3-4 sentence digest, lead with the most urgent), "perProject":{${names.map(n => `"${n}":str (1-2 terse sentences, or "Quiet day." if nothing)`).join(",")}}}. Be terse.`,
      false));
    if (d?.overall) archive.summaries[today] = d;
    console.log("✓ digest");
  } catch (e) { console.log("✗ digest: " + e.message); }
}

/* ---------- retention + save ---------- */
const cutoff = daysAgo(config.retention_days || 21);
archive.articles = [...archive.articles, ...fresh].filter(a => a.scanDate >= cutoff).slice(-1500);
for (const d of Object.keys(archive.summaries)) if (d < cutoff) delete archive.summaries[d];
archive.lastScan = new Date().toISOString();
writeFileSync("data/archive.json", JSON.stringify(archive, null, 1));
console.log(`SCAN COMPLETE — ${fresh.length} items filed, archive: ${archive.articles.length}`);

/* ---------- render static page ---------- */
const embedded = JSON.stringify({
  articles: archive.articles, summaries: archive.summaries,
  lastScan: archive.lastScan, projects: config.projects.map(p => ({ id: p.id, name: p.name })),
}).replace(/<\//g, "<\\/");

const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>NEWSDESK</title>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{--bg:#EDF0F3;--panel:#fff;--ink:#141E28;--soft:#5A6875;--line:#D4DAE0;--sig:#D97B29;--ok:#2E7D6B;--upd:#3C6FB0;--dng:#B23A3A}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:'IBM Plex Sans',sans-serif;padding:0 clamp(12px,4vw,48px) 60px}
.mast{display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:14px;padding:26px 0 14px;border-bottom:3px solid var(--ink)}
.kick{font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:3px;color:var(--sig)}
h1{font-family:'Barlow Condensed';font-weight:700;font-size:clamp(38px,7vw,60px);margin:0;line-height:.95}
.mono{font-family:'IBM Plex Mono',monospace;font-size:12px;color:var(--soft)}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin:16px 0 4px}
.day{font-family:'IBM Plex Mono',monospace;font-size:12px;padding:7px 13px;border:1px solid var(--line);border-radius:999px;background:var(--panel);color:var(--soft);cursor:pointer}
.day.on{background:var(--ink);color:#fff;border-color:var(--ink)}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:16px 20px;margin:16px 0}
.ph{font-family:'Barlow Condensed';font-weight:600;letter-spacing:2px;font-size:15px;color:var(--soft);margin-bottom:8px}
.digest{font-size:16px;line-height:1.6;max-width:72ch;margin:0 0 14px}
.dgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
.dcard{border:1px solid var(--line);border-left:3px solid var(--sig);border-radius:4px;padding:10px 14px;background:var(--bg);font-size:13px;line-height:1.5}
.dname{font-family:'Barlow Condensed';font-weight:600;letter-spacing:1px;margin-bottom:4px}
.filters{display:flex;gap:8px;flex-wrap:wrap;margin:6px 0 14px}
select{padding:8px 10px;border:1px solid var(--line);border-radius:4px;background:var(--panel);font-family:'IBM Plex Mono',monospace;font-size:12px}
.card{display:flex;gap:16px;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:15px 18px;margin-bottom:12px}
.urg{display:flex;flex-direction:column;gap:3px;padding-top:4px}.useg{width:8px;height:12px;border-radius:2px}
.meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px}
.badge{color:#fff;font-family:'IBM Plex Mono',monospace;font-size:10px;letter-spacing:1.5px;padding:3px 7px;border-radius:3px}
.tag{font-family:'IBM Plex Mono',monospace;font-size:11px;border:1px solid var(--line);border-radius:3px;padding:2px 7px;color:var(--soft)}
.mm{font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--soft)}
h2{font-family:'Barlow Condensed';font-weight:600;font-size:23px;line-height:1.1;margin:0 0 4px}
h2 a{color:inherit;text-decoration:none}h2 a:hover{text-decoration:underline}
.upof{font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--upd);margin-bottom:4px}
.sum{font-size:14px;line-height:1.55;color:#2A3540;margin:4px 0 10px;max-width:80ch}
.foot{display:flex;align-items:center;gap:10px;font-size:12px}
.q{letter-spacing:2px;color:var(--sig)}.q .off{color:var(--line)}
.empty{text-align:center;color:var(--soft);padding:44px 0;font-family:'IBM Plex Mono',monospace;font-size:13px}
footer{text-align:center;font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--soft);margin-top:40px}
</style></head><body>
<header class="mast"><div><div class="kick">KEYWORD MONITORING DESK — AUTO-UPDATED DAILY</div><h1>NEWSDESK</h1></div>
<div class="mono" id="lastscan"></div></header>
<nav class="tabs" id="tabs"></nav>
<section class="panel" id="digestPanel" style="display:none"><div class="ph" id="dtitle"></div><p class="digest" id="doverall"></p><div class="dgrid" id="dgrid"></div></section>
<div class="filters"><select id="fProj"><option value="all">All projects</option></select>
<select id="fStatus"><option value="all">New + updates</option><option value="new">New only</option><option value="update">Updates only</option></select>
<span style="flex:1"></span>
<select id="fSort"><option value="urgency">Sort: urgency</option><option value="quality">Sort: source quality</option><option value="recent">Sort: newest</option></select></div>
<main id="feed"></main>
<footer>scans run automatically every morning · urgent items (4-5) are pushed to Telegram · archive keeps ${config.retention_days || 21} days</footer>
<script>
const DATA=${embedded};
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const today=new Date().toISOString().slice(0,10);
let view=null,fp="all",fs="all",sort="urgency";
const dates=[...new Set(DATA.articles.map(a=>a.scanDate))].sort().reverse();
view=dates[0]||today;
const ls=document.getElementById("lastscan");
ls.textContent="last scan: "+(DATA.lastScan?new Date(DATA.lastScan).toLocaleString():"never");
const fProj=document.getElementById("fProj");
DATA.projects.forEach(p=>{const o=document.createElement("option");o.value=p.id;o.textContent=p.name;fProj.appendChild(o)});
function label(d){const t=new Date().toISOString().slice(0,10);const y=new Date(Date.now()-864e5).toISOString().slice(0,10);
 if(d===t)return"Today";if(d===y)return"Yesterday";return new Date(d+"T12:00:00").toLocaleDateString(undefined,{weekday:"short",month:"short",day:"numeric"})}
function render(){
 const tabs=document.getElementById("tabs");tabs.innerHTML="";
 dates.forEach(d=>{const b=document.createElement("button");b.className="day"+(view===d?" on":"");
  b.innerHTML=esc(label(d))+' <span style="opacity:.55">'+DATA.articles.filter(a=>a.scanDate===d).length+"</span>";
  b.onclick=()=>{view=d;render()};tabs.appendChild(b)});
 const all=document.createElement("button");all.className="day"+(view==="all"?" on":"");all.textContent="All days";
 all.onclick=()=>{view="all";render()};tabs.appendChild(all);
 const dg=view==="all"?DATA.summaries[dates.find(d=>DATA.summaries[d])]:DATA.summaries[view];
 const dp=document.getElementById("digestPanel");
 if(dg){dp.style.display="";document.getElementById("dtitle").textContent="DAILY DIGEST — "+(view==="all"?dates.find(d=>DATA.summaries[d]):view);
  document.getElementById("doverall").textContent=dg.overall||"";
  document.getElementById("dgrid").innerHTML=Object.entries(dg.perProject||{}).map(([n,t])=>'<div class="dcard"><div class="dname">'+esc(n)+"</div>"+esc(t)+"</div>").join("")}
 else dp.style.display="none";
 let f=view==="all"?DATA.articles:DATA.articles.filter(a=>a.scanDate===view);
 if(fp!=="all")f=f.filter(a=>a.projectId===fp);
 if(fs!=="all")f=f.filter(a=>a.status===fs);
 f=[...f].sort((x,y)=>sort==="urgency"?y.urgency-x.urgency||y.quality-x.quality:sort==="quality"?y.quality-x.quality||y.urgency-x.urgency:(y.published||"").localeCompare(x.published||""));
 document.getElementById("feed").innerHTML=f.length?f.map(a=>
  '<article class="card"><div class="urg">'+[5,4,3,2,1].map(n=>'<div class="useg" style="background:'+(n<=a.urgency?(a.urgency>=4?"var(--dng)":"var(--sig)"):"var(--line)")+'"></div>').join("")+"</div>"+
  '<div style="flex:1;min-width:0"><div class="meta"><span class="badge" style="background:'+(a.status==="new"?"var(--ok)":"var(--upd)")+'">'+(a.status==="new"?"NEW":"UPDATE")+"</span>"+
  '<span class="tag">'+esc(a.topic)+'</span><span class="mm">'+esc(a.projectName)+'</span><span class="mm">'+esc(a.published)+"</span>"+(view==="all"?'<span class="mm">filed '+esc(a.scanDate)+"</span>":"")+"</div>"+
  "<h2>"+(a.url?'<a href="'+esc(a.url)+'" target="_blank" rel="noreferrer">'+esc(a.title)+"</a>":esc(a.title))+"</h2>"+
  (a.status==="update"&&a.updateOf?'<div class="upof">&#8627; develops: '+esc(a.updateOf)+"</div>":"")+
  '<p class="sum">'+esc(a.summary)+'</p><div class="foot"><span style="font-weight:600">'+esc(a.source)+'</span><span style="color:var(--soft)">source quality</span>'+
  '<span class="q">'+"&#9679;".repeat(a.quality)+'<span class="off">'+"&#9679;".repeat(5-a.quality)+"</span></span></div></div></article>").join("")
  :'<div class="empty">Nothing filed on this day.</div>'}
fProj.onchange=e=>{fp=e.target.value;render()};
document.getElementById("fStatus").onchange=e=>{fs=e.target.value;render()};
document.getElementById("fSort").onchange=e=>{sort=e.target.value;render()};
render();
</script></body></html>`;
writeFileSync("index.html", html);
console.log("✓ index.html rendered");

/* ---------- Telegram alerts ---------- */
const threshold = config.alert_min_urgency || 4;
const urgent = fresh.filter(a => a.urgency >= threshold);
if (urgent.length > 0 && TG_TOKEN && TG_CHAT) {
  const esc = s => String(s ?? "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const lines = urgent.map(a =>
    `\u26A0 <b>${esc(a.projectName)}</b> — ${a.status === "update" ? "UPDATE" : "NEW"} (urgency ${a.urgency}/5)\n` +
    `${esc(a.title)}\n${esc(a.summary)}\n${esc(a.source)}${a.url ? " — " + esc(a.url) : ""}`);
  const text = `\u{1F4E1} NEWSDESK ALERT — ${today}\n\n` + lines.join("\n\n");
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text: text.slice(0, 4000), parse_mode: "HTML", disable_web_page_preview: true }),
    });
    const j = await r.json();
    console.log(j.ok ? `✓ Telegram alert sent (${urgent.length} urgent items)` : "✗ Telegram: " + JSON.stringify(j));
  } catch (e) { console.log("✗ Telegram: " + e.message); }
} else if (urgent.length > 0) {
  console.log(`(${urgent.length} urgent items — Telegram not configured, no alert sent)`);
} else {
  console.log("no urgent items today");
}
