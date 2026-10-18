import {
  auth, db, $, $$, esc, toast, initTheme, initFullscreen, setLoading, friendlyError, configWarning, tsMillis, fmtDate,
  fmtTimer, avatarHtml, confirmDialog, promptDialog, deleteRoomDeep, AppError, DEFAULT_SETTINGS
} from "./common.js";
import { listenBank, openBankEditor, deleteBankItem, bankItemHtml, filterBank } from "./bank.js";
import {
  onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, getDoc, setDoc, collection, query, orderBy, onSnapshot, runTransaction, serverTimestamp,
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

initTheme();
initFullscreen();
configWarning();

let me = null, teacher = null, rooms = [], filter = "all", unsubRooms = null;
let bank = [], unsubBank = null;

// =============== LOGIN ===============
$("#togglePw").onclick = () => {
  const pw = $("#password");
  pw.type = pw.type === "password" ? "text" : "password";
  $("#togglePw").textContent = pw.type === "password" ? "👁" : "🙈";
};

$("#loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  const email = $("#email").value.trim(), password = $("#password").value;
  if (!email || !password) return toast("Email dan password wajib diisi.", "error");
  const btn = $("#loginBtn");
  setLoading(btn, true, "Memeriksa…");
  try {
    await signInWithEmailAndPassword(auth, email, password);
    toast("Berhasil masuk. Selamat mengajar! 👋", "success");
  } catch (err) {
    toast(friendlyError(err), "error", 4500);
  } finally {
    setLoading(btn, false);
  }
});

$("#forgotLink").onclick = async e => {
  e.preventDefault();
  const email = await promptDialog({
    title: "Reset password", label: "Email akun guru", type: "email",
    value: $("#email").value.trim(), okText: "Kirim link reset",
    hint: "Link untuk membuat password baru akan dikirim ke email ini."
  });
  if (!email) return;
  try {
    await sendPasswordResetEmail(auth, email);
    toast("Link reset password telah dikirim. Cek kotak masuk email Anda.", "success", 5000);
  } catch (err) { toast(friendlyError(err), "error"); }
};

// =============== MENU AKUN ===============
const accMenu = $("#accountMenu");
const setMenu = open => {
  accMenu.classList.toggle("show", open);
  $("#accountBtn").setAttribute("aria-expanded", String(open));
};
$("#accountBtn").onclick = e => { e.stopPropagation(); setMenu(!accMenu.classList.contains("show")); };
document.addEventListener("click", e => { if (!e.target.closest("#account")) setMenu(false); });
document.addEventListener("keydown", e => { if (e.key === "Escape") setMenu(false); });
accMenu.addEventListener("click", async e => {
  const b = e.target.closest("[data-menu]");
  if (!b) return;
  setMenu(false);
  if (b.dataset.menu === "rename") renameTeacher();
  if (b.dataset.menu === "logout" &&
      await confirmDialog({ title: "Keluar dari akun?", message: "Anda akan kembali ke halaman login guru.", okText: "Keluar", danger: true })) {
    await signOut(auth);
  }
});

onAuthStateChanged(auth, user => {
  if (user && !user.isAnonymous) showDashboard(user);
  else showLogin();
});

function showLogin() {
  me = null;
  unsubRooms?.(); unsubRooms = null;
  unsubBank?.(); unsubBank = null;
  $("#loginView").classList.remove("hidden");
  $("#loginFooter").classList.remove("hidden");
  $("#dashView").classList.add("hidden");
  $("#account").classList.add("hidden");
}

// =============== DASHBOARD ===============
async function showDashboard(user) {
  me = user;
  $("#loginView").classList.add("hidden");
  $("#loginFooter").classList.add("hidden");
  $("#dashView").classList.remove("hidden");

  const h = new Date().getHours();
  $("#greet").textContent = h < 11 ? "Selamat pagi ☀️" : h < 15 ? "Selamat siang 🌤️" : h < 18 ? "Selamat sore 🌇" : "Selamat malam 🌙";

  try {
    const tRef = doc(db, "teachers", user.uid);
    const snap = await getDoc(tRef);
    if (snap.exists()) teacher = snap.data();
    else {
      teacher = { email: user.email, displayName: user.displayName || user.email.split("@")[0] };
      await setDoc(tRef, { ...teacher, createdAt: serverTimestamp() });
    }
  } catch (err) {
    teacher = { email: user.email, displayName: user.email.split("@")[0] };
    toast(friendlyError(err), "error");
  }
  renderTeacher();

  unsubRooms?.();
  unsubRooms = onSnapshot(query(collection(db, "rooms"), orderBy("createdAt", "desc")), snap => {
    rooms = snap.docs.map(d => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
    renderRooms();
  }, err => toast(friendlyError(err), "error"));

  unsubBank?.();
  unsubBank = listenBank(user.uid, items => { bank = items; renderBank(); });
}

function renderTeacher() {
  $("#teacherName").textContent = teacher.displayName;
  $("#accountAvatar").innerHTML = avatarHtml(teacher.displayName);
  $("#accountName").textContent = teacher.displayName;
  $("#menuName").textContent = teacher.displayName;
  $("#menuEmail").textContent = me.email;
  $("#account").classList.remove("hidden");
}

async function renameTeacher() {
  const name = await promptDialog({
    title: "Ubah nama tampilan", label: "Nama yang dilihat siswa", value: teacher.displayName,
    placeholder: "cth. Bu Sari, S.Pd."
  });
  if (!name || name === teacher.displayName) return;
  try {
    const batch = writeBatch(db);
    batch.set(doc(db, "teachers", me.uid), { displayName: name, email: me.email }, { merge: true });
    rooms.filter(r => r.ownerUid === me.uid).forEach(r => batch.update(doc(db, "rooms", r.id), { ownerName: name }));
    await batch.commit();
    teacher.displayName = name;
    renderTeacher();
    toast("Nama berhasil diubah.", "success");
  } catch (err) { toast(friendlyError(err), "error"); }
}

// =============== TAB: ROOM / BANK SOAL ===============
$$("#mainTabs button").forEach(b => b.onclick = () => {
  $$("#mainTabs button").forEach(x => x.classList.toggle("active", x === b));
  $("#roomsView").classList.toggle("hidden", b.dataset.view !== "rooms");
  $("#bankView").classList.toggle("hidden", b.dataset.view !== "bank");
});

$("#bankAddBtn").onclick = () => openBankEditor(me.uid);
$("#bankSearch").addEventListener("input", renderBank);

function renderBank() {
  $("#bankCount").textContent = bank.length;
  const list = filterBank(bank, $("#bankSearch").value);
  $("#bankList").innerHTML = list.length ? list.map(it => bankItemHtml(it, `
      <button class="btn btn-ghost btn-icon btn-sm" data-bedit="${it.id}" title="Edit">✏️</button>
      <button class="btn btn-danger-soft btn-icon btn-sm" data-bdel="${it.id}" title="Hapus">🗑</button>`)).join("")
    : `<div class="empty card"><div class="big">📚</div>
        <b>${bank.length ? "Tidak ada soal yang cocok" : "Bank soal masih kosong"}</b>
        <p>${bank.length ? "Coba kata kunci lain." : "Klik “Tambah Soal” untuk menyiapkan soal isian atau pilihan ganda."}</p></div>`;
}

$("#bankList").addEventListener("click", async e => {
  const ed = e.target.closest("[data-bedit]"), del = e.target.closest("[data-bdel]");
  if (ed) return openBankEditor(me.uid, bank.find(x => x.id === ed.dataset.bedit));
  if (del) {
    const it = bank.find(x => x.id === del.dataset.bdel);
    if (!it || !await confirmDialog({ title: "Hapus soal ini?", message: esc(it.text.slice(0, 120)), okText: "Hapus", danger: true })) return;
    try { await deleteBankItem(me.uid, it.id); toast("Soal dihapus.", "success"); }
    catch (err) { toast(friendlyError(err), "error"); }
  }
});

// Filter & cari
$$("#filterSeg button").forEach(b => b.onclick = () => {
  filter = b.dataset.f;
  $$("#filterSeg button").forEach(x => x.classList.toggle("active", x === b));
  renderRooms();
});
$("#search").addEventListener("input", renderRooms);

function renderRooms() {
  if (!me) return;
  const mine = rooms.filter(r => r.ownerUid === me.uid);
  $("#statAll").textContent = rooms.length;
  $("#statMine").textContent = mine.length;
  $("#statActive").textContent = rooms.filter(r => r.status !== "ended").length;

  const q = $("#search").value.trim().toLowerCase();
  const list = (filter === "mine" ? mine : rooms).filter(r =>
    !q || [r.code, r.name, r.ownerName, r.ownerEmail].some(v => String(v || "").toLowerCase().includes(q)));

  const grid = $("#roomGrid");
  if (!list.length) {
    grid.innerHTML = `<div class="empty card" style="grid-column:1/-1">
      <div class="big">${q ? "🔎" : "🏫"}</div>
      <b>${q ? "Tidak ada room yang cocok" : filter === "mine" ? "Anda belum punya room" : "Belum ada room"}</b>
      <p>${q ? "Coba kata kunci lain." : "Klik “Buat Room Baru” untuk memulai kuis pertama Anda."}</p>
    </div>`;
    return;
  }

  grid.innerHTML = list.map(r => {
    const own = r.ownerUid === me.uid;
    const s = { ...DEFAULT_SETTINGS, ...(r.settings || {}) };
    const status = {
      open: `<span class="badge badge-success">● Aktif</span>`,
      locked: `<span class="badge badge-warning">🔒 Dikunci</span>`,
      ended: `<span class="badge badge-danger">⏹ Berakhir</span>`
    }[r.status] || "";
    return `<article class="card room-card ${own ? "mine" : ""}">
      <div class="room-top">
        <div>
          <div class="room-code">${esc(r.code)}</div>
          <div class="room-name" style="margin-top:6px">${esc(r.name || "Tanpa nama")}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end">
          ${status}${own ? `<span class="badge badge-primary">Milik saya</span>` : ""}
        </div>
      </div>
      <div class="room-owner">${avatarHtml(r.ownerName || "?")}<span>${esc(r.ownerName || "Guru")} · ${fmtDate(tsMillis(r.createdAt))}</span></div>
      <div class="room-chips">
        <span class="badge">${s.answerMode === "single" ? "1× jawab" : "Berkali-kali"}</span>
        <span class="badge">⭐ ${s.defaultPoints} poin</span>
        <span class="badge">⚡ ${s.maxFastest > 0 ? s.maxFastest + " tercepat" : "Tanpa batas"}</span>
        ${s.defaultTimer ? `<span class="badge">⏱ ${fmtTimer(s.defaultTimer)}</span>` : ""}
      </div>
      <div class="room-actions">
        ${own ? `
          <a class="btn btn-primary btn-sm" href="guru-room.html?room=${esc(r.code)}">🎮 Kelola Room</a>
          <button class="btn btn-danger-soft btn-sm" data-del="${esc(r.code)}" title="Hapus room">🗑</button>`
        : `<div class="locked-note">🔒 Hanya bisa dikelola oleh ${esc(r.ownerName || "pembuatnya")}</div>`}
      </div>
    </article>`;
  }).join("");

  $$("[data-del]", grid).forEach(b => b.onclick = () => removeRoom(b.dataset.del, b));
}

async function removeRoom(code, btn) {
  const r = rooms.find(x => x.code === code);
  if (!r || r.ownerUid !== me.uid) return toast("Anda hanya bisa menghapus room milik sendiri.", "error");
  const ok = await confirmDialog({
    title: `Hapus room ${code}?`,
    message: `Room <b>${esc(r.name || "")}</b> beserta seluruh pertanyaan, jawaban, dan poin siswa akan dihapus permanen.`,
    okText: "Hapus permanen", danger: true
  });
  if (!ok) return;
  setLoading(btn, true);
  try {
    await deleteRoomDeep(code);
    toast(`Room ${code} dihapus.`, "success");
  } catch (err) {
    toast(friendlyError(err), "error");
    setLoading(btn, false);
  }
}

// =============== BUAT ROOM ===============
const modal = $("#createModal");
const codeInput = $("#cCode");
let mode = "single", checkTimer = null, checkSeq = 0;

function openCreate() {
  $("#createForm").reset();
  mode = "single";
  $$("#cMode button").forEach(b => b.classList.toggle("active", b.dataset.v === mode));
  $("#codeStatus").textContent = "";
  modal.classList.add("show");
  randomCode();
  setTimeout(() => $("#cName").focus(), 50);
}
const closeCreate = () => modal.classList.remove("show");
$("#newRoomBtn").onclick = openCreate;
$$("[data-close]", modal).forEach(b => b.onclick = closeCreate);
modal.addEventListener("mousedown", e => { if (e.target === modal) closeCreate(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") closeCreate(); });

$$("#cMode button").forEach(b => b.onclick = () => {
  mode = b.dataset.v;
  $$("#cMode button").forEach(x => x.classList.toggle("active", x === b));
});

async function randomCode() {
  const used = new Set(rooms.map(r => r.code));
  let c;
  for (let i = 0; i < 50; i++) {
    c = String(Math.floor(1000 + Math.random() * 9000));
    if (!used.has(c)) break;
  }
  codeInput.value = c;
  checkCode();
}
$("#randCode").onclick = randomCode;

codeInput.addEventListener("input", () => {
  codeInput.value = codeInput.value.replace(/\D/g, "").slice(0, 4);
  clearTimeout(checkTimer);
  checkTimer = setTimeout(checkCode, 300);
});

async function checkCode() {
  const c = codeInput.value, el = $("#codeStatus");
  el.className = "code-status";
  if (!/^\d{4}$/.test(c)) { el.textContent = c ? "Kode harus 4 digit angka." : ""; return; }
  const seq = ++checkSeq;
  el.textContent = "Memeriksa ketersediaan…";
  try {
    const snap = await getDoc(doc(db, "rooms", c));
    if (seq !== checkSeq) return;
    if (snap.exists()) {
      el.textContent = `✗ Kode ${c} sudah dipakai oleh ${snap.data().ownerName || "guru lain"}.`;
      el.classList.add("bad");
    } else {
      el.textContent = `✓ Kode ${c} tersedia.`;
      el.classList.add("ok");
    }
  } catch { el.textContent = ""; }
}

$("#createForm").addEventListener("submit", async e => {
  e.preventDefault();
  const name = $("#cName").value.trim();
  const code = codeInput.value.trim();
  const points = Math.round(Number($("#cPoints").value));
  const maxF = Math.round(Number($("#cMax").value));
  if (!name) return toast("Nama room wajib diisi.", "error");
  if (!/^\d{4}$/.test(code)) return toast("Kode room harus 4 digit angka.", "error");
  if (!(points >= 1 && points <= 1000)) return toast("Poin harus antara 1–1000.", "error");
  if (!(maxF >= 0 && maxF <= 500)) return toast("Maks. penjawab antara 0–500.", "error");

  const btn = $("#createBtn");
  setLoading(btn, true, "Membuat…");
  const ref = doc(db, "rooms", code);
  try {
    await runTransaction(db, async tx => {
      const snap = await tx.get(ref);
      if (snap.exists()) throw new AppError(`Kode ${code} sudah dipakai oleh ${snap.data().ownerName || "guru lain"}. Pilih kode lain.`);
      tx.set(ref, {
        code, name,
        ownerUid: me.uid, ownerEmail: me.email, ownerName: teacher.displayName,
        status: "open",
        settings: {
          answerMode: mode, defaultPoints: points, maxFastest: maxF,
          showAnswers: $("#cShow").value, defaultTimer: Number($("#cTimer").value)
        },
        createdAt: serverTimestamp(), updatedAt: serverTimestamp()
      });
    });
    closeCreate();
    toast(`Room ${code} berhasil dibuat! 🎉`, "success");
    setTimeout(() => { location.href = `guru-room.html?room=${code}`; }, 600);
  } catch (err) {
    // aturan keamanan menolak create jika dokumen sudah ada (bentrok kode)
    toast(err.code === "permission-denied" ? `Kode ${code} tidak dapat digunakan. Pilih kode lain.` : friendlyError(err), "error", 4500);
    checkCode();
  } finally {
    setLoading(btn, false);
  }
});
