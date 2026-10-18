import {
  auth, db, $, $$, esc, escMultiline, toast, initTheme, initFullscreen, initViewportHeight, friendlyError, configWarning, tsMillis, fmtClock,
  fmtCountdown, fmtTimer, avatarHtml, rankPlayers, beep, confirmDialog, promptDialog, deleteRoomDeep,
  joinUrl, setLoading, serverNow, syncClock, ONLINE_WINDOW, DEFAULT_SETTINGS, LETTERS
} from "./common.js";
import { listenBank, openBankEditor, saveBankItem, bankItemHtml, filterBank, optionEditor } from "./bank.js";
import {
  doc, collection, query, orderBy, onSnapshot, getDoc, updateDoc, writeBatch, serverTimestamp,
  increment, Timestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

initTheme();
initFullscreen();
initViewportHeight();
configWarning();

const code = new URLSearchParams(location.search).get("room");
if (!/^\d{4}$/.test(code || "")) location.replace("guru.html");

const roomRef = doc(db, "rooms", code);
const messagesCol = collection(db, "rooms", code, "messages");
const msgRef = id => doc(db, "rooms", code, "messages", id);
const ansRef = id => doc(db, "rooms", code, "answers", id);
const keyRef = id => doc(db, "rooms", code, "keys", id);
const playerRef = id => doc(db, "rooms", code, "players", id);

let me = null, room = null;
let messages = [], answers = [], players = [], bank = [];
let keys = {};        // qid → indeks kunci jawaban pilihan ganda (hanya guru)
let presence = {};    // pid → ms terakhir online
let msgKind = "text", pointsDirty = false, timerDirty = false, sending = false;
let firstFeed = true, ansReady = false;
const knownAnswers = new Set();
const closing = new Set();
const autoGrading = new Set();
const unsubs = [];
const feed = $("#feed");
const settings = () => ({ ...DEFAULT_SETTINGS, ...(room?.settings || {}) });
const mcEd = optionEditor($("#mcEditor"));

// ---------- Tab mobile ----------
$$("#mobileTabs button").forEach(b => b.onclick = () => {
  $$("#mobileTabs button").forEach(x => x.classList.toggle("active", x === b));
  $$(".tab-pane").forEach(p => p.classList.toggle("show", p.dataset.pane === b.dataset.tab));
});

// ---------- Buka/tutup sidebar (desktop) ----------
let side = { left: true, right: true };
try { side = { ...side, ...JSON.parse(localStorage.getItem("educhat_side") || "{}") }; } catch { /* abaikan */ }
function applySide() {
  $("#roomLayout").classList.toggle("hide-left", !side.left);
  $("#roomLayout").classList.toggle("hide-right", !side.right);
  for (const [id, on] of [["#toggleLeft", side.left], ["#toggleRight", side.right]]) {
    $(id).classList.toggle("on", on);
    $(id).setAttribute("aria-pressed", String(on));
  }
  try { localStorage.setItem("educhat_side", JSON.stringify(side)); } catch { /* abaikan */ }
}
$("#toggleLeft").onclick = () => { side.left = !side.left; applySide(); };
$("#toggleRight").onclick = () => { side.right = !side.right; applySide(); };
$$("[data-close-side]").forEach(b => b.onclick = () => { side[b.dataset.closeSide] = false; applySide(); });
applySide();

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
  const clockRef = doc(db, "teachers", me.uid);
  syncClock(clockRef, "clockPing");
  setInterval(() => syncClock(clockRef, "clockPing"), 10 * 60 * 1000);
  const err = e => toast(friendlyError(e), "error");

  unsubs.push(onSnapshot(roomRef, snap => {
    if (!snap.exists()) return fatal("🗑️", "Room dihapus", "Room ini sudah tidak ada.");
    room = { id: snap.id, ...snap.data() };
    renderHeader();
    renderSettings();
    renderFeed();
  }, err));

  unsubs.push(onSnapshot(query(messagesCol, orderBy("createdAt")), snap => {
    messages = snap.docs.map(d => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
    renderFeed();
    renderLiveStats();
  }, err));

  unsubs.push(onSnapshot(collection(db, "rooms", code, "keys"), snap => {
    keys = Object.fromEntries(snap.docs.map(d => [d.id, d.data().correct]));
    autoGrade();
    renderFeed();
  }, err));

  unsubs.push(onSnapshot(query(collection(db, "rooms", code, "answers"), orderBy("createdAt")), snap => {
    answers = snap.docs.map(d => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
    let fresh = false;
    for (const a of answers) {
      if (!knownAnswers.has(a.id)) { knownAnswers.add(a.id); if (ansReady) fresh = true; }
    }
    ansReady = true;
    if (fresh) beep("answer");
    autoGrade();
    renderFeed();
    renderLiveStats();
  }, err));

  unsubs.push(onSnapshot(collection(db, "rooms", code, "players"), snap => {
    players = snap.docs.map(d => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
    renderLeaderboard();
    renderLiveStats();
  }, err));

  // Tanda online siswa disimpan terpisah agar tidak memicu pembacaan di HP siswa lain
  unsubs.push(onSnapshot(collection(db, "rooms", code, "presence"), snap => {
    presence = Object.fromEntries(snap.docs.map(d => [d.id, tsMillis(d.data({ serverTimestamps: "estimate" }).lastSeen) || 0]));
    renderLeaderboard();
    renderLiveStats();
  }, err));

  unsubs.push(listenBank(me.uid, items => { bank = items; if ($("#bankModal").classList.contains("show")) renderBankModal(); }));

  setInterval(tick, 1000);
  setInterval(() => { renderLeaderboard(); renderLiveStats(); }, 15000);
}

const isOnline = p => serverNow() - Math.max(presence[p.id] || 0, tsMillis(p.lastSeen) || 0) < ONLINE_WINDOW;

/** Field untuk menutup pertanyaan (+ buka kunci jawaban PG agar siswa bisa melihatnya) */
function closeFields(m) {
  const f = { status: "closed", closedAt: serverTimestamp() };
  if (m.kind === "mc" && keys[m.id] !== undefined) f.reveal = keys[m.id];
  return f;
}
const openQuestions = (exceptId) => messages.filter(m => m.type === "question" && m.status === "open" && m.id !== exceptId);

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
    if (room.status !== "ended") openQuestions().forEach(m => batch.update(msgRef(m.id), closeFields(m)));
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
  const rows = [["Peringkat", "Nama", "Kelas", "No. Absen", "Poin", "Jawaban Benar", "Jawaban Salah", "Total Jawaban", "Bonus Tercepat", "Jumlah Pertanyaan"]];
  for (const p of list) {
    const mine = answers.filter(a => a.playerId === p.id);
    rows.push([p.rank, p.name, p.kelas || "", p.absen ?? "", p.score || 0,
      mine.filter(a => a.status === "correct").length, mine.filter(a => a.status === "wrong").length, mine.length,
      mine.reduce((n, a) => n + (a.bonus || 0), 0), qCount]);
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
const SHOW_HINT = {
  never: "💚 Paling hemat kuota Firebase: HP siswa hanya memuat jawabannya sendiri.",
  closed: "Jawaban teman muncul setelah pertanyaan ditutup. Lebih boros kuota.",
  always: "Jawaban teman langsung muncul (siswa bisa mencontek). Paling boros kuota."
};

function renderSettings() {
  const s = settings();
  $$("#sMode button").forEach(b => b.classList.toggle("active", b.dataset.v === s.answerMode));
  $("#modeHint").textContent = s.answerMode === "single"
    ? "Siswa hanya bisa mengirim 1 jawaban untuk setiap pertanyaan."
    : "Siswa boleh mengirim beberapa jawaban (soal pilihan ganda tetap 1×).";
  const setIfIdle = (id, v) => { const el = $(id); if (document.activeElement !== el) el.value = v; };
  setIfIdle("#sPoints", s.defaultPoints);
  setIfIdle("#sMax", s.maxFastest);
  setIfIdle("#sShow", s.showAnswers);
  setIfIdle("#sTimer", String(s.defaultTimer));
  setIfIdle("#sBonus1", s.bonus1);
  setIfIdle("#sBonus2", s.bonus2);
  setIfIdle("#sBonus3", s.bonus3);
  $("#showHint").textContent = SHOW_HINT[s.showAnswers] || "";
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
bindNumber("#sBonus1", "bonus1", "Bonus tercepat #1", 0, 100);
bindNumber("#sBonus2", "bonus2", "Bonus tercepat #2", 0, 100);
bindNumber("#sBonus3", "bonus3", "Bonus tercepat #3", 0, 100);
$("#sShow").onchange = e => saveSetting("showAnswers", e.target.value, "Visibilitas jawaban");
$("#sTimer").onchange = e => saveSetting("defaultTimer", Number(e.target.value), "Timer default");

// ---------- Komposer: isian / pilihan ganda / pengumuman ----------
function setKind(kind) {
  msgKind = kind;
  $$("#qType button").forEach(x => x.classList.toggle("active", x.dataset.v === kind));
  $$(".q-only").forEach(x => x.classList.toggle("hidden", kind === "info"));
  $("#mcEditor").classList.toggle("hidden", kind !== "mc");
  $("#qText").placeholder = kind === "info"
    ? "Tulis pengumuman untuk siswa…"
    : kind === "mc" ? "Tulis pertanyaan pilihan ganda… lalu isi opsi & tandai kunci jawaban di bawah"
    : "Tulis pertanyaan untuk siswa… (Enter untuk kirim, Shift+Enter baris baru)";
}
$$("#qType button").forEach(b => b.onclick = () => setKind(b.dataset.v));
$("#qPoints").addEventListener("input", () => { pointsDirty = true; });
$("#qTimer").addEventListener("change", () => { timerDirty = true; });
$("#qText").addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && msgKind !== "mc") { e.preventDefault(); sendFromComposer(); }
});
$("#sendBtn").onclick = sendFromComposer;

function readComposer() {
  const text = $("#qText").value.trim();
  if (!text) return { error: "Tulis pertanyaannya dulu." };
  const data = { kind: msgKind, text };
  if (msgKind === "info") return data;
  data.points = Math.round(Number($("#qPoints").value));
  if (!(data.points >= 1 && data.points <= 1000)) return { error: "Poin harus antara 1–1000." };
  data.timer = Number($("#qTimer").value) || 0;
  if (msgKind === "mc") {
    const o = mcEd.get();
    if (o.error) return { error: o.error };
    data.options = o.options;
    data.correct = o.correct;
  }
  return data;
}

async function sendFromComposer() {
  if (sending) return;
  const data = readComposer();
  if (data.error) return toast(data.error, "error");
  if (await sendQuestion(data)) {
    $("#qText").value = "";
    mcEd.reset();
    pointsDirty = false; timerDirty = false;
    renderSettings();
    $("#qText").focus();
  }
}

/** Kirim pertanyaan/pengumuman. data: {kind, text, points, timer, options, correct} */
async function sendQuestion(data) {
  if (room.status === "ended") { toast("Room sudah berakhir. Aktifkan kembali untuk mengirim pertanyaan.", "error"); return false; }
  const s = settings();
  const batch = writeBatch(db);
  const ref = doc(messagesCol);
  const base = { text: data.text, createdAt: serverTimestamp(), responders: [], answerCount: 0, deadline: null };
  if (data.kind === "info") {
    batch.set(ref, { ...base, type: "info", status: "closed" });
  } else {
    const t = data.timer || 0;
    openQuestions().forEach(m => batch.update(msgRef(m.id), closeFields(m)));
    const number = messages.reduce((n, m) => Math.max(n, m.number || 0), 0) + 1;
    batch.set(ref, {
      ...base, type: "question", kind: data.kind === "mc" ? "mc" : "text", number,
      points: data.points || s.defaultPoints, status: "open", timer: t,
      bonus: [s.bonus1 || 0, s.bonus2 || 0, s.bonus3 || 0],
      deadline: t ? Timestamp.fromMillis(serverNow() + t * 1000) : null,
      ...(data.kind === "mc" ? { options: data.options, reveal: null } : {})
    });
    if (data.kind === "mc") batch.set(keyRef(ref.id), { correct: data.correct });
  }
  sending = true;
  setLoading($("#sendBtn"), true);
  try {
    await batch.commit();
    firstFeed = true; // gulir ke bawah
    return true;
  } catch (e) {
    toast(friendlyError(e), "error");
    return false;
  } finally {
    sending = false;
    setLoading($("#sendBtn"), false);
  }
}

// ---------- Bank soal di dalam room ----------
$("#bankBtn").onclick = () => { renderBankModal(); $("#bankModal").classList.add("show"); setTimeout(() => $("#bankSearch").focus(), 50); };
const closeBank = () => $("#bankModal").classList.remove("show");
$("#bankClose").onclick = closeBank;
$("#bankModal").addEventListener("mousedown", e => { if (e.target.id === "bankModal") closeBank(); });
$("#bankSearch").addEventListener("input", renderBankModal);
$("#bankNew").onclick = () => openBankEditor(me.uid);

function renderBankModal() {
  const list = filterBank(bank, $("#bankSearch").value);
  $("#bankList").innerHTML = list.length ? list.map(it => bankItemHtml(it, `
      <button class="btn btn-primary btn-sm" data-bsend="${it.id}" title="Kirim sekarang ke siswa">➤ Kirim</button>
      <button class="btn btn-ghost btn-sm" data-buse="${it.id}" title="Salin ke kolom tulis untuk diedit">✏️ Edit dulu</button>`)).join("")
    : `<div class="empty"><div class="big">📚</div><b>${bank.length ? "Tidak ada soal yang cocok" : "Bank soal masih kosong"}</b>
       <p>Tambahkan soal lewat tombol “Soal baru” atau tombol 💾 di kolom tulis.</p></div>`;
}

$("#bankList").addEventListener("click", async e => {
  const send = e.target.closest("[data-bsend]"), use = e.target.closest("[data-buse]");
  const it = bank.find(x => x.id === (send || use)?.dataset[send ? "bsend" : "buse"]);
  if (!it) return;
  if (send) {
    send.disabled = true;
    const ok = await sendQuestion({
      kind: it.kind, text: it.text, points: it.points || settings().defaultPoints,
      timer: it.timer ?? settings().defaultTimer, options: it.options, correct: it.correct
    });
    send.disabled = false;
    if (ok) { closeBank(); toast("Soal dari bank terkirim.", "success"); }
  } else {
    setKind(it.kind === "mc" ? "mc" : "text");
    $("#qText").value = it.text;
    if (it.kind === "mc") mcEd.set(it.options, it.correct);
    if (it.points) { $("#qPoints").value = it.points; pointsDirty = true; }
    $("#qTimer").value = String(it.timer || 0); timerDirty = true;
    closeBank();
    $("#qText").focus();
  }
});

$("#saveBankBtn").onclick = async () => {
  const data = readComposer();
  if (data.error) return toast(data.error, "error");
  try {
    await saveBankItem(me.uid, null, { ...data, tag: room?.name || "" });
    toast("Soal disimpan ke bank soal.", "success");
  } catch (e) { toast(friendlyError(e), "error"); }
};

// ---------- Penilaian & bonus tercepat ----------
let gradeQueue = Promise.resolve();
/**
 * Terapkan perubahan status lalu hitung ulang poin + bonus seluruh jawaban
 * pada satu pertanyaan. Bonus diberikan ke penjawab BENAR tercepat (#1–#3).
 */
function applyGrades(qid, changes = {}, qOverride = {}) {
  gradeQueue = gradeQueue.then(async () => {
    const q = { ...messages.find(m => m.id === qid), ...qOverride };
    if (!q.id) return;
    const bonuses = q.bonus || [0, 0, 0];
    const list = answers.filter(a => a.questionId === qid)
      .sort((a, b) => (tsMillis(a.createdAt) || 0) - (tsMillis(b.createdAt) || 0));
    const rewarded = new Set();
    const batch = writeBatch(db);
    const deltas = {};
    let writes = 0;
    for (const a of list) {
      const status = changes[a.id] ?? a.status;
      let points = 0, bonus = 0;
      if (status === "correct") {
        if (!rewarded.has(a.playerId)) { bonus = bonuses[rewarded.size] || 0; rewarded.add(a.playerId); }
        points = (q.points || 0) + bonus;
      }
      if (status !== a.status || points !== (a.points || 0) || bonus !== (a.bonus || 0)) {
        batch.update(ansRef(a.id), { status, points, bonus, gradedAt: serverTimestamp() });
        const d = points - (a.points || 0);
        if (d) deltas[a.playerId] = (deltas[a.playerId] || 0) + d;
        writes++;
      }
    }
    for (const [pid, d] of Object.entries(deltas)) if (d) batch.update(playerRef(pid), { score: increment(d) });
    if (writes) await batch.commit();
  }).catch(e => toast(friendlyError(e), "error"));
  return gradeQueue;
}

/** Nilai otomatis jawaban pilihan ganda yang masih menunggu */
function autoGrade() {
  const byQ = {};
  for (const a of answers) {
    if (a.status !== "pending" || autoGrading.has(a.id)) continue;
    const q = messages.find(m => m.id === a.questionId);
    if (q?.kind !== "mc" || keys[q.id] === undefined) continue;
    autoGrading.add(a.id);
    (byQ[q.id] ||= {})[a.id] = a.choice === keys[q.id] ? "correct" : "wrong";
  }
  for (const [qid, changes] of Object.entries(byQ)) {
    applyGrades(qid, changes).finally(() => Object.keys(changes).forEach(id => autoGrading.delete(id)));
  }
}

// ---------- Feed guru ----------
function renderLiveStats() {
  const active = players.filter(p => !p.kicked);
  const online = active.filter(isOnline).length;
  const qn = messages.filter(m => m.type === "question").length;
  $("#liveStats").innerHTML = `
    <span class="badge badge-success"><span class="dot dot-on"></span>${online}/${active.length} online</span>
    <span class="badge hide-sm">❓ ${qn} pertanyaan</span>`;
  $("#onlineCount").textContent = `${online} online · ${active.length} siswa`;
}

function mcSummary(m, list) {
  const key = keys[m.id];
  const counts = (m.options || []).map((_, i) => list.filter(a => a.choice === i).length);
  const max = Math.max(1, ...counts);
  return `<div class="mc-stats">${(m.options || []).map((o, i) => `
    <div class="mc-stat ${i === key ? "key" : ""}">
      <span class="mc-l">${LETTERS[i]}</span>
      <span class="mc-o">${esc(o)}${i === key ? " ✓" : ""}</span>
      <span class="mc-bar"><i style="width:${(counts[i] / max) * 100}%"></i></span>
      <b>${counts[i]}</b>
    </div>`).join("")}</div>`;
}

function questionCard(m, list) {
  const s = settings();
  const now = serverNow();
  const dl = tsMillis(m.deadline), startMs = tsMillis(m.createdAt);
  const running = m.status === "open" && dl && dl > now;
  const correct = list.filter(a => a.status === "correct").length;
  const pending = list.filter(a => a.status === "pending").length;
  const resp = (m.responders || []).length;
  const bonus = (m.bonus || []).filter(Boolean);
  const correctPids = new Set();

  const ans = list.map((a, i) => {
    const secs = startMs && tsMillis(a.createdAt) ? ((tsMillis(a.createdAt) - startMs) / 1000).toFixed(1) : "-";
    const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`;
    const already = a.status !== "correct" && correctPids.has(a.playerId);
    if (a.status === "correct") correctPids.add(a.playerId);
    return `<div class="ans ${a.status}" data-ans="${a.id}" title="Klik untuk menandai benar/salah">
      <span class="ans-rank">${medal}</span>
      ${avatarHtml(a.name)}
      <div class="ans-main">
        <div class="ans-who">${esc(a.name)} <small>${esc(a.kelasLabel || "")} · +${secs} dtk</small>
          ${a.status === "correct" ? `<span class="badge badge-success">+${a.points}${a.bonus ? ` (⚡+${a.bonus})` : ""}</span>` : ""}
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
        <span class="badge ${m.kind === "mc" ? "badge-accent" : ""}">${m.kind === "mc" ? "🔘 PG · otomatis" : "✍️ Isian"}</span>
        <span class="badge badge-primary">+${m.points} poin</span>
        ${bonus.length ? `<span class="badge badge-warning" title="Bonus penjawab benar tercepat">⚡ ${m.bonus.join("/")}</span>` : ""}
        ${status}
        ${running ? `<span class="badge badge-accent">⏱ <b data-deadline="${dl}">${fmtCountdown((dl - now) / 1000)}</b></span>` : ""}
        <div class="qcard-actions">
          ${m.status === "open"
            ? `<button class="btn btn-ghost btn-sm" data-act="close" data-id="${m.id}">⏹ Tutup</button>`
            : `<button class="btn btn-ghost btn-sm" data-act="reopen" data-id="${m.id}">▶ Buka lagi</button>`}
          <button class="btn btn-ghost btn-icon btn-sm" data-act="edit-points" data-id="${m.id}" title="Ubah poin">⭐</button>
          <button class="btn btn-ghost btn-icon btn-sm" data-act="to-bank" data-id="${m.id}" title="Simpan ke bank soal">💾</button>
          <button class="btn btn-ghost btn-icon btn-sm" data-act="delete" data-id="${m.id}" title="Hapus pertanyaan">🗑</button>
        </div>
      </div>
      <div class="q-text">${escMultiline(m.text)}</div>
      ${m.kind === "mc" ? mcSummary(m, list) : ""}
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
  return Math.max(0, Math.min(100, ((end - serverNow()) / (end - start)) * 100));
}

function renderFeed() {
  if (!room) return;
  const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 200;
  if (!messages.length) {
    feed.innerHTML = `<div class="feed-empty">
      <div class="big">🎯</div>
      <b>Room siap dimainkan!</b>
      <p>Tampilkan kode <b>${esc(code)}</b> ke siswa melalui <b>Layar Proyektor</b>, lalu kirim pertanyaan pertama — atau ambil dari <b>📚 Bank Soal</b>.</p>
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
  await applyGrades(a.questionId, { [a.id]: newStatus });
  if (newStatus === "correct") beep("correct");
}

async function questionAction(act, id) {
  const m = messages.find(x => x.id === id);
  if (!m) return;
  try {
    if (act === "close") {
      await updateDoc(msgRef(id), closeFields(m));
    } else if (act === "reopen") {
      const batch = writeBatch(db);
      openQuestions(id).forEach(x => batch.update(msgRef(x.id), closeFields(x)));
      const dl = tsMillis(m.deadline);
      batch.update(msgRef(id), {
        status: "open",
        ...(m.kind === "mc" ? { reveal: null } : {}),
        ...(dl && dl <= serverNow() ? { deadline: null } : {})
      });
      await batch.commit();
      closing.delete(id);
      toast(`Pertanyaan #${m.number} dibuka kembali.`, "success");
    } else if (act === "edit-points") {
      const v = await promptDialog({
        title: `Poin pertanyaan #${m.number}`, label: "Poin untuk jawaban benar", type: "number",
        value: String(m.points), hint: "Jawaban yang sudah dinilai benar akan disesuaikan otomatis."
      });
      if (v === null) return;
      const pts = Math.round(Number(v));
      if (!(pts >= 1 && pts <= 1000)) return toast("Poin harus antara 1–1000.", "error");
      await updateDoc(msgRef(id), { points: pts });
      await applyGrades(id, {}, { points: pts });
      toast("Poin diperbarui.", "success");
    } else if (act === "to-bank") {
      await saveBankItem(me.uid, null, {
        kind: m.kind, text: m.text, points: m.points, timer: m.timer || 0,
        options: m.options, correct: keys[m.id] ?? null, tag: room?.name || ""
      });
      toast("Disimpan ke bank soal.", "success");
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
        if (a.points) scoreBack[a.playerId] = (scoreBack[a.playerId] || 0) + a.points;
      }
      for (const [pid, pts] of Object.entries(scoreBack)) ops.push(b => b.update(playerRef(pid), { score: increment(-pts) }));
      if (m.kind === "mc") ops.push(b => b.delete(keyRef(id)));
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
  const row = (p, isKicked = false) => {
    const online = !isKicked && isOnline(p);
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
document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  if ($("#projModal").classList.contains("show")) closeProj();
  if ($("#bankModal").classList.contains("show")) closeBank();
});
$("#fsBtn").onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else $("#projModal").requestFullscreen?.();
};
$("#copyLink").onclick = async () => {
  try { await navigator.clipboard.writeText(joinUrl(code)); toast("Link gabung disalin.", "success"); }
  catch { toast("Gagal menyalin link.", "error"); }
};

// ---------- Ticker: hitung mundur & tutup otomatis (memakai jam server) ----------
function tick() {
  const now = serverNow();
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
      updateDoc(msgRef(m.id), closeFields(m))
        .then(() => toast(`⏰ Waktu habis — pertanyaan #${m.number} ditutup otomatis.`, "warning"))
        .catch(() => closing.delete(m.id));
    }
  }
  if (expired) renderFeed();
}
