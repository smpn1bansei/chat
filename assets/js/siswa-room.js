import {
  auth, db, $, $$, esc, escMultiline, toast, initTheme, initFullscreen, friendlyError, configWarning, tsMillis,
  fmtClock, fmtCountdown, avatarHtml, initials, avatarColor, rankPlayers, beep, celebrate, confirmDialog, AppError, DEFAULT_SETTINGS
} from "./common.js";
import {
  doc, collection, query, orderBy, onSnapshot, runTransaction, updateDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

initTheme();
initFullscreen();
configWarning();

const code = new URLSearchParams(location.search).get("room");
if (!/^\d{4}$/.test(code || "")) location.replace("index.html");

const roomRef = doc(db, "rooms", code);
const answersCol = collection(db, "rooms", code, "answers");

let uid = null;
let room = null, player = null;
let messages = [], answers = [], players = [];
let sending = false, firstFeedRender = true;
let soundOn = localStorage.getItem("educhat_sound") !== "off";
let endedShown = false;
const seenQuestions = new Set();
const myStatuses = new Map();
let msgsReady = false, ansReady = false;
const unsubs = [];

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
  start();
}

function fatal(icon, title, msg) {
  unsubs.forEach(u => u());
  $("#loading").innerHTML = `
    <div class="card">
      <div class="big">${icon}</div>
      <h2 style="margin-bottom:6px">${esc(title)}</h2>
      <p class="muted">${esc(msg)}</p>
      <a class="btn btn-primary btn-block" href="index.html">Kembali ke halaman awal</a>
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
    renderHeader();
    renderFeed();
    renderComposer();
    if (room.status === "ended" && !endedShown && player) showFinal();
  }, onErr));

  unsubs.push(onSnapshot(doc(db, "rooms", code, "players", uid), snap => {
    if (!snap.exists()) { location.replace(`index.html?room=${code}`); return; }
    const prevScore = player?.score;
    player = snap.data();
    if (player.kicked) return fatal("🚫", "Kamu dikeluarkan", "Guru telah mengeluarkanmu dari room ini.");
    $("#meName").textContent = player.name;
    $("#meKelas").textContent = player.kelasLabel || "";
    $("#meAvatar").textContent = initials(player.name);
    $("#meAvatar").style.background = avatarColor(player.name);
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

  unsubs.push(onSnapshot(query(answersCol, orderBy("createdAt")), snap => {
    answers = snap.docs.map(d => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
    for (const a of answers) {
      if (a.uid !== uid) continue;
      const prev = myStatuses.get(a.id);
      myStatuses.set(a.id, a.status);
      if (!ansReady || prev === undefined || prev === a.status) continue;
      if (a.status === "correct") {
        play("correct"); celebrate();
        toast(`Jawabanmu BENAR! +${a.points} poin 🎉`, "success", 4000);
      } else if (a.status === "wrong") {
        play("wrong");
        toast("Jawabanmu belum tepat. Tetap semangat! 💪", "error");
      }
    }
    ansReady = true;
    renderFeed();
  }, onErr));

  unsubs.push(onSnapshot(collection(db, "rooms", code, "players"), snap => {
    players = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderLeaderboard();
  }, onErr));

  // detak keberadaan (online)
  setInterval(() => {
    if (document.visibilityState === "visible" && player && !player.kicked) {
      updateDoc(doc(db, "rooms", code, "players", uid), { lastSeen: serverTimestamp() }).catch(() => {});
    }
  }, 30000);

  setInterval(tick, 1000);
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
    ${s.maxFastest > 0 ? `<span class="badge badge-accent hide-sm">⚡ ${s.maxFastest} tercepat</span>` : ""}`;
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
    if (dl && dl <= Date.now()) return `<span class="badge badge-warning">⏰ Waktu habis</span>`;
    return `<span class="badge badge-success">● Dibuka</span>`;
  }
  return `<span class="badge">Ditutup</span>`;
}

function answerBubble(a) {
  const mine = a.uid === uid;
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
  const resp = (m.responders || []).length;
  const dl = tsMillis(m.deadline), startMs = tsMillis(m.createdAt);
  const running = dl && m.status === "open" && dl > Date.now();
  const timer = running ? `
      <span>⏱ <b data-deadline="${dl}">${fmtCountdown((dl - Date.now()) / 1000)}</b></span>` : "";
  const bar = running ? `
      <div class="timebar"><i data-bar-start="${startMs}" data-bar-end="${dl}" style="width:${barPct(startMs, dl)}%"></i></div>` : "";
  const slots = m.status === "open" && s.maxFastest > 0
    ? `<span>👥 ${Math.min(resp, s.maxFastest)}/${s.maxFastest} slot</span>`
    : `<span>💬 ${resp} siswa menjawab</span>`;
  return `<div class="msg msg-other">
    <span class="avatar avatar-teacher">👩‍🏫</span>
    <div class="bubble q-bubble ${active ? "active" : ""}">
      <div class="q-head">
        <span class="q-num">PERTANYAAN #${m.number || ""}</span>
        <span class="badge badge-primary">+${m.points} poin</span>
        ${statusBadge(m)}
      </div>
      <div class="q-text">${esc(m.text)}</div>
      ${bar}
      <div class="q-foot">${timer}${slots}<span>${fmtClock(startMs)}</span></div>
    </div>
  </div>`;
}

function barPct(start, end) {
  return Math.max(0, Math.min(100, ((end - Date.now()) / (end - start)) * 100));
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
    const showOthers = s.showAnswers === "always" || m.status !== "open";
    let hidden = 0;
    for (const a of list) {
      if (a.uid === uid || showOthers) html += answerBubble(a);
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
  const dl = tsMillis(q.deadline);
  if (dl && dl <= Date.now()) return { ok: false, q, msg: "⏰ Waktu menjawab sudah habis." };
  const resp = q.responders || [];
  const inR = resp.includes(uid);
  if (s.answerMode === "single" && inR) return { ok: false, q, msg: "✅ Jawabanmu sudah terkirim. Tunggu penilaian guru." };
  if (!inR && s.maxFastest > 0 && resp.length >= s.maxFastest) {
    return { ok: false, q, msg: `🚫 Slot penuh — ${s.maxFastest} siswa tercepat sudah menjawab.` };
  }
  const left = s.maxFastest > 0 && !inR ? ` · sisa ${s.maxFastest - resp.length} slot` : "";
  return {
    ok: true, q,
    msg: (s.answerMode === "single" ? "✍️ Kamu hanya bisa menjawab 1 kali" : "✍️ Kamu boleh menjawab berkali-kali") + left
  };
}

let lastHint = "";
function renderComposer() {
  const st = composerState();
  input.disabled = !st.ok || sending;
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

function autosize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 140) + "px";
}
input.addEventListener("input", () => { autosize(); sendBtn.disabled = input.disabled || !input.value.trim(); });
input.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendAnswer(); }
});
$("#answerForm").addEventListener("submit", e => { e.preventDefault(); sendAnswer(); });

async function sendAnswer() {
  const text = input.value.trim();
  if (!text || sending) return;
  const st = composerState();
  if (!st.ok) return toast(st.msg, "error");
  const q = st.q;
  sending = true;
  renderComposer();
  try {
    await runTransaction(db, async tx => {
      const qRef = doc(db, "rooms", code, "messages", q.id);
      const rs = await tx.get(roomRef);
      const qs = await tx.get(qRef);
      if (!rs.exists()) throw new AppError("Room sudah dihapus.");
      if (!qs.exists()) throw new AppError("Pertanyaan sudah dihapus guru.");
      const r = rs.data(), qd = qs.data();
      const s = { ...DEFAULT_SETTINGS, ...(r.settings || {}) };
      if (r.status === "ended") throw new AppError("Room sudah berakhir.");
      if (qd.status !== "open") throw new AppError("Pertanyaan sudah ditutup guru.");
      if (qd.deadline && tsMillis(qd.deadline) <= Date.now()) throw new AppError("Waktu menjawab sudah habis.");
      const resp = qd.responders || [];
      const inR = resp.includes(uid);
      if (s.answerMode === "single" && inR) throw new AppError("Kamu sudah menjawab pertanyaan ini.");
      if (!inR && s.maxFastest > 0 && resp.length >= s.maxFastest) throw new AppError("Yah, slot jawaban sudah penuh! Lebih cepat lagi ya ⚡");

      const aRef = s.answerMode === "single" ? doc(answersCol, `${q.id}_${uid}`) : doc(answersCol);
      tx.update(qRef, { responders: inR ? resp : [...resp, uid], answerCount: (qd.answerCount || 0) + 1 });
      tx.set(aRef, {
        questionId: q.id, uid, name: player.name, kelasLabel: player.kelasLabel || "",
        text, status: "pending", points: 0, createdAt: serverTimestamp()
      });
    });
    input.value = "";
    autosize();
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

  const me = list.find(p => p.id === uid);
  $("#myRank").innerHTML = me ? `
    <div><div class="muted" style="font-size:.8rem;font-weight:700">Peringkatmu</div><div class="r">#${me.rank} <small class="muted" style="font-size:.85rem">dari ${list.length}</small></div></div>
    <div style="text-align:right"><div class="muted" style="font-size:.8rem;font-weight:700">Poin</div><div class="r">${me.score || 0}</div></div>` : "";

  const pod = [list[1], list[0], list[2]];
  const cls = ["p2", "p1", "p3"], nums = [2, 1, 3];
  $("#podium").innerHTML = pod.map((p, i) => p ? `
    <div class="pod ${cls[i]}">
      ${avatarHtml(p.name)}
      <div class="nm" title="${esc(p.name)}">${esc(p.name)}${p.id === uid ? " (kamu)" : ""}</div>
      <div class="pts">${p.score || 0} poin</div>
      <div class="block">${nums[i] === 1 ? "👑" : nums[i]}</div>
    </div>` : `
    <div class="pod ${cls[i]} empty-pod"><span class="avatar">?</span><div class="nm muted">—</div><div class="pts">&nbsp;</div><div class="block">${nums[i]}</div></div>`).join("");

  const rest = list.slice(3);
  $("#lbList").innerHTML = rest.length ? rest.map(p => `
    <div class="lb-item ${p.id === uid ? "me" : ""}">
      <span class="lb-rank">${p.rank}</span>
      ${avatarHtml(p.name)}
      <div class="lb-name"><b>${esc(p.name)}${p.id === uid ? " (kamu)" : ""}</b><span>${esc(p.kelasLabel || "")}</span></div>
      <span class="lb-score">${p.score || 0}</span>
    </div>`).join("") : (list.length <= 3 ? `<p class="muted" style="text-align:center;font-size:.85rem">Ajak teman lain untuk bergabung! 🙌</p>` : "");
}

// ---------- Hasil akhir ----------
function showFinal() {
  endedShown = true;
  const list = rankPlayers(players);
  const me = list.find(p => p.id === uid);
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
  const now = Date.now();
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
