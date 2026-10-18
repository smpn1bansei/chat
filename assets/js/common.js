// =============================================================
//  EDUCHAT — modul bersama (Firebase, UI helper, dialog, suara)
// =============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, getDocs, writeBatch, doc, setDoc, getDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

export const configReady = !!firebaseConfig.apiKey && !firebaseConfig.apiKey.includes("GANTI");
export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

export const KELAS = ["7", "8", "9", "10", "11", "12"];
export const ONLINE_WINDOW = 150 * 1000;
export const HEARTBEAT_MS = 60 * 1000;

export const DEFAULT_SETTINGS = {
  answerMode: "single",   // "single" | "multiple"
  defaultPoints: 10,
  maxFastest: 0,          // 0 = tanpa batas
  showAnswers: "never",   // "never" | "closed" | "always"  (never = paling hemat kuota)
  defaultTimer: 0,        // detik, 0 = tanpa batas waktu
  bonus1: 0,              // bonus poin penjawab benar tercepat #1
  bonus2: 0,              // #2
  bonus3: 0,              // #3
  trackOnline: false      // tanda online siswa (mati = lebih hemat kuota)
};

export const SHOW_ANSWERS_LABEL = {
  never: "Tidak terlihat (hemat kuota)",
  closed: "Setelah pertanyaan ditutup",
  always: "Langsung terlihat"
};
export const LETTERS = ["A", "B", "C", "D", "E", "F"];

// ---------- Jam server ----------
// Jam HP siswa/guru bisa meleset. Semua hitung mundur memakai serverNow().
let clockOffset = 0;
export const serverNow = () => Date.now() + clockOffset;
/**
 * Tulis serverTimestamp ke `ref.field`, baca kembali, lalu hitung selisih
 * jam perangkat terhadap jam server Firebase.
 */
export async function syncClock(ref, field) {
  try {
    const t0 = Date.now();
    await setDoc(ref, { [field]: serverTimestamp() }, { merge: true });
    const t1 = Date.now();
    const snap = await getDoc(ref);
    const server = snap.get(field)?.toMillis?.();
    if (server) clockOffset = server - (t0 + t1) / 2;
  } catch { /* tetap pakai jam perangkat */ }
  return clockOffset;
}

// ---------- DOM ----------
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(str) {
  return String(str ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

/** Teks dengan baris baru dipertahankan */
export const escMultiline = str => esc(str).replace(/\n/g, "<br>");

export class AppError extends Error {
  constructor(msg) { super(msg); this.isApp = true; }
}

// ---------- Waktu ----------
export function tsMillis(ts) {
  if (!ts) return null;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (ts instanceof Date) return ts.getTime();
  return Number(ts);
}
export function fmtClock(ms) {
  if (!ms) return "";
  return new Date(ms).toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
}
export function fmtDate(ms) {
  if (!ms) return "-";
  return new Date(ms).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" });
}
export function fmtCountdown(sec) {
  sec = Math.max(0, Math.ceil(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
export function fmtTimer(sec) {
  if (!sec) return "Tanpa batas";
  if (sec < 60) return `${sec} detik`;
  return `${sec / 60} menit`;
}

// ---------- Identitas ----------
/** "  ix-ips 1 " → "IX-IPS 1" */
export const normKelas = s => String(s || "").trim().replace(/\s+/g, " ").toUpperCase();
/** Nama untuk dibandingkan: huruf kecil, spasi dirapikan */
export const normName = s => String(s || "").trim().replace(/\s+/g, " ").toLowerCase();
export const kelasLabel = (kelas, absen) => `${kelas} · No. ${absen}`;
/**
 * ID siswa di dalam room = kelas + no. absen (mis. "7-1__5", "IX-IPS1__12").
 * Inilah kunci yang membuat poin tetap sama walau siswa ganti perangkat.
 */
export const playerKey = (kelas, absen) =>
  `${normKelas(kelas).replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "X"}__${Number(absen)}`;
export function initials(name) {
  const parts = String(name || "?").trim().split(/\s+/);
  return ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase() || "?";
}
export function avatarColor(name) {
  let h = 0;
  for (const c of String(name || "")) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 62% 52%)`;
}
export function avatarHtml(name, cls = "") {
  return `<span class="avatar ${cls}" style="background:${avatarColor(name)}">${esc(initials(name))}</span>`;
}

/** Peringkat dengan skor seri = peringkat sama */
export function rankPlayers(players) {
  const list = players
    .filter(p => !p.kicked)
    .sort((a, b) => (b.score || 0) - (a.score || 0) || String(a.name).localeCompare(String(b.name)));
  let prev = null, rank = 0;
  list.forEach((p, i) => {
    if (prev === null || (p.score || 0) !== prev) rank = i + 1;
    p.rank = rank;
    prev = p.score || 0;
  });
  return list;
}

// ---------- Tema ----------
export function initTheme() {
  $$("[data-theme-toggle]").forEach(btn => {
    btn.addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem("educhat_theme", next); } catch { /* abaikan */ }
    });
  });
}

// ---------- Tinggi layar nyata (address bar & keyboard HP) ----------
export function initViewportHeight(onResize) {
  const vv = window.visualViewport;
  const apply = () => {
    const h = vv ? vv.height : window.innerHeight;
    document.documentElement.style.setProperty("--app-h", `${Math.round(h)}px`);
    if (vv) window.scrollTo(0, 0);
    onResize?.();
  };
  (vv || window).addEventListener("resize", apply);
  if (vv) vv.addEventListener("scroll", () => window.scrollTo(0, 0));
  window.addEventListener("orientationchange", () => setTimeout(apply, 300));
  apply();
}

// ---------- Layar penuh ----------
export function initFullscreen() {
  const btns = $$("[data-fullscreen]");
  if (!document.documentElement.requestFullscreen) { btns.forEach(b => b.classList.add("hidden")); return; }
  const sync = () => btns.forEach(b => {
    const on = !!document.fullscreenElement;
    b.textContent = on ? "🗗" : "⛶";
    b.title = on ? "Keluar layar penuh" : "Layar penuh";
  });
  btns.forEach(b => b.addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => toast("Browser menolak mode layar penuh.", "error"));
  }));
  document.addEventListener("fullscreenchange", sync);
  sync();
}

// ---------- Toast ----------
export function toast(msg, type = "info", ms = 3200) {
  let wrap = $("#toasts");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.id = "toasts";
    wrap.className = "toasts";
    document.body.appendChild(wrap);
  }
  const icons = { info: "💬", success: "✅", error: "⚠️", warning: "⏰" };
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.innerHTML = `<span class="toast-ico">${icons[type] || "💬"}</span><span>${esc(msg)}</span>`;
  wrap.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  }, ms);
}

export function setLoading(btn, on, text) {
  if (!btn) return;
  if (on) {
    btn.dataset.label = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>${text ? `<span>${esc(text)}</span>` : ""}`;
  } else {
    btn.disabled = false;
    if (btn.dataset.label) btn.innerHTML = btn.dataset.label;
  }
}

// ---------- Dialog ----------
function openDialog(innerHtml, onMount) {
  return new Promise(resolve => {
    const back = document.createElement("div");
    back.className = "modal-back show";
    back.innerHTML = `<div class="modal modal-sm" role="dialog" aria-modal="true">${innerHtml}</div>`;
    document.body.appendChild(back);
    const close = val => {
      back.classList.remove("show");
      setTimeout(() => back.remove(), 200);
      document.removeEventListener("keydown", onKey);
      resolve(val);
    };
    const onKey = e => { if (e.key === "Escape") close(null); };
    document.addEventListener("keydown", onKey);
    back.addEventListener("mousedown", e => { if (e.target === back) close(null); });
    onMount(back, close);
  });
}

export function confirmDialog({ title, message, okText = "Ya", cancelText = "Batal", danger = false }) {
  return openDialog(`
    <h3 class="modal-title">${esc(title)}</h3>
    <p class="muted">${message}</p>
    <div class="modal-actions">
      <button class="btn btn-ghost" data-act="cancel">${esc(cancelText)}</button>
      <button class="btn ${danger ? "btn-danger" : "btn-primary"}" data-act="ok">${esc(okText)}</button>
    </div>`, (root, close) => {
    root.querySelector('[data-act="cancel"]').onclick = () => close(false);
    const ok = root.querySelector('[data-act="ok"]');
    ok.onclick = () => close(true);
    ok.focus();
  }).then(v => !!v);
}

export function promptDialog({ title, label, value = "", placeholder = "", okText = "Simpan", type = "text", hint = "" }) {
  return openDialog(`
    <h3 class="modal-title">${esc(title)}</h3>
    <form>
      <label class="field"><span>${esc(label)}</span>
        <input type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}" required>
      </label>
      ${hint ? `<p class="hint">${esc(hint)}</p>` : ""}
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" data-act="cancel">Batal</button>
        <button type="submit" class="btn btn-primary">${esc(okText)}</button>
      </div>
    </form>`, (root, close) => {
    const input = root.querySelector("input");
    root.querySelector('[data-act="cancel"]').onclick = () => close(null);
    root.querySelector("form").onsubmit = e => { e.preventDefault(); close(input.value.trim()); };
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}

// ---------- Suara (Web Audio, tanpa file) ----------
let audioCtx = null;
export function beep(kind = "info") {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const seq = {
      question: [[660, 0], [880, 0.12]],
      correct: [[523, 0], [659, 0.1], [784, 0.2], [1047, 0.3]],
      wrong: [[330, 0], [247, 0.15]],
      info: [[740, 0]],
      answer: [[990, 0]]
    }[kind] || [[740, 0]];
    const now = audioCtx.currentTime;
    for (const [freq, t] of seq) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = kind === "wrong" ? "triangle" : "sine";
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, now + t);
      g.gain.exponentialRampToValueAtTime(0.18, now + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.22);
      o.connect(g).connect(audioCtx.destination);
      o.start(now + t);
      o.stop(now + t + 0.25);
    }
  } catch { /* browser tanpa audio */ }
}

export function celebrate() {
  if (typeof window.confetti !== "function") return;
  window.confetti({ particleCount: 120, spread: 75, origin: { y: 0.7 } });
}

// ---------- Error ----------
export function friendlyError(e) {
  if (e?.isApp) return e.message;
  const code = e?.code || "";
  const map = {
    "auth/invalid-credential": "Email atau password salah.",
    "auth/wrong-password": "Email atau password salah.",
    "auth/user-not-found": "Akun guru tidak ditemukan.",
    "auth/invalid-email": "Format email tidak valid.",
    "auth/too-many-requests": "Terlalu banyak percobaan. Coba lagi beberapa saat lagi.",
    "auth/network-request-failed": "Tidak ada koneksi internet.",
    "auth/operation-not-allowed": "Metode login belum diaktifkan di Firebase Console (aktifkan Email/Password & Anonymous).",
    "auth/admin-restricted-operation": "Login Anonymous belum diaktifkan di Firebase Console.",
    "auth/api-key-not-valid.-please-pass-a-valid-api-key.": "API key Firebase belum benar. Periksa assets/js/firebase-config.js.",
    "auth/missing-password": "Password wajib diisi.",
    "permission-denied": "Akses ditolak oleh aturan keamanan.",
    "unavailable": "Server tidak dapat dihubungi. Periksa koneksi internet.",
    "not-found": "Data tidak ditemukan.",
    "failed-precondition": "Operasi gagal, coba muat ulang halaman."
  };
  if (map[code]) return map[code];
  if (code.startsWith("auth/api-key")) return map["auth/api-key-not-valid.-please-pass-a-valid-api-key."];
  console.error(e);
  return e?.message || "Terjadi kesalahan. Coba lagi.";
}

export function configWarning() {
  if (configReady) return;
  const bar = document.createElement("div");
  bar.className = "config-warning";
  bar.innerHTML = `⚙️ Firebase belum dikonfigurasi. Isi <code>assets/js/firebase-config.js</code> dengan konfigurasi proyek Anda (lihat README.md).`;
  document.body.prepend(bar);
}

// ---------- Hapus room beserta isinya ----------
export async function deleteRoomDeep(code) {
  for (const sub of ["answers", "slots", "messages", "keys", "presence", "players"]) {
    const snap = await getDocs(collection(db, "rooms", code, sub));
    const docs = snap.docs;
    for (let i = 0; i < docs.length; i += 400) {
      const batch = writeBatch(db);
      docs.slice(i, i + 400).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
  }
  const batch = writeBatch(db);
  batch.delete(doc(db, "rooms", code));
  await batch.commit();
}

/** URL halaman gabung siswa untuk kode room tertentu */
export function joinUrl(code) {
  const base = location.href.replace(/[^/]*([?#].*)?$/, "");
  return `${base}index.html?room=${code}`;
}
