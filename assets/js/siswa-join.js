import {
  auth, db, $, KELAS, toast, initTheme, setLoading, friendlyError, configWarning, kelasLabel, AppError
} from "./common.js";
import { signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, getDoc, setDoc, updateDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

initTheme();
configWarning();

const form = $("#joinForm");
const btn = $("#joinBtn");
const roomInput = $("#room");

// Pilihan kelas 7–12
$("#kelasPills").innerHTML = KELAS.map(k => `
  <label><input type="radio" name="kelas" value="${k}"><span>${k}</span></label>`).join("");

// Isi ulang data terakhir
try {
  const saved = JSON.parse(localStorage.getItem("educhat_student") || "null");
  if (saved) {
    $("#name").value = saved.name || "";
    $("#rombel").value = saved.rombel || "";
    const r = form.querySelector(`input[name="kelas"][value="${saved.kelas}"]`);
    if (r) r.checked = true;
  }
} catch { /* abaikan */ }

const qRoom = new URLSearchParams(location.search).get("room");
if (qRoom && /^\d{4}$/.test(qRoom)) roomInput.value = qRoom;

roomInput.addEventListener("input", () => {
  roomInput.value = roomInput.value.replace(/\D/g, "").slice(0, 4);
});

form.addEventListener("submit", async e => {
  e.preventDefault();
  const name = $("#name").value.trim().replace(/\s+/g, " ");
  const kelas = form.querySelector('input[name="kelas"]:checked')?.value;
  const rombel = $("#rombel").value.trim().replace(/\s+/g, " ").toUpperCase();
  const code = roomInput.value.trim();

  if (name.length < 2) return toast("Nama minimal 2 huruf.", "error");
  if (!kelas) return toast("Pilih kelas terlebih dahulu.", "error");
  if (!rombel) return toast("Isi rombel/jurusan, contoh: IPA 1.", "error");
  if (!/^\d{4}$/.test(code)) return toast("Kode room harus 4 digit angka.", "error");

  setLoading(btn, true, "Menghubungkan…");
  try {
    await auth.authStateReady();
    const user = auth.currentUser || (await signInAnonymously(auth)).user;

    const roomSnap = await getDoc(doc(db, "rooms", code));
    if (!roomSnap.exists()) throw new AppError(`Room ${code} tidak ditemukan. Periksa kembali kodenya.`);
    const room = roomSnap.data();
    if (room.status === "ended") throw new AppError("Room ini sudah berakhir.");

    const pRef = doc(db, "rooms", code, "players", user.uid);
    const pSnap = await getDoc(pRef);
    const profile = { name, kelas, rombel, kelasLabel: kelasLabel(kelas, rombel) };

    if (pSnap.exists()) {
      if (pSnap.data().kicked) throw new AppError("Kamu telah dikeluarkan dari room ini oleh guru.");
      await updateDoc(pRef, { ...profile, lastSeen: serverTimestamp() });
    } else {
      if (room.status === "locked") throw new AppError("Room sedang dikunci guru. Minta guru untuk membukanya.");
      await setDoc(pRef, {
        uid: user.uid, ...profile, score: 0, kicked: false,
        joinedAt: serverTimestamp(), lastSeen: serverTimestamp()
      });
    }

    try { localStorage.setItem("educhat_student", JSON.stringify({ name, kelas, rombel })); } catch { /* abaikan */ }
    location.href = `kelas.html?room=${code}`;
  } catch (err) {
    toast(friendlyError(err), "error", 4500);
    setLoading(btn, false);
  }
});
