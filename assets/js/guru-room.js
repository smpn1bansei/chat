import {
  auth, db, $, $$, esc, escMultiline, toast, initTheme, friendlyError, configWarning, tsMillis, fmtClock,
  fmtCountdown, fmtTimer, avatarHtml, rankPlayers, beep, confirmDialog, promptDialog, deleteRoomDeep,
  joinUrl, setLoading, ONLINE_WINDOW, DEFAULT_SETTINGS
} from "./common.js";
import {
  doc, collection, query, orderBy, onSnapshot, getDoc, updateDoc, writeBatch, serverTimestamp,
  increment, Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

initTheme();
configWarning();

const code = new URLSearchParams(location.search).get("room");
if (!/^\d{4}$/.test(code || "")) location.replace("guru.html");

const roomRef = doc(db, "rooms", code);
const messagesCol = collection(db, "rooms", code, "messages");
const msgRef = id => doc(db, "rooms", code, "messages", id);
const ansRef = id => doc(db, "rooms", code, "answers", id);
const playerRef = id => doc(db, "rooms", code, "players", id);

let me = null, room = null;
let messages = [], answers = [], players = [];
let msgType = "question", pointsDirty = false, timerDirty = false, sending = false;
let firstFeed = true, ansReady = false;
const knownAnswers = new Set();
const closing = new Set();
const unsubs = [];
const feed = $("#feed");
const settings = () => ({ ...DEFAULT_SETTINGS, ...(room?.settings || {}) });

// ---------- Tab mobile ----------
$$("#mobileTabs button").forEach(b => b.onclick = () => {
  $$("#mobileTabs button").forEach(x => x.classList.toggle("active", x === b));
  $$(".tab-pane").forEach(p => p.classList.toggle("show", p.dataset.pane === b.dataset.tab));
});

// ---------- Akses ----------
function fatal(icon, title, msg) {
  unsubs.forEach(u => u());
  $("#loading").innerHTML = `<div class="card">
    <div class="big">${icon}</div>
    <h2 style="margin-bottom:6px">${esc(title)}</h2>
    <p class="muted">${msg}</p>
    <a class="btn btn-primary btn-block" href="guru.html">Kembali ke dashboard</a>
  </div>`;
  $("#loading").classList.remove("hidden");
}

await auth.authStateReady();
me = auth.currentUser;
if (!me || me.isAnonymous) {
  location.replace("guru.html");
} else {
  try {
    const snap = await getDoc(roomRef);
    if (!snap.exists()) fatal("🔎", "Room tidak ditemukan", `Room dengan kode <b>${esc(code)}</b> tidak ada atau sudah dihapus.`);
    else if (snap.data().ownerUid !== me.uid) {
      fatal("🔒", "Bukan room Anda", `Room <b>${esc(code)}</b> dibuat oleh <b>${esc(snap.data().ownerName || "guru lain")}</b>. Anda hanya dapat mengelola room yang Anda buat sendiri.`);
    } else start();
  } catch (e) {
    fatal("⚠️", "Gagal membuka room", esc(friendlyError(e)));
  }
}

function start() {
  $("#roomCode").textContent = code;
  $("#loading").classList.add("hidden");

  unsubs.push(onSnapshot(roomRef, snap => {
    if (!snap.exists()) return fatal("🗑️", "Room dihapus", "Room ini sudah tidak ada.");
    room = { id: snap.id, ...snap.data() };
    renderHeader();
    renderSettings();
    renderFeed();
  }, e => toast(friendlyError(e), "error")));

  unsubs.push(onSnapshot(query(messagesCol, orderBy("createdAt")), snap => {
    messages = snap.docs.map(d => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
    renderFeed();
    renderLiveStats();
  }, e => toast(friendlyError(e), "error")));

  unsubs.push(onSnapshot(query(collection(db, "rooms", code, "answers"), orderBy("createdAt")), snap => {
    answers = snap.docs.map(d => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
    let fresh = false;
    for (const a of answers) {
      if (!knownAnswers.has(a.id)) { knownAnswers.add(a.id); if (ansReady) fresh = true; }
    }
    ansReady = true;
    if (fresh) beep("answer");
    renderFeed();
    renderLiveStats();
  }, e => toast(friendlyError(e), "error")));

  unsubs.push(onSnapshot(collection(db, "rooms", code, "players"), snap => {
    players = snap.docs.map(d => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
    renderLeaderboard();
    renderLiveStats();
  }, e => toast(friendlyError(e), "error")));

  setInterval(tick, 1000);
  setInterval(() => { renderLeaderboard(); renderLiveStats(); }, 15000);
}

// ---------- Header & kontrol ----------
function renderHeader() {
  $("#roomName").textContent = room.name || `Room ${code}`;
  $("#roomSub").textContent = `👩‍🏫 ${room.ownerName || ""}`;
  document.title = `${code} · ${room.name || "Room"} — Educhat Guru`;
  $("#statusBadge").innerHTML = {
    open: `<span class="badge badge-success">● Aktif</span>`,
    locked: `<span class="badge badge-warning">🔒 Dikunci</span>`,
    ended: `<span class="badge badge-danger">⏹ Berakhir</span>`
  }[room.status] || "";
  $("#lockBtn").innerHTML = room.status === "locked" ? "🔓 Buka kunci room" : "🔒 Kunci room (tolak siswa baru)";
  $("#lockBtn").disabled = room.status === "ended";
  $("#endBtn").innerHTML = room.status === "ended" ? "▶️ Aktifkan kembali room" : "⏹ Akhiri permainan";
  $("#projCode").textContent = code;
}

$("#lockBtn").onclick = async () => {
  try {
    const next = room.status === "locked" ? "open" : "locked";
    await updateDoc(roomRef, { status: next, updatedAt: serverTimestamp() });
    toast(next === "locked" ? "Room dikunci. Siswa baru tidak bisa bergabung." : "Room dibuka kembali.", "success");
  } catch (e) { toast(friendlyError(e), "error"); }
};

$("#endBtn").onclick = async () => {
  if (room.status !== "ended") {
    const ok = await confirmDialog({
      title: "Akhiri permainan?",
      message: "Semua pertanyaan akan ditutup dan siswa melihat peringkat akhir mereka. Anda masih bisa mengaktifkannya kembali.",
      okText: "Akhiri", danger: true
    });
    if (!ok) return;
  }
  try {
    const batch = writeBatch(db);
    if (room.status !== "ended") {
      messages.filter(m => m.type === "question" && m.status === "open")
        .forEach(m => batch.update(msgRef(m.id), { status: "closed", closedAt: serverTimestamp() }));
    }
    batch.update(roomRef, { status: room.status === "ended" ? "open" : "ended", updatedAt: serverTimestamp() });
    await batch.commit();
  } catch (e) { toast(friendlyError(e), "error"); }
};

$("#deleteBtn").onclick = async () => {
  const typed = await promptDialog({
    title: "Hapus room permanen", label: `Ketik kode room (${code}) untuk konfirmasi`,
    placeholder: code, okText: "Hapus permanen",
    hint: "Semua pertanyaan, jawaban, dan poin siswa akan terhapus dan tidak bisa dikembalikan."
  });
  if (typed === null) return;
  if (typed !== code) return toast("Kode tidak cocok. Room tidak dihapus.", "error");
  const btn = $("#deleteBtn");
  setLoading(btn, true, "Menghapus…");
  try {
    unsubs.forEach(u => u());
    await deleteRoomDeep(code);
    toast("Room dihapus.", "success");
    setTimeout(() => location.replace("guru.html"), 700);
  } catch (e) {
    toast(friendlyError(e), "error");
    setLoading(btn, false);
  }
};

$("#exportBtn").onclick = () => {
  const list = rankPlayers(players);
  if (!list.length) return toast("Belum ada siswa di room ini.", "error");
  const qCount = messages.filter(m => m.type === "question").length;
  const rows = [["Peringkat", "Nama", "Kelas", "Poin", "Jawaban Benar", "Jawaban Salah", "Total Jawaban", "Jumlah Pertanyaan"]];
  for (const p of list) {
    const mine = answers.filter(a => a.uid === p.id);
    rows.push([p.rank, p.name, p.kelasLabel || "", p.score || 0,
      mine.filter(a => a.status === "correct").length, mine.filter(a => a.status === "wrong").length, mine.length, qCount]);
  }
  const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(";")).join("\r\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  const d = new Date();
  a.href = URL.createObjectURL(blob);
  a.download = `educhat-room-${code}-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast("Rekap nilai diunduh.", "success");
};

// ---------- Pengaturan live ----------
function renderSettings() {
  const s = settings();
  $$("#sMode button").forEach(b => b.classList.toggle("active", b.dataset.v === s.answerMode));
  $("#modeHint").textContent = s.answerMode === "single"
    ? "Siswa hanya bisa mengirim 1 jawaban untuk setiap pertanyaan."
    : "Siswa boleh mengirim beberapa jawaban untuk setiap pertanyaan.";
  const setIfIdle = (id, v) => { const el = $(id); if (document.activeElement !== el) el.value = v; };
  setIfIdle("#sPoints", s.defaultPoints);
  setIfIdle("#sMax", s.maxFastest);
  setIfIdle("#sShow", s.showAnswers);
  setIfIdle("#sTimer", String(s.defaultTimer));
  if (!pointsDirty) $("#qPoints").value = s.defaultPoints;
  if (!timerDirty) $("#qTimer").value = String(s.defaultTimer);
}

async function saveSetting(key, value, label) {
  if (settings()[key] === value) return;
  const st = $("#saveState");
  st.textContent = "Menyimpan…";
  try {
    await updateDoc(roomRef, { [`settings.${key}`]: value, updatedAt: serverTimestamp() });
    st.textContent = "✓ Tersimpan";
    toast(`${label} diperbarui.`, "success", 1800);
  } catch (e) {
    st.textContent = "Gagal";
    toast(friendlyError(e), "error");
  }
  setTimeout(() => { st.textContent = "Live"; }, 1500);
}

$$("#sMode button").forEach(b => b.onclick = () => saveSetting("answerMode", b.dataset.v, "Mode jawaban"));

function bindNumber(id, key, label, min, max) {
  const el = $(id);
  const commit = () => {
    let v = Math.round(Number(el.value));
    if (!Number.isFinite(v)) v = settings()[key];
    v = Math.min(max, Math.max(min, v));
    el.value = v;
    saveSetting(key, v, label);
  };
  el.addEventListener("change", commit);
  el.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); el.blur(); } });
  $$(`[data-step="${id.slice(1)}"]`).forEach(b => b.onclick = () => {
    el.value = Math.min(max, Math.max(min, (Number(el.value) || 0) + Number(b.dataset.d)));
    commit();
  });
}
bindNumber("#sPoints", "defaultPoints", "Poin default", 1, 1000);
bindNumber("#sMax", "maxFastest", "Maks. penjawab tercepat", 0, 500);
$("#sShow").onchange = e => saveSetting("showAnswers", e.target.value, "Visibilitas jawaban");
$("#sTimer").onchange = e => saveSetting("defaultTimer", Number(e.target.value), "Timer default");

// ---------- Kirim pertanyaan / pengumuman ----------
$$("#qType button").forEach(b => b.onclick = () => {
  msgType = b.dataset.v;
  $$("#qType button").forEach(x => x.classList.toggle("active", x === b));
  $$(".q-only").forEach(x => x.classList.toggle("hidden", msgType !== "question"));
  $("#qText").placeholder = msgType === "question"
    ? "Tulis pertanyaan untuk siswa… (Enter untuk kirim, Shift+Enter baris baru)"
    : "Tulis pengumuman untuk siswa…";
});
$("#qPoints").addEventListener("input", () => { pointsDirty = true; });
$("#qTimer").addEventListener("change", () => { timerDirty = true; });
$("#qText").addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
$("#sendBtn").onclick = send;

async function send() {
  const text = $("#qText").value.trim();
  if (!text || sending) return;
  if (room.status === "ended") return toast("Room sudah berakhir. Aktifkan kembali untuk mengirim pertanyaan.", "error");
  const batch = writeBatch(db);
  const base = { text, createdAt: serverTimestamp(), responders: [], answerCount: 0, deadline: null };
  if (msgType === "question") {
    const points = Math.round(Number($("#qPoints").value));
    if (!(points >= 1 && points <= 1000)) return toast("Poin harus antara 1–1000.", "error");
    const t = Number($("#qTimer").value) || 0;
    messages.filter(m => m.type === "question" && m.status === "open")
      .forEach(m => batch.update(msgRef(m.id), { status: "closed", closedAt: serverTimestamp() }));
    const number = messages.reduce((n, m) => Math.max(n, m.number || 0), 0) + 1;
    batch.set(doc(messagesCol), {
      ...base, type: "question", number, points, status: "open", timer: t,
      deadline: t ? Timestamp.fromMillis(Date.now() + t * 1000) : null
    });
  } else {
    batch.set(doc(messagesCol), { ...base, type: "info", status: "closed" });
  }
  sending = true;
  setLoading($("#sendBtn"), true);
  try {
    await batch.commit();
    $("#qText").value = "";
    pointsDirty = false; timerDirty = false;
    renderSettings();
    firstFeed = true; // gulir ke bawah
  } catch (e) {
    toast(friendlyError(e), "error");
  } finally {
    sending = false;
    setLoading($("#sendBtn"), false);
    $("#qText").focus();
  }
}

// ---------- Feed guru ----------
function renderLiveStats() {
  const online = players.filter(p => !p.kicked && Date.now() - (tsMillis(p.lastSeen) || 0) < ONLINE_WINDOW).length;
  const total = players.filter(p => !p.kicked).length;
  const qn = messages.filter(m => m.type === "question").length;
  $("#liveStats").innerHTML = `
    <span class="badge badge-success"><span class="dot dot-on"></span>${online}/${total} online</span>
    <span class="badge hide-sm">❓ ${qn} pertanyaan</span>`;
  $("#onlineCount").textContent = `${online} online · ${total} siswa`;
}

function questionCard(m, list) {
  const s = settings();
  const dl = tsMillis(m.deadline), startMs = tsMillis(m.createdAt);
  const running = m.status === "open" && dl && dl > Date.now();
  const correct = list.filter(a => a.status === "correct").length;
  const pending = list.filter(a => a.status === "pending").length;
  const resp = (m.responders || []).length;
  const correctUids = new Set();

  const ans = list.map((a, i) => {
    const secs = startMs && tsMillis(a.createdAt) ? ((tsMillis(a.createdAt) - startMs) / 1000).toFixed(1) : "-";
    const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`;
    const already = a.status !== "correct" && correctUids.has(a.uid);
    if (a.status === "correct") correctUids.add(a.uid);
    return `<div class="ans ${a.status}" data-ans="${a.id}" title="Klik untuk menandai benar/salah">
      <span class="ans-rank">${medal}</span>
      ${avatarHtml(a.name)}
      <div class="ans-main">
        <div class="ans-who">${esc(a.name)} <small>${esc(a.kelasLabel || "")} · +${secs} dtk</small>
          ${a.status === "correct" ? `<span class="badge badge-success">+${a.points}</span>` : ""}
          ${already ? `<span class="badge badge-warning">sudah benar sebelumnya</span>` : ""}
        </div>
        <div class="ans-text">${escMultiline(a.text)}</div>
      </div>
      <div class="ans-btns">
        <button class="btn ok ${a.status === "correct" ? "on" : ""}" data-grade="correct" data-id="${a.id}" title="Benar (beri poin)">✓</button>
        <button class="btn no ${a.status === "wrong" ? "on" : ""}" data-grade="wrong" data-id="${a.id}" title="Salah">✗</button>
      </div>
    </div>`;
  }).join("");

  const status = m.status === "open"
    ? (dl && !running ? `<span class="badge badge-warning">⏰ Waktu habis</span>` : `<span class="badge badge-success">● Dibuka</span>`)
    : `<span class="badge">Ditutup</span>`;

  return `<div class="qcard ${m.status === "open" ? "active" : ""}">
    <div class="qcard-head">
      <div class="q-head">
        <span class="q-num">PERTANYAAN #${m.number || ""}</span>
        <span class="badge badge-primary">+${m.points} poin</span>
        ${status}
        ${running ? `<span class="badge badge-accent">⏱ <b data-deadline="${dl}">${fmtCountdown((dl - Date.now()) / 1000)}</b></span>` : ""}
        <div class="qcard-actions">
          ${m.status === "open"
            ? `<button class="btn btn-ghost btn-sm" data-act="close" data-id="${m.id}">⏹ Tutup</button>`
            : `<button class="btn btn-ghost btn-sm" data-act="reopen" data-id="${m.id}">▶ Buka lagi</button>`}
          <button class="btn btn-ghost btn-icon btn-sm" data-act="edit-points" data-id="${m.id}" title="Ubah poin">⭐</button>
          <button class="btn btn-ghost btn-icon btn-sm" data-act="delete" data-id="${m.id}" title="Hapus pertanyaan">🗑</button>
        </div>
      </div>
      <div class="q-text">${escMultiline(m.text)}</div>
      ${running ? `<div class="timebar"><i data-bar-start="${startMs}" data-bar-end="${dl}" style="width:${barPct(startMs, dl)}%"></i></div>` : ""}
      <div class="q-foot">
        <span>💬 ${list.length} jawaban dari ${resp} siswa${s.maxFastest > 0 && m.status === "open" ? ` (batas ${s.maxFastest})` : ""}</span>
        <span>✅ ${correct} benar</span>
        ${pending ? `<span>⏳ ${pending} belum dinilai</span>` : ""}
        <span>${fmtClock(startMs)}${m.timer ? ` · timer ${fmtTimer(m.timer)}` : ""}</span>
      </div>
    </div>
    ${list.length
      ? `<div class="ans-list">${ans}</div>`
      : `<div class="ans-list"><div class="muted" style="font-size:.85rem;text-align:center">${m.status === "open" ? "⏳ Menunggu jawaban siswa…" : "Tidak ada jawaban."}</div></div>`}
  </div>`;
}

function barPct(start, end) {
  return Math.max(0, Math.min(100, ((end - Date.now()) / (end - start)) * 100));
}

function renderFeed() {
  if (!room) return;
  const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 200;
  if (!messages.length) {
    feed.innerHTML = `<div class="feed-empty">
      <div class="big">🎯</div>
      <b>Room siap dimainkan!</b>
      <p>Tampilkan kode <b>${esc(code)}</b> ke siswa melalui <b>Layar Proyektor</b>, lalu kirim pertanyaan pertama di bawah.</p>
    </div>`;
    return;
  }
  const byQ = {};
  for (const a of answers) (byQ[a.questionId] ||= []).push(a);
  feed.innerHTML = messages.map(m => {
    if (m.type === "info") {
      return `<div class="info-msg"><b>📢 Pengumuman:</b> ${escMultiline(m.text)}
        <button class="btn btn-ghost btn-icon btn-sm" data-act="delete" data-id="${m.id}" title="Hapus" style="margin-left:6px">🗑</button></div>`;
    }
    return m.type === "question" ? questionCard(m, byQ[m.id] || []) : "";
  }).join("");
  if (nearBottom || firstFeed) feed.scrollTop = feed.scrollHeight;
  firstFeed = false;
}

// Delegasi event klik pada feed
feed.addEventListener("click", async e => {
  const g = e.target.closest("[data-grade]");
  if (g) {
    e.stopPropagation();
    const a = answers.find(x => x.id === g.dataset.id);
    if (a) grade(a, a.status === g.dataset.grade ? "pending" : g.dataset.grade);
    return;
  }
  const act = e.target.closest("[data-act]");
  if (act) return questionAction(act.dataset.act, act.dataset.id);
  const row = e.target.closest("[data-ans]");
  if (row) {
    const a = answers.find(x => x.id === row.dataset.ans);
    if (a) grade(a, a.status === "correct" ? "wrong" : "correct");
  }
});

async function grade(a, newStatus) {
  const q = messages.find(m => m.id === a.questionId);
  const oldPts = a.status === "correct" ? (a.points || 0) : 0;
  const newPts = newStatus === "correct" ? (q?.points ?? settings().defaultPoints) : 0;
  const delta = newPts - oldPts;
  const batch = writeBatch(db);
  batch.update(ansRef(a.id), { status: newStatus, points: newPts, gradedAt: serverTimestamp() });
  if (delta) batch.update(playerRef(a.uid), { score: increment(delta) });
  try {
    await batch.commit();
    if (newStatus === "correct") beep("correct");
  } catch (e) { toast(friendlyError(e), "error"); }
}

async function questionAction(act, id) {
  const m = messages.find(x => x.id === id);
  if (!m) return;
  try {
    if (act === "close") {
      await updateDoc(msgRef(id), { status: "closed", closedAt: serverTimestamp() });
    } else if (act === "reopen") {
      const batch = writeBatch(db);
      messages.filter(x => x.type === "question" && x.status === "open" && x.id !== id)
        .forEach(x => batch.update(msgRef(x.id), { status: "closed", closedAt: serverTimestamp() }));
      const dl = tsMillis(m.deadline);
      batch.update(msgRef(id), { status: "open", ...(dl && dl <= Date.now() ? { deadline: null } : {}) });
      await batch.commit();
      toast(`Pertanyaan #${m.number} dibuka kembali.`, "success");
    } else if (act === "edit-points") {
      const v = await promptDialog({
        title: `Poin pertanyaan #${m.number}`, label: "Poin untuk jawaban benar", type: "number",
        value: String(m.points), hint: "Jawaban yang sudah dinilai benar akan disesuaikan otomatis."
      });
      if (v === null) return;
      const pts = Math.round(Number(v));
      if (!(pts >= 1 && pts <= 1000)) return toast("Poin harus antara 1–1000.", "error");
      const batch = writeBatch(db);
      batch.update(msgRef(id), { points: pts });
      for (const a of answers.filter(x => x.questionId === id && x.status === "correct")) {
        batch.update(ansRef(a.id), { points: pts });
        if (pts !== a.points) batch.update(playerRef(a.uid), { score: increment(pts - (a.points || 0)) });
      }
      await batch.commit();
      toast("Poin diperbarui.", "success");
    } else if (act === "delete") {
      const list = answers.filter(x => x.questionId === id);
      const ok = await confirmDialog({
        title: m.type === "info" ? "Hapus pengumuman?" : `Hapus pertanyaan #${m.number}?`,
        message: m.type === "info" ? "Pengumuman akan dihapus dari chat."
          : `${list.length} jawaban siswa ikut terhapus dan poin yang sudah diberikan akan ditarik kembali.`,
        okText: "Hapus", danger: true
      });
      if (!ok) return;
      const ops = [];
      const scoreBack = {};
      for (const a of list) {
        ops.push(b => b.delete(ansRef(a.id)));
        if (a.status === "correct") scoreBack[a.uid] = (scoreBack[a.uid] || 0) + (a.points || 0);
      }
      for (const [uid, pts] of Object.entries(scoreBack)) ops.push(b => b.update(playerRef(uid), { score: increment(-pts) }));
      ops.push(b => b.delete(msgRef(id)));
      for (let i = 0; i < ops.length; i += 450) {
        const batch = writeBatch(db);
        ops.slice(i, i + 450).forEach(fn => fn(batch));
        await batch.commit();
      }
      toast("Dihapus.", "success");
    }
  } catch (e) { toast(friendlyError(e), "error"); }
}

// ---------- Papan skor ----------
function podiumHtml(list) {
  const pod = [list[1], list[0], list[2]], cls = ["p2", "p1", "p3"], nums = [2, 1, 3];
  return pod.map((p, i) => p ? `
    <div class="pod ${cls[i]}">
      ${avatarHtml(p.name)}
      <div class="nm" title="${esc(p.name)}">${esc(p.name)}</div>
      <div class="pts">${p.score || 0} poin</div>
      <div class="block">${nums[i] === 1 ? "👑" : nums[i]}</div>
    </div>` : `
    <div class="pod ${cls[i]} empty-pod"><span class="avatar">?</span><div class="nm muted">—</div><div class="pts">&nbsp;</div><div class="block">${nums[i]}</div></div>`).join("");
}

function renderLeaderboard() {
  const list = rankPlayers(players);
  const kicked = players.filter(p => p.kicked);
  $("#podium").innerHTML = podiumHtml(list);
  const now = Date.now();
  const row = (p, isKicked = false) => {
    const online = !isKicked && now - (tsMillis(p.lastSeen) || 0) < ONLINE_WINDOW;
    return `<div class="lb-item ${isKicked ? "kicked" : ""}">
      <span class="lb-rank">${isKicked ? "—" : p.rank}</span>
      ${avatarHtml(p.name)}
      <div class="lb-name"><b>${esc(p.name)}</b><span><span class="dot ${online ? "dot-on" : ""}"></span>${esc(p.kelasLabel || "")}${isKicked ? " · dikeluarkan" : ""}</span></div>
      <span class="lb-score">${p.score || 0}</span>
      <div class="lb-actions">
        ${isKicked
          ? `<button class="btn btn-ghost btn-icon btn-sm" data-pact="restore" data-uid="${p.id}" title="Pulihkan">↺</button>`
          : `<button class="btn btn-ghost btn-icon btn-sm" data-pact="adjust" data-uid="${p.id}" title="Ubah poin manual">±</button>
             <button class="btn btn-ghost btn-icon btn-sm" data-pact="kick" data-uid="${p.id}" title="Keluarkan siswa">🚫</button>`}
      </div>
    </div>`;
  };
  $("#lbList").innerHTML = (list.length
    ? list.map(p => row(p)).join("")
    : `<p class="muted" style="text-align:center;font-size:.85rem">Belum ada siswa. Bagikan kode <b>${esc(code)}</b> 🙌</p>`)
    + (kicked.length ? `<div class="divider">dikeluarkan</div>${kicked.map(p => row(p, true)).join("")}` : "");
  if ($("#projModal").classList.contains("show")) renderProjector();
}

$("#lbList").addEventListener("click", async e => {
  const b = e.target.closest("[data-pact]");
  if (!b) return;
  const p = players.find(x => x.id === b.dataset.uid);
  if (!p) return;
  try {
    if (b.dataset.pact === "adjust") {
      const v = await promptDialog({
        title: `Ubah poin ${p.name}`, label: "Tambah / kurangi poin (cth. 5 atau -5)", type: "number",
        placeholder: "5", hint: `Poin saat ini: ${p.score || 0}`
      });
      if (v === null || v === "") return;
      const d = Math.round(Number(v));
      if (!Number.isFinite(d) || d === 0) return;
      await updateDoc(playerRef(p.id), { score: increment(d) });
      toast(`${p.name}: ${d > 0 ? "+" : ""}${d} poin`, "success");
    } else if (b.dataset.pact === "kick") {
      const ok = await confirmDialog({
        title: `Keluarkan ${p.name}?`, message: "Siswa ini tidak bisa lagi menjawab atau masuk ke room ini.",
        okText: "Keluarkan", danger: true
      });
      if (ok) await updateDoc(playerRef(p.id), { kicked: true });
    } else if (b.dataset.pact === "restore") {
      await updateDoc(playerRef(p.id), { kicked: false });
      toast(`${p.name} dipulihkan.`, "success");
    }
  } catch (err) { toast(friendlyError(err), "error"); }
});

// ---------- Proyektor ----------
let qrDone = false;
function renderProjector() {
  const list = rankPlayers(players);
  $("#projPodium").innerHTML = podiumHtml(list);
  $("#projList").innerHTML = list.slice(3, 10).map(p => `
    <div class="lb-item"><span class="lb-rank">${p.rank}</span>${avatarHtml(p.name)}
    <div class="lb-name"><b>${esc(p.name)}</b><span>${esc(p.kelasLabel || "")}</span></div>
    <span class="lb-score">${p.score || 0}</span></div>`).join("");
}
$("#projBtn").onclick = () => {
  const url = joinUrl(code);
  $("#projUrl").textContent = url;
  if (!qrDone && window.QRCode) {
    new window.QRCode($("#qrBox"), { text: url, width: 210, height: 210, correctLevel: window.QRCode.CorrectLevel.M });
    qrDone = true;
  }
  if (!window.QRCode) $("#qrBox").classList.add("hidden");
  renderProjector();
  $("#projModal").classList.add("show");
};
const closeProj = () => {
  $("#projModal").classList.remove("show");
  if (document.fullscreenElement) document.exitFullscreen();
};
$("#projClose").onclick = closeProj;
$("#projModal").addEventListener("mousedown", e => { if (e.target.id === "projModal") closeProj(); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && $("#projModal").classList.contains("show")) closeProj(); });
$("#fsBtn").onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else $("#projModal").requestFullscreen?.();
};
$("#copyLink").onclick = async () => {
  try { await navigator.clipboard.writeText(joinUrl(code)); toast("Link gabung disalin.", "success"); }
  catch { toast("Gagal menyalin link.", "error"); }
};

// ---------- Ticker: hitung mundur & tutup otomatis ----------
function tick() {
  const now = Date.now();
  let expired = false;
  $$("[data-deadline]").forEach(el => {
    const left = (Number(el.dataset.deadline) - now) / 1000;
    el.textContent = left > 0 ? fmtCountdown(left) : "Habis";
    if (left <= 0) expired = true;
  });
  $$("[data-bar-end]").forEach(el => {
    const end = Number(el.dataset.barEnd);
    el.style.width = barPct(Number(el.dataset.barStart), end) + "%";
    el.parentElement.classList.toggle("low", end - now < 10000);
  });
  for (const m of messages) {
    const dl = tsMillis(m.deadline);
    if (m.type === "question" && m.status === "open" && dl && dl <= now && !closing.has(m.id)) {
      closing.add(m.id);
      updateDoc(msgRef(m.id), { status: "closed", closedAt: serverTimestamp() })
        .then(() => toast(`⏰ Waktu habis — pertanyaan #${m.number} ditutup otomatis.`, "warning"))
        .catch(() => closing.delete(m.id));
    }
  }
  if (expired) renderFeed();
}
