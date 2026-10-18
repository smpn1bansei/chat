import {
  auth, db, $, $$, esc, escMultiline, toast, initTheme, initFullscreen, initViewportHeight, friendlyError, configWarning, tsMillis,
  fmtClock, fmtCountdown, avatarHtml, rankPlayers, beep, celebrate, confirmDialog, AppError, DEFAULT_SETTINGS,
  serverNow, syncClock, HEARTBEAT_MS, LETTERS
} from "./common.js";
import {
  doc, collection, query, orderBy, where, onSnapshot, runTransaction, setDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

initTheme();
initFullscreen();
initViewportHeight(() => {
  // keyboard muncul → pastikan chat terbaru & kolom jawaban tetap terlihat
  const f = document.getElementById("feed");
  if (document.activeElement?.id === "answerInput" && f) f.scrollTop = f.scrollHeight;
});
configWarning();

const code = new URLSearchParams(location.search).get("room");
if (!/^\d{4}$/.test(code || "")) location.replace("index.html");

const roomRef = doc(db, "rooms", code);
const answersCol = collection(db, "rooms", code, "answers");

let uid = null;   // akun perangkat (Firebase Anonymous)
let pid = null;   // ID siswa di room = kelas + no. absen
let room = null, player = null;
let messages = [], answers = [], players = [];
let sending = false, firstFeedRender = true;
let soundOn = localStorage.getItem("educhat_sound") !== "off";
let endedShown = false;
const seenQuestions = new Set();
const myStatuses = new Map();
let msgsReady = false, ansReady = false;
const unsubs = [];
let unsubAnswers = null, answersScope = null;

const feed = $("#feed");
const input = $("#answerInput");
const sendBtn = $("#sendBtn");
const settings = () => ({ ...DEFAULT_SETTINGS, ...(room?.settings || {}) });
const play = kind => { if (soundOn) beep(kind); };

// ---------- Tombol topbar ----------
const syncSoundBtn = () => { $("#soundBtn").textContent = soundOn ? "🔔" : "🔕"; };
syncSoundBtn();
$("#soundBtn").onclick = () => {
  soundOn = !soundOn;
  localStorage.setItem("educhat_sound", soundOn ? "on" : "off");
  syncSoundBtn();
  toast(soundOn ? "Suara dinyalakan" : "Suara dimatikan");
};
$("#leaveBtn").onclick = async () => {
  if (await confirmDialog({ title: "Keluar dari room?", message: "Poinmu tetap tersimpan. Kamu bisa masuk lagi dengan kode yang sama.", okText: "Keluar" })) {
    location.href = "index.html";
  }
};

// ---------- Tab mobile ----------
function showTab(name) {
  $$("#mobileTabs button").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab-pane").forEach(p => p.classList.toggle("show", p.dataset.pane === name));
  if (name === "chat") { $("#mobileTabs .ping").classList.add("hidden"); feed.scrollTop = feed.scrollHeight; }
}
$$("#mobileTabs button").forEach(b => b.onclick = () => showTab(b.dataset.tab));

// ---------- Mulai ----------
await auth.authStateReady();
if (!auth.currentUser) {
  location.replace(`index.html?room=${code}`);
} else {
  uid = auth.currentUser.uid;
  pid = new URLSearchParams(location.search).get("p") || localStorage.getItem(`educhat_pid_${code}`);
  if (!pid) location.replace(`index.html?room=${code}`);
  else {
    try { localStorage.setItem(`educhat_pid_${code}`, pid); } catch { /* abaikan */ }
    start();
  }
}

function fatal(icon, title, msg) {
  unsubs.forEach(u => u());
  unsubAnswers?.();
  $("#loading").innerHTML = `
    <div class="card">
      <div class="big">${icon}</div>
      <h2 style="margin-bottom:6px">${esc(title)}</h2>
      <p class="muted">${esc(msg)}</p>
      <a class="btn btn-primary btn-block" href="index.html?room=${code}">Kembali ke halaman awal</a>
    </div>`;
  $("#loading").classList.remove("hidden");
}

function onErr(e) {
  if (e.code === "permission-denied") fatal("🔒", "Akses ditolak", "Kamu tidak memiliki akses ke room ini.");
  else toast(friendlyError(e), "error");
}

function start() {
  $("#roomCode").textContent = code;

  unsubs.push(onSnapshot(roomRef, snap => {
    if (!snap.exists()) return fatal("🗑️", "Room tidak tersedia", "Room ini telah dihapus oleh guru.");
    room = { id: snap.id, ...snap.data() };
    $("#loading").classList.add("hidden");
    subscribeAnswers();
    renderHeader();
    renderFeed();
    renderComposer();
    if (room.status === "ended" && !endedShown && player) showFinal();
  }, onErr));

  unsubs.push(onSnapshot(doc(db, "rooms", code, "players", pid), snap => {
    if (!snap.exists()) { location.replace(`index.html?room=${code}`); return; }
    const prevScore = player?.score;
    player = snap.data();
    if (player.kicked) return fatal("🚫", "Kamu dikeluarkan", "Guru telah mengeluarkanmu dari room ini.");
    if (player.uid !== uid) {
      return fatal("📱", "Akunmu dibuka di perangkat lain",
        `${player.name} (${player.kelasLabel || ""}) baru saja masuk dari perangkat lain. Untuk melanjutkan di sini, masuk lagi dengan nama, kelas, dan no. absen yang sama.`);
    }
    $("#meName").textContent = player.name;
    $("#meKelas").textContent = player.kelasLabel || "";
    const chip = $("#myScore");
    chip.querySelector("span").textContent = player.score || 0;
    if (prevScore !== undefined && prevScore !== player.score) {
      chip.classList.remove("bump"); void chip.offsetWidth; chip.classList.add("bump");
    }
    renderLeaderboard();
    if (room?.status === "ended" && !endedShown) showFinal();
  }, onErr));

  unsubs.push(onSnapshot(query(collection(db, "rooms", code, "messages"), orderBy("createdAt")), snap => {
    messages = snap.docs.map(d => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
    for (const m of messages) {
      if (seenQuestions.has(m.id)) continue;
      seenQuestions.add(m.id);
      if (!msgsReady) continue;
      if (m.type === "question") {
        play("question");
        toast(`Pertanyaan #${m.number || ""} dari guru! Ayo jawab cepat ⚡`, "info");
        if (!$('[data-pane="chat"]').classList.contains("show")) $("#mobileTabs .ping").classList.remove("hidden");
        setTimeout(() => input.focus(), 50);
      } else if (m.type === "info") {
        play("info");
      }
    }
    msgsReady = true;
    renderFeed();
    renderComposer();
  }, onErr));

  unsubs.push(onSnapshot(collection(db, "rooms", code, "players"), snap => {
    players = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderLeaderboard();
  }, onErr));

  // Tanda online disimpan di koleksi terpisah (hanya dibaca guru) -> hemat kuota.
  // Penulisan pertama sekaligus menyamakan jam HP dengan jam server.
  const presRef = doc(db, "rooms", code, "presence", pid);
  syncClock(presRef, "lastSeen");
  setInterval(() => {
    if (!settings().trackOnline) return; // tanda online dimatikan guru → tidak ada penulisan
    if (document.visibilityState === "visible" && player && !player.kicked && player.uid === uid) {
      setDoc(presRef, { lastSeen: serverTimestamp() }).catch(() => {});
    }
  }, HEARTBEAT_MS);
  setInterval(() => syncClock(presRef, "lastSeen"), 10 * 60 * 1000);

  setInterval(tick, 1000);
}

/**
 * "Tidak terlihat" -> HP siswa hanya memuat jawabannya sendiri (paling hemat kuota).
 * Mode lain -> memuat semua jawaban di room.
 */
function subscribeAnswers() {
  const scope = settings().showAnswers === "never" ? "mine" : "all";
  if (scope === answersScope) return;
  answersScope = scope;
  unsubAnswers?.();
  const q = scope === "mine" ? query(answersCol, where("playerId", "==", pid)) : query(answersCol, orderBy("createdAt"));
  unsubAnswers = onSnapshot(q, snap => {
    answers = snap.docs.map(d => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }))
      .sort((a, b) => (tsMillis(a.createdAt) || 0) - (tsMillis(b.createdAt) || 0));
    for (const a of answers) {
      if (a.playerId !== pid) continue;
      const prev = myStatuses.get(a.id);
      myStatuses.set(a.id, a.status);
      if (!ansReady || prev === undefined || prev === a.status) continue;
      if (a.status === "correct") {
        play("correct"); celebrate();
        toast(`Jawabanmu BENAR! +${a.points} poin${a.bonus ? ` (termasuk ⚡ bonus tercepat +${a.bonus})` : ""} 🎉`, "success", 4500);
      } else if (a.status === "wrong") {
        play("wrong");
        toast("Jawabanmu belum tepat. Tetap semangat! 💪", "error");
      }
    }
    ansReady = true;
    renderFeed();
    renderComposer();
  }, onErr);
}

// ---------- Header ----------
function renderHeader() {
  $("#roomName").textContent = room.name || `Room ${code}`;
  $("#roomOwner").textContent = `👩‍🏫 ${room.ownerName || "Guru"}`;
  document.title = `${room.name || "Room " + code} — Educhat`;
  const s = settings();
  const st = {
    open: `<span class="badge badge-success">● Aktif</span>`,
    locked: `<span class="badge badge-warning">🔒 Dikunci</span>`,
    ended: `<span class="badge badge-danger">⏹ Berakhir</span>`
  }[room.status] || "";
  $("#roomStatus").innerHTML = `${st}
    <span class="badge hide-sm">${s.answerMode === "single" ? "1× jawab" : "Jawab berkali-kali"}</span>
    ${s.maxFastest > 0 ? `<span class="badge badge-accent hide-sm">⚡ ${s.maxFastest} tercepat</span>` : ""}
    ${s.bonus1 > 0 ? `<span class="badge badge-warning hide-sm" title="Bonus untuk penjawab benar tercepat">🥇 +${s.bonus1} bonus</span>` : ""}`;
}

// ---------- Feed ----------
function activeQuestion() {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type === "question" && messages[i].status === "open") return messages[i];
  }
  return null;
}

function statusBadge(m) {
  if (m.status === "open") {
    const dl = tsMillis(m.deadline);
    if (dl && dl <= serverNow()) return `<span class="badge badge-warning">⏰ Waktu habis</span>`;
    return `<span class="badge badge-success">● Dibuka</span>`;
  }
  return `<span class="badge">Ditutup</span>`;
}

function answerBubble(a) {
  const mine = a.playerId === pid;
  const st = a.status === "correct" ? `✓ Benar +${a.points}` : a.status === "wrong" ? "✗ Salah" : "⏳ Menunggu penilaian";
  const cls = a.status === "correct" ? "correct" : a.status === "wrong" ? "wrong" : "";
  if (mine) {
    return `<div class="msg msg-me"><div class="bubble ${cls}">
      ${escMultiline(a.text)}
      <div class="meta"><span>${fmtClock(tsMillis(a.createdAt))}</span><b>${st}</b></div>
    </div></div>`;
  }
  return `<div class="msg msg-other">${avatarHtml(a.name)}<div class="bubble ${cls}">
      <div class="who">${esc(a.name)} <small>· ${esc(a.kelasLabel || "")}</small></div>
      ${escMultiline(a.text)}
      <div class="meta"><span>${fmtClock(tsMillis(a.createdAt))}</span>${a.status !== "pending" ? `<b>${st}</b>` : ""}</div>
    </div></div>`;
}

function questionBubble(m) {
  const s = settings();
  const active = activeQuestion()?.id === m.id;
  const dl = tsMillis(m.deadline), startMs = tsMillis(m.createdAt);
  const now = serverNow();
  const running = dl && m.status === "open" && dl > now;
  const timer = running ? `
      <span>⏱ <b data-deadline="${dl}">${fmtCountdown((dl - now) / 1000)}</b></span>` : "";
  const bar = running ? `
      <div class="timebar"><i data-bar-start="${startMs}" data-bar-end="${dl}" style="width:${barPct(startMs, dl)}%"></i></div>` : "";
  const slots = m.status === "open" && s.maxFastest > 0 ? `<span>⚡ ${s.maxFastest} penjawab tercepat</span>` : "";
  return `<div class="msg msg-other">
    <span class="avatar avatar-teacher">👩‍🏫</span>
    <div class="bubble q-bubble ${active ? "active" : ""}">
      <div class="q-head">
        <span class="q-num">PERTANYAAN #${m.number || ""}</span>
        ${m.kind === "mc" ? `<span class="badge badge-accent">🔘 Pilihan ganda</span>` : ""}
        <span class="badge badge-primary">+${m.points} poin</span>
        ${statusBadge(m)}
      </div>
      <div class="q-text">${esc(m.text)}</div>
      ${m.kind === "mc" ? mcOptionsHtml(m) : ""}
      ${bar}
      <div class="q-foot">${timer}${slots}<span>${fmtClock(startMs)}</span></div>
    </div>
  </div>`;
}

/** Daftar opsi PG di gelembung soal: tandai pilihanku & kunci (setelah ditutup) */
function mcOptionsHtml(m) {
  const mine = answers.find(a => a.questionId === m.id && a.playerId === pid);
  const reveal = m.status !== "open" && Number.isInteger(m.reveal) ? m.reveal : null;
  return `<div class="q-opts">${(m.options || []).map((o, i) => {
    const cls = [mine?.choice === i ? "picked" : "", reveal === i ? "key" : "",
      reveal !== null && mine?.choice === i && reveal !== i ? "miss" : ""].join(" ");
    const tag = reveal === i ? "<em>✓ kunci</em>" : mine?.choice === i ? "<em>pilihanmu</em>" : "";
    return `<div class="q-opt ${cls}"><b>${LETTERS[i]}</b><span>${esc(o)}</span>${tag}</div>`;
  }).join("")}</div>`;
}

function barPct(start, end) {
  return Math.max(0, Math.min(100, ((end - serverNow()) / (end - start)) * 100));
}

function renderFeed() {
  if (!room || !msgsReady) return;
  const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 160;
  const s = settings();
  const byQ = {};
  for (const a of answers) (byQ[a.questionId] ||= []).push(a);

  if (!messages.length) {
    feed.innerHTML = `<div class="feed-empty">
      <div class="big">💭</div>
      <b>Halo, ${esc(player?.name || "")}!</b>
      <p>Kamu sudah masuk room. Tunggu guru mengirim pertanyaan pertama, lalu jawab secepat mungkin!</p>
    </div>`;
    return;
  }

  let html = `<div class="sys-note">👋 Kamu bergabung sebagai <b>${esc(player?.name || "")}</b> · ${esc(player?.kelasLabel || "")}</div>`;
  for (const m of messages) {
    if (m.type === "info") {
      html += `<div class="info-msg"><b>📢 Pengumuman:</b> ${escMultiline(m.text)}</div>`;
      continue;
    }
    if (m.type !== "question") continue;
    html += questionBubble(m);
    const list = byQ[m.id] || [];
    if (s.showAnswers === "never") {
      for (const a of list) if (a.playerId === pid) html += answerBubble(a);
      continue;
    }
    const showOthers = s.showAnswers === "always" || m.status !== "open";
    let hidden = 0;
    for (const a of list) {
      if (a.playerId === pid || showOthers) html += answerBubble(a);
      else hidden++;
    }
    if (hidden) html += `<div class="hidden-note">🙈 ${hidden} jawaban teman disembunyikan sampai pertanyaan ditutup</div>`;
  }
  if (room.status === "ended") html += `<div class="info-msg"><b>🏁 Permainan selesai.</b> Terima kasih sudah berpartisipasi!</div>`;
  feed.innerHTML = html;
  if (nearBottom || firstFeedRender) feed.scrollTop = feed.scrollHeight;
  firstFeedRender = false;
}

// ---------- Composer ----------
function composerState() {
  if (!room || !player) return { ok: false, msg: "Memuat…" };
  if (room.status === "ended") return { ok: false, msg: "🏁 Room telah berakhir. Terima kasih sudah bermain!" };
  const q = activeQuestion();
  if (!q) return { ok: false, msg: "⏳ Menunggu pertanyaan dari guru…" };
  const s = settings();
  const mc = q.kind === "mc";
  const dl = tsMillis(q.deadline);
  if (dl && dl <= serverNow()) return { ok: false, q, msg: "⏰ Waktu menjawab sudah habis." };
  // sudah menjawab? → dilihat dari jawaban sendiri (data slot tidak dipantau siswa)
  const inR = answers.some(a => a.questionId === q.id && a.playerId === pid);
  if ((s.answerMode === "single" || mc) && inR) {
    return { ok: false, q, msg: mc ? "✅ Pilihanmu sudah terkirim & dinilai otomatis." : "✅ Jawabanmu sudah terkirim. Tunggu penilaian guru." };
  }
  // Slot penuh tidak dipantau siswa: guru menutup pertanyaan otomatis saat penuh,
  // dan transaksi menolak jawaban yang terlambat.
  const left = s.maxFastest > 0 && !inR ? ` · hanya ${s.maxFastest} tercepat!` : "";
  return {
    ok: true, q, mc,
    msg: (mc ? "👇 Ketuk satu pilihan jawaban (hanya 1 kali)" :
      s.answerMode === "single" ? "✍️ Kamu hanya bisa menjawab 1 kali" : "✍️ Kamu boleh menjawab berkali-kali") + left
  };
}

let lastHint = "";
let lastChoicesKey = "";
function renderComposer() {
  const st = composerState();
  // pilihan ganda: tampilkan tombol opsi besar, sembunyikan kolom ketik
  const showMc = !!(st.ok && st.mc);
  $("#answerForm").classList.toggle("hidden", showMc);
  const box = $("#mcChoices");
  box.classList.toggle("hidden", !showMc);
  const ck = showMc ? `${st.q.id}|${sending}` : "";
  if (ck !== lastChoicesKey) {
    lastChoicesKey = ck;
    box.innerHTML = showMc ? (st.q.options || []).map((o, i) =>
      `<button type="button" class="mc-choice" data-choice="${i}" ${sending ? "disabled" : ""}><b>${LETTERS[i]}</b><span>${esc(o)}</span></button>`).join("") : "";
  }
  input.disabled = !st.ok || sending || showMc;
  sendBtn.disabled = !st.ok || sending || !input.value.trim();
  $("#composer").classList.toggle("locked", !st.ok);
  if (st.msg !== lastHint) {
    $("#composerHint").textContent = st.msg;
    $("#composerHint").classList.toggle("warn", !st.ok && !!st.q);
    lastHint = st.msg;
  }
  const rt = $("#replyTo");
  if (st.q && st.ok) {
    rt.textContent = `↪ Menjawab #${st.q.number || ""}: ${st.q.text}`;
    rt.classList.remove("hidden");
  } else rt.classList.add("hidden");
  input.placeholder = st.ok ? "Ketik jawabanmu… (Enter untuk kirim)" : "Belum bisa menjawab";
}

$("#mcChoices").addEventListener("click", async e => {
  const b = e.target.closest("[data-choice]");
  if (!b) return;
  const st = composerState();
  if (!st.ok || !st.mc) return;
  const i = Number(b.dataset.choice);
  const ok = await confirmDialog({
    title: `Kirim jawaban ${LETTERS[i]}?`,
    message: `<b>${LETTERS[i]}. ${esc(st.q.options[i])}</b><br>Jawaban pilihan ganda tidak bisa diubah setelah dikirim.`,
    okText: "Kirim", cancelText: "Ganti pilihan"
  });
  if (ok) sendAnswer({ choice: i });
});

function autosize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 140) + "px";
}
input.addEventListener("input", () => { autosize(); sendBtn.disabled = input.disabled || !input.value.trim(); });
input.addEventListener("blur", () => document.body.classList.remove("typing"));
input.addEventListener("focus", () => setTimeout(() => {
  document.body.classList.add("typing");
  feed.scrollTop = feed.scrollHeight;
  $("#composer").scrollIntoView({ block: "end" });
}, 300));
input.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendAnswer(); }
});
$("#answerForm").addEventListener("submit", e => { e.preventDefault(); sendAnswer(); });

async function sendAnswer({ choice = null } = {}) {
  if (sending) return;
  const st = composerState();
  if (!st.ok) return toast(st.msg, "error");
  const q = st.q;
  const isMc = q.kind === "mc";
  if (isMc && choice === null) return;
  const text = isMc ? `${LETTERS[choice]}. ${q.options[choice]}` : input.value.trim();
  if (!text) return;
  sending = true;
  renderComposer();
  try {
    await runTransaction(db, async tx => {
      const qRef = doc(db, "rooms", code, "messages", q.id);
      const sRef = doc(db, "rooms", code, "slots", q.id);
      const rs = await tx.get(roomRef);
      const qs = await tx.get(qRef);
      const ss = await tx.get(sRef);
      if (!rs.exists()) throw new AppError("Room sudah dihapus.");
      if (!qs.exists()) throw new AppError("Pertanyaan sudah dihapus guru.");
      const r = rs.data(), qd = qs.data();
      const s = { ...DEFAULT_SETTINGS, ...(r.settings || {}) };
      if (r.status === "ended") throw new AppError("Room sudah berakhir.");
      if (qd.status !== "open") throw new AppError("Pertanyaan sudah ditutup guru.");
      if (qd.deadline && tsMillis(qd.deadline) <= serverNow()) throw new AppError("Waktu menjawab sudah habis.");
      const sd = ss.exists() ? ss.data() : { responders: [], answerCount: 0 };
      const resp = sd.responders || [];
      const inR = resp.includes(pid);
      const single = s.answerMode === "single" || qd.kind === "mc";
      if (single && inR) throw new AppError("Kamu sudah menjawab pertanyaan ini.");
      if (!inR && s.maxFastest > 0 && resp.length >= s.maxFastest) throw new AppError("Yah, slot jawaban sudah penuh! Lebih cepat lagi ya ⚡");

      const aRef = single ? doc(answersCol, `${q.id}_${pid}`) : doc(answersCol);
      tx.set(sRef, { responders: inR ? resp : [...resp, pid], answerCount: (sd.answerCount || 0) + 1, lastResponder: pid });
      tx.set(aRef, {
        questionId: q.id, playerId: pid, uid, name: player.name, kelasLabel: player.kelasLabel || "",
        text, status: "pending", points: 0, createdAt: serverTimestamp(),
        ...(isMc ? { choice } : {})
      });
    });
    if (!isMc) { input.value = ""; autosize(); }
    play("answer");
  } catch (e) {
    toast(friendlyError(e), "error", 4000);
  } finally {
    sending = false;
    renderComposer();
    if (!input.disabled) input.focus();
  }
}

// ---------- Papan skor ----------
function renderLeaderboard() {
  const list = rankPlayers(players);
  $("#playerCount").textContent = `${list.length} siswa`;

  const me = list.find(p => p.id === pid);
  $("#myRank").innerHTML = me ? `
    <div><div class="muted" style="font-size:.8rem;font-weight:700">Peringkatmu</div><div class="r">#${me.rank} <small class="muted" style="font-size:.85rem">dari ${list.length}</small></div></div>
    <div style="text-align:right"><div class="muted" style="font-size:.8rem;font-weight:700">Poin</div><div class="r">${me.score || 0}</div></div>` : "";

  const pod = [list[1], list[0], list[2]];
  const cls = ["p2", "p1", "p3"], nums = [2, 1, 3];
  $("#podium").innerHTML = pod.map((p, i) => p ? `
    <div class="pod ${cls[i]}">
      ${avatarHtml(p.name)}
      <div class="nm" title="${esc(p.name)}">${esc(p.name)}${p.id === pid ? " (kamu)" : ""}</div>
      <div class="pts">${p.score || 0} poin</div>
      <div class="block">${nums[i] === 1 ? "👑" : nums[i]}</div>
    </div>` : `
    <div class="pod ${cls[i]} empty-pod"><span class="avatar">?</span><div class="nm muted">—</div><div class="pts">&nbsp;</div><div class="block">${nums[i]}</div></div>`).join("");

  const rest = list.slice(3);
  $("#lbList").innerHTML = rest.length ? rest.map(p => `
    <div class="lb-item ${p.id === pid ? "me" : ""}">
      <span class="lb-rank">${p.rank}</span>
      ${avatarHtml(p.name)}
      <div class="lb-name"><b>${esc(p.name)}${p.id === pid ? " (kamu)" : ""}</b><span>${esc(p.kelasLabel || "")}</span></div>
      <span class="lb-score">${p.score || 0}</span>
    </div>`).join("") : (list.length <= 3 ? `<p class="muted" style="text-align:center;font-size:.85rem">Ajak teman lain untuk bergabung! 🙌</p>` : "");
}

// ---------- Hasil akhir ----------
function showFinal() {
  endedShown = true;
  const list = rankPlayers(players);
  const me = list.find(p => p.id === pid);
  if (!me) return;
  const medal = me.rank === 1 ? "🥇" : me.rank === 2 ? "🥈" : me.rank === 3 ? "🥉" : "🎖️";
  if (me.rank <= 3) celebrate();
  const back = document.createElement("div");
  back.className = "modal-back show";
  back.innerHTML = `<div class="modal modal-sm" style="text-align:center">
    <div style="font-size:3rem">${medal}</div>
    <h3 class="modal-title">Permainan Selesai!</h3>
    <p class="muted" style="margin:0">Peringkat akhirmu</p>
    <div class="final-rank">#${me.rank}</div>
    <p style="margin:0 0 6px"><b>${me.score || 0} poin</b> dari ${list.length} peserta</p>
    <p class="muted">Terima kasih sudah belajar bersama di Educhat, ${esc(me.name)}!</p>
    <div class="modal-actions" style="justify-content:center"><button class="btn btn-primary">Tutup</button></div>
  </div>`;
  back.querySelector("button").onclick = () => back.remove();
  document.body.appendChild(back);
}

// ---------- Ticker 1 detik ----------
function tick() {
  const now = serverNow();
  let expired = false;
  $$("[data-deadline]").forEach(el => {
    const left = (Number(el.dataset.deadline) - now) / 1000;
    el.textContent = left > 0 ? fmtCountdown(left) : "Habis";
    if (left <= 0) expired = true;
  });
  if (expired) renderFeed();
  $$("[data-bar-end]").forEach(el => {
    const end = Number(el.dataset.barEnd), startMs = Number(el.dataset.barStart);
    el.style.width = barPct(startMs, end) + "%";
    el.parentElement.classList.toggle("low", end - now < 10000);
  });
  renderComposer();
}
