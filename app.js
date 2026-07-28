/* FocusTube — minimal distraction-free YouTube client */
"use strict";

/* ---------------- state & storage ---------------- */
const DEFAULT_INSTANCES = [
  "https://invidious.nerdvpn.de",
  "https://invidious.f5.si",
  "https://inv.thepixora.com",
  "https://yt.chocolatemoo53.com",
  "https://invidious.tiekoetter.com",
  "https://inv.nadeko.net"
];
const YT_OFFICIAL = "__youtube__";

const store = {
  get(k, d) {
    try { const v = localStorage.getItem("ft_" + k); return v === null ? d : JSON.parse(v); }
    catch (e) { return d; }
  },
  set(k, v) { localStorage.setItem("ft_" + k, JSON.stringify(v)); }
};

let state = {
  apiKey: store.get("apiKey", ""),
  channels: store.get("channels", []),            // {id,title,thumb}
  instance: store.get("instance", DEFAULT_INSTANCES[0]),
  customInstances: store.get("customInstances", []),
  proxy: store.get("proxy", true),
  hideShorts: store.get("hideShorts", true),
  perChannel: store.get("perChannel", 8),
  speed: store.get("speed", 2),
  quality: store.get("quality", "720p"),
  feedCache: store.get("feedCache", null)          // {ts, videos}
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function toast(msg, ms = 2600) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), ms);
}

/* ---------------- YouTube Data API ---------------- */
async function yt(endpoint, params) {
  if (!state.apiKey) throw new Error("NO_KEY");
  const url = new URL("https://www.googleapis.com/youtube/v3/" + endpoint);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("key", state.apiKey);
  const res = await fetch(url);
  if (!res.ok) {
    let reason = "";
    try { reason = (await res.json())?.error?.errors?.[0]?.reason || ""; } catch (e) {}
    if (reason === "quotaExceeded") throw new Error("QUOTA");
    if (res.status === 400 || res.status === 403) throw new Error("BAD_KEY:" + reason);
    throw new Error("HTTP_" + res.status);
  }
  return res.json();
}

function apiErrorMessage(e) {
  if (e.message === "NO_KEY") return "Add your YouTube API key in Settings first.";
  if (e.message === "QUOTA") return "Daily API quota reached. Resets at midnight Pacific time.";
  if (e.message.startsWith("BAD_KEY")) return "API request rejected — check your API key and its restrictions.";
  return "Network error — please try again.";
}

/* ISO8601 duration -> seconds */
function parseDuration(iso) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || "");
  if (!m) return 0;
  return (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
}
function fmtDuration(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(sec).padStart(2, "0");
}
function timeAgo(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  const units = [[31536000, "year"], [2592000, "month"], [604800, "week"],
                 [86400, "day"], [3600, "hour"], [60, "minute"]];
  for (const [sec, name] of units) {
    if (diff >= sec) { const n = Math.floor(diff / sec); return `${n} ${name}${n > 1 ? "s" : ""} ago`; }
  }
  return "just now";
}

/* Fetch durations for a list of ids, returns Map id->{dur, live} */
async function fetchDetails(ids) {
  const map = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const data = await yt("videos", { part: "contentDetails,snippet", id: batch.join(","), maxResults: 50 });
    for (const it of data.items || []) {
      map.set(it.id, {
        dur: parseDuration(it.contentDetails?.duration),
        live: it.snippet?.liveBroadcastContent !== "none"
      });
    }
  }
  return map;
}

function isShort(v) {
  return (v.dur > 0 && v.dur <= 61) || /#shorts/i.test(v.title);
}

/* ---------------- feed ---------------- */
async function loadFeed(force) {
  const el = $("feedContent");
  if (!state.apiKey || state.channels.length === 0) {
    el.innerHTML = `<div class="empty">${!state.apiKey
      ? "Add your API key in Settings to get started."
      : "No channels yet — add the creators you follow in Settings."}</div>`;
    return;
  }
  const cache = state.feedCache;
  if (!force && cache && Date.now() - cache.ts < 15 * 60 * 1000 && cache.videos.length) {
    renderVideos(el, cache.videos);
    return;
  }
  el.innerHTML = `<div class="spinner"></div>`;
  try {
    const results = [];
    const chans = [...state.channels];
    const workers = Array.from({ length: 6 }, async () => {
      while (chans.length) {
        const ch = chans.shift();
        const uploads = "UU" + ch.id.slice(2);
        try {
          const data = await yt("playlistItems", {
            part: "snippet,contentDetails", playlistId: uploads, maxResults: state.perChannel
          });
          for (const it of data.items || []) {
            const sn = it.snippet;
            if (!sn || sn.title === "Private video" || sn.title === "Deleted video") continue;
            results.push({
              id: it.contentDetails.videoId,
              title: sn.title,
              channel: ch.title,
              published: it.contentDetails.videoPublishedAt || sn.publishedAt
            });
          }
        } catch (e) {
          if (e.message === "QUOTA" || e.message.startsWith("BAD_KEY") || e.message === "NO_KEY") throw e;
          /* channel-level failure (deleted channel etc.) — skip */
        }
      }
    });
    await Promise.all(workers);

    const details = await fetchDetails(results.map(v => v.id));
    let videos = results.map(v => ({ ...v, ...(details.get(v.id) || { dur: 0, live: false }) }))
      .filter(v => !v.live);
    if (state.hideShorts) videos = videos.filter(v => !isShort(v));
    videos.sort((a, b) => new Date(b.published) - new Date(a.published));
    videos = videos.slice(0, 200);

    state.feedCache = { ts: Date.now(), videos };
    store.set("feedCache", state.feedCache);
    renderVideos(el, videos);
  } catch (e) {
    el.innerHTML = `<div class="empty">${esc(apiErrorMessage(e))}</div>`;
  }
}

function renderVideos(el, videos) {
  if (!videos.length) { el.innerHTML = `<div class="empty">Nothing here yet.</div>`; return; }
  el.innerHTML = `<div class="vlist">` + videos.map(v => `
    <button class="vcard" data-id="${esc(v.id)}" data-title="${esc(v.title)}"
            data-channel="${esc(v.channel)}" data-published="${esc(v.published)}">
      <div class="thumbwrap">
        <img loading="lazy" src="https://i.ytimg.com/vi/${esc(v.id)}/mqdefault.jpg" alt="">
        ${v.dur ? `<span class="dur">${fmtDuration(v.dur)}</span>` : ""}
      </div>
      <div class="vmeta">
        <p class="vtitle">${esc(v.title)}</p>
        <p class="vsub">${esc(v.channel)} · ${timeAgo(v.published)}</p>
      </div>
    </button>`).join("") + `</div>`;
  el.querySelectorAll(".vcard").forEach(b =>
    b.addEventListener("click", () => openPlayer(b.dataset)));
}

/* ---------------- search ---------------- */
async function runSearch(q) {
  const el = $("searchContent");
  el.innerHTML = `<div class="spinner"></div>`;
  try {
    const data = await yt("search", {
      part: "snippet", type: "video", q, maxResults: 25, safeSearch: "none"
    });
    const base = (data.items || []).map(it => ({
      id: it.id.videoId,
      title: it.snippet.title,
      channel: it.snippet.channelTitle,
      published: it.snippet.publishedAt
    }));
    const details = await fetchDetails(base.map(v => v.id));
    let videos = base.map(v => ({ ...v, ...(details.get(v.id) || { dur: 0, live: false }) }));
    if (state.hideShorts) videos = videos.filter(v => !isShort(v));
    renderVideos(el, videos);
  } catch (e) {
    el.innerHTML = `<div class="empty">${esc(apiErrorMessage(e))}</div>`;
  }
}

/* ---------------- player ----------------
   Invidious sources: fetch stream URLs from the instance API and play in a
   native <video> element (works even when the instance disables /embed;
   speed changes are instant; quality switches keep position).
   Official YouTube source: iframe embed. */
const SPEEDS = [1, 1.5, 1.75, 2];
let current = null;
let streams = [];

const vid = () => document.getElementById("vid");
const officialSrc = (id) =>
  `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&modestbranding=1&playsinline=1`;
const officialIframe = (id) =>
  `<iframe src="${esc(officialSrc(id))}" allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowfullscreen></iframe>`;

function openPlayer(d) {
  current = { id: d.id, title: d.title, channel: d.channel, published: d.published };
  $("plTitle").textContent = d.title;
  $("plSub").textContent = `${d.channel} · ${timeAgo(d.published)}`;
  streams = [];
  setDescription("");
  renderSpeedChips();
  renderQualityChips();
  $("player").classList.add("open");
  document.body.style.overflow = "hidden";
  if (state.instance === YT_OFFICIAL) {
    $("plVideo").innerHTML = officialIframe(d.id);
    loadDescriptionFromYT(d.id);
  } else {
    startInvidious();
  }
}

/* description: collapsed by default, toggle to expand */
function setDescription(text) {
  const btn = $("descToggle"), box = $("plDesc");
  box.style.display = "none";
  box.textContent = text || "";
  btn.textContent = "Description ▾";
  btn.style.display = text ? "block" : "none";
}
async function loadDescriptionFromYT(id) {
  try {
    const d = await yt("videos", { part: "snippet", id });
    if (current && current.id === id) setDescription(d.items?.[0]?.snippet?.description || "");
  } catch (e) { /* no description available */ }
}

async function fetchStreams(instance, id) {
  const url = `${instance}/api/v1/videos/${id}${state.proxy ? "?local=true" : ""}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  const res = await fetch(url, { signal: ctrl.signal });
  clearTimeout(t);
  if (!res.ok) throw new Error("HTTP " + res.status);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  const fs = (data.formatStreams || []).filter(f => f.url)
    .sort((a, b) => (parseInt(b.resolution) || 0) - (parseInt(a.resolution) || 0));
  if (!fs.length) throw new Error("No playable streams");
  return { fs, description: data.description || "" };
}

let sourceQueue = [];
function startInvidious() {
  sourceQueue = [state.instance, ...allInstances().filter(i => i !== state.instance)];
  tryNextSource();
}
async function tryNextSource() {
  const id = current && current.id;
  while (current && current.id === id && sourceQueue.length) {
    const inst = sourceQueue.shift();
    $("plVideo").innerHTML = `<div class="plmsg"><div class="spinner" style="margin:0 auto"></div>
      <p style="color:var(--fg2);font-size:13px">Trying ${esc(inst.replace(/^https:\/\//, ""))}…</p></div>`;
    try {
      const r = await fetchStreams(inst, id);
      if (!current || current.id !== id) return; // player closed / changed meanwhile
      if (inst !== state.instance) {
        state.instance = inst; store.set("instance", inst);
        renderInstanceSelect();
        toast("Switched source to " + inst.replace(/^https:\/\//, ""));
      }
      setDescription(r.description);
      streams = r.fs;
      renderQualityChips();
      const pick = streams.find(s => (s.qualityLabel || s.resolution) === state.quality) || streams[0];
      mountVideo(pick, 0);
      return;
    } catch (e) { /* try next source */ }
  }
  if (current && current.id === id) playerError();
}

function mountVideo(streamObj, startAt) {
  $("plVideo").innerHTML = `<video id="vid" controls playsinline autoplay preload="metadata"></video>`;
  const v = vid();
  v.src = streamObj.url;
  v.playbackRate = state.speed;
  v.addEventListener("loadedmetadata", () => {
    if (startAt) v.currentTime = startAt;
    v.playbackRate = state.speed;
  });
  v.addEventListener("error", () => tryNextSource(), { once: true });
  v.play().catch(() => {});
}

function playerError() {
  if (!current) return;
  $("plVideo").innerHTML = `<div class="plmsg">
      <p>This source couldn't play the video.</p>
      <p style="color:var(--fg2);font-size:13px;margin:0">Switch source in Settings → Player, or:</p>
      <button class="btn" id="ytFallback">Play via YouTube (may show ads)</button>
    </div>`;
  $("ytFallback").addEventListener("click", () => {
    $("plVideo").innerHTML = officialIframe(current.id);
    loadDescriptionFromYT(current.id);
  });
}

function closePlayer() {
  $("player").classList.remove("open");
  $("plVideo").innerHTML = "";
  document.body.style.overflow = "";
  current = null;
  streams = [];
}

function renderSpeedChips() {
  $("speedChips").innerHTML = SPEEDS.map(s =>
    `<button class="chip${s === state.speed ? " active" : ""}" data-speed="${s}">${s}×</button>`).join("");
  $("speedChips").querySelectorAll(".chip").forEach(c => c.addEventListener("click", () => {
    state.speed = parseFloat(c.dataset.speed); store.set("speed", state.speed);
    renderSpeedChips();
    const v = vid();
    if (v) v.playbackRate = state.speed;
    else if (state.instance === YT_OFFICIAL) toast("Speed control works on Invidious sources");
  }));
}

function renderQualityChips() {
  const el = $("qualityChips");
  if (state.instance === YT_OFFICIAL && !vid()) {
    el.innerHTML = `<span class="hint">Use the ⚙️ menu inside the YouTube player.</span>`;
    return;
  }
  if (!streams.length) {
    el.innerHTML = `<span class="hint">Qualities appear once the video loads.</span>`;
    return;
  }
  el.innerHTML = streams.map(s => {
    const label = s.qualityLabel || s.resolution || "?";
    return `<button class="chip${label === state.quality ? " active" : ""}" data-q="${esc(label)}">${esc(label)}</button>`;
  }).join("");
  el.querySelectorAll(".chip").forEach(c => c.addEventListener("click", () => {
    state.quality = c.dataset.q; store.set("quality", state.quality);
    const v = vid();
    const at = v ? v.currentTime : 0;
    const s = streams.find(x => (x.qualityLabel || x.resolution) === state.quality) || streams[0];
    renderQualityChips();
    mountVideo(s, at);
  }));
}

/* ---------------- channels ---------------- */
function renderChannels() {
  const list = $("chanList");
  list.innerHTML = state.channels.map((c, i) => `
    <div class="chanrow">
      <img src="${esc(c.thumb || "")}" alt="" onerror="this.style.visibility='hidden'">
      <span class="name">${esc(c.title)}</span>
      <button class="btn small" data-rm="${i}">Remove</button>
    </div>`).join("");
  $("chanCount").textContent = state.channels.length
    ? `${state.channels.length} channel${state.channels.length > 1 ? "s" : ""} · one feed refresh ≈ ${state.channels.length + Math.ceil(state.channels.length * state.perChannel / 50)} quota units`
    : "";
  list.querySelectorAll("[data-rm]").forEach(b => b.addEventListener("click", () => {
    state.channels.splice(+b.dataset.rm, 1);
    saveChannels();
  }));
}
function saveChannels() {
  store.set("channels", state.channels);
  state.feedCache = null; store.set("feedCache", null);
  renderChannels();
}
function addChannel(c) {
  if (state.channels.some(x => x.id === c.id)) { toast("Already added"); return; }
  state.channels.push(c);
  state.channels.sort((a, b) => a.title.localeCompare(b.title));
  saveChannels();
  toast(`Added ${c.title}`);
}

async function handleChannelAdd() {
  const raw = $("chanInput").value.trim();
  if (!raw) return;
  const results = $("chanResults");
  results.innerHTML = `<div class="spinner" style="margin:16px auto"></div>`;
  try {
    // direct id / handle / URL?
    let m;
    if ((m = raw.match(/(UC[\w-]{22})/))) {
      const d = await yt("channels", { part: "snippet", id: m[1] });
      results.innerHTML = "";
      if (d.items?.length) return addFromChannelResource(d.items[0]);
      return toast("Channel not found");
    }
    const handle = (m = raw.match(/@([\w.\-]+)/)) ? m[1] : null;
    if (handle) {
      const d = await yt("channels", { part: "snippet", forHandle: handle });
      results.innerHTML = "";
      if (d.items?.length) return addFromChannelResource(d.items[0]);
      return toast("Handle not found");
    }
    // fall back to search (100 quota units)
    const d = await yt("search", { part: "snippet", type: "channel", q: raw, maxResults: 5 });
    if (!d.items?.length) { results.innerHTML = ""; return toast("No channels found"); }
    results.innerHTML = d.items.map(it => `
      <div class="chanrow">
        <img src="${esc(it.snippet.thumbnails?.default?.url || "")}" alt="">
        <span class="name">${esc(it.snippet.title)}</span>
        <button class="btn small primary" data-add="${esc(it.snippet.channelId)}"
          data-title="${esc(it.snippet.title)}"
          data-thumb="${esc(it.snippet.thumbnails?.default?.url || "")}">Add</button>
      </div>`).join("") +
      `<div class="hint">Tip: adding by @handle or channel URL costs 1 quota unit instead of 100.</div>`;
    results.querySelectorAll("[data-add]").forEach(b => b.addEventListener("click", () => {
      addChannel({ id: b.dataset.add, title: b.dataset.title, thumb: b.dataset.thumb });
      results.innerHTML = ""; $("chanInput").value = "";
    }));
  } catch (e) {
    results.innerHTML = "";
    toast(apiErrorMessage(e));
  }
}
function addFromChannelResource(item) {
  addChannel({
    id: item.id, title: item.snippet.title,
    thumb: item.snippet.thumbnails?.default?.url || ""
  });
  $("chanInput").value = "";
}

/* ---------------- instances / settings ---------------- */
function allInstances() {
  return [...DEFAULT_INSTANCES, ...state.customInstances];
}
function renderInstanceSelect() {
  const sel = $("instanceSelect");
  sel.innerHTML = allInstances().map(i =>
    `<option value="${esc(i)}"${i === state.instance ? " selected" : ""}>${esc(i.replace(/^https:\/\//, ""))}</option>`).join("") +
    `<option value="${YT_OFFICIAL}"${state.instance === YT_OFFICIAL ? " selected" : ""}>YouTube official (may show ads)</option>`;
}
async function testInstance() {
  const s = $("instanceStatus");
  if (state.instance === YT_OFFICIAL) { s.textContent = "✅ Official embeds always available"; return; }
  s.textContent = "⏳ testing…";
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(state.instance + "/api/v1/videos/jNQXAC9IVRw?fields=videoId,formatStreams", { signal: ctrl.signal });
    clearTimeout(t);
    if (res.ok) {
      const j = await res.json();
      const n = (j.formatStreams || []).filter(f => f.url).length;
      s.textContent = n ? "✅ working (video streams available)"
        : "⚠️ reachable, but no video streams — try another";
    }
    else s.textContent = `⚠️ HTTP ${res.status} — try another source`;
  } catch (e) {
    s.textContent = "❌ unreachable — pick another source";
  }
}

function bindSettings() {
  $("apiKeyInput").value = state.apiKey;
  $("saveKeyBtn").addEventListener("click", () => {
    state.apiKey = $("apiKeyInput").value.trim();
    store.set("apiKey", state.apiKey);
    state.feedCache = null; store.set("feedCache", null);
    toast(state.apiKey ? "API key saved" : "API key cleared");
  });

  $("chanAddBtn").addEventListener("click", handleChannelAdd);
  $("chanInput").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); handleChannelAdd(); } });

  renderInstanceSelect();
  $("instanceSelect").addEventListener("change", e => {
    state.instance = e.target.value; store.set("instance", state.instance);
    $("instanceStatus").textContent = "";
  });
  $("addInstanceBtn").addEventListener("click", () => {
    let v = $("customInstance").value.trim().replace(/\/+$/, "");
    if (!v) return;
    if (!/^https:\/\//.test(v)) v = "https://" + v;
    if (!allInstances().includes(v)) {
      state.customInstances.push(v); store.set("customInstances", state.customInstances);
    }
    state.instance = v; store.set("instance", v);
    renderInstanceSelect(); $("customInstance").value = "";
    toast("Source added — tap Test source");
  });
  $("testInstanceBtn").addEventListener("click", testInstance);

  $("proxyToggle").checked = state.proxy;
  $("proxyToggle").addEventListener("change", e => { state.proxy = e.target.checked; store.set("proxy", state.proxy); });

  $("shortsToggle").checked = state.hideShorts;
  $("shortsToggle").addEventListener("change", e => {
    state.hideShorts = e.target.checked; store.set("hideShorts", state.hideShorts);
    state.feedCache = null; store.set("feedCache", null);
  });

  $("perChannel").value = String(state.perChannel);
  $("perChannel").addEventListener("change", e => {
    let v = parseInt(e.target.value, 10);
    if (!Number.isFinite(v)) v = 8;
    v = Math.min(50, Math.max(1, v));
    e.target.value = String(v);
    state.perChannel = v; store.set("perChannel", state.perChannel);
    state.feedCache = null; store.set("feedCache", null);
    renderChannels();
  });

  $("exportBtn").addEventListener("click", () => {
    const data = {
      channels: state.channels, instance: state.instance, customInstances: state.customInstances,
      proxy: state.proxy, hideShorts: state.hideShorts, perChannel: state.perChannel,
      speed: state.speed, quality: state.quality
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "focustube-backup.json"; a.click();
    URL.revokeObjectURL(a.href);
  });
  $("importBtn").addEventListener("click", () => $("importFile").click());
  $("importFile").addEventListener("change", async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (Array.isArray(data.channels)) state.channels = data.channels.filter(c => c.id && c.title);
      for (const k of ["instance", "proxy", "hideShorts", "perChannel", "speed", "quality"])
        if (data[k] !== undefined) state[k] = data[k];
      if (Array.isArray(data.customInstances)) state.customInstances = data.customInstances;
      for (const k of ["channels", "instance", "customInstances", "proxy", "hideShorts", "perChannel", "speed", "quality"])
        store.set(k, state[k]);
      state.feedCache = null; store.set("feedCache", null);
      renderChannels(); renderInstanceSelect(); bindSettingsValues();
      toast("Imported");
    } catch (err) { toast("Could not read that file"); }
    e.target.value = "";
  });
}
function bindSettingsValues() {
  $("proxyToggle").checked = state.proxy;
  $("shortsToggle").checked = state.hideShorts;
  $("perChannel").value = String(state.perChannel);
}

/* ---------------- navigation ---------------- */
const TABS = ["feed", "search", "settings"];
function switchTab(name) {
  TABS.forEach(t => {
    $("screen-" + t).classList.toggle("active", t === name);
    $("tab-" + t).classList.toggle("active", t === name);
  });
  $("headerTitle").textContent = name === "feed" ? "Subscriptions"
    : name === "search" ? "Search" : "Settings";
  $("refreshBtn").style.visibility = name === "feed" ? "visible" : "hidden";
  window.scrollTo(0, 0);
  if (name === "feed") loadFeed(false);
}

/* ---------------- init ---------------- */
function init() {
  TABS.forEach(t => $("tab-" + t).addEventListener("click", () => switchTab(t)));
  $("refreshBtn").addEventListener("click", () => loadFeed(true));
  $("playerClose").addEventListener("click", closePlayer);
  $("backBtn").addEventListener("click", closePlayer);
  $("descToggle").addEventListener("click", () => {
    const box = $("plDesc");
    const open = box.style.display !== "none";
    box.style.display = open ? "none" : "block";
    $("descToggle").textContent = open ? "Description ▾" : "Description ▴";
  });
  $("searchForm").addEventListener("submit", e => {
    e.preventDefault();
    const q = $("searchInput").value.trim();
    if (q) runSearch(q);
    $("searchInput").blur();
  });
  bindSettings();
  renderChannels();
  loadFeed(false);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}
document.addEventListener("DOMContentLoaded", init);
