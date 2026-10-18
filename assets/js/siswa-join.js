import {
  auth, db, $, toast, initTheme, setLoading, friendlyError, configWarning, kelasLabel,
  normKelas, normName, playerKey, AppError
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
const kelasInput = $("#kelas");
const absenInput = $("#absen");

// Isi ulang data terakhir
try {
  const saved = JSON.parse(localStorage.getItem("educhat_student") || "null");
  if (saved) {
    $("#name").value = saved.name || "";
    kelasInput.value = saved.kelas || "";
    absenInput.value = saved.absen || "";
  }
} catch { /* abaikan */ }

const qRoom = new URLSearchParams(location.search).get("room");
if (qRoom && /^\d{4}$/.test(qRoom)) roomInput.value = qRoom;

roomInput.addEventListener("input", () => {
  roomInput.value = roomInput.value.replace(/\D/g, "").slice(0, 4);
});
absenInput.addEventListener("input", () => {
  absenInput.value = absenInput.value.replace(/\D/g, "").slice(0, 3);
});
kelasInput.addEventListener("blur", () => { kelasInput.value = normKelas(kelasInput.value); });

form.addEventListener("submit", async e => {
  e.preventDefault();
  const name = $("#name").value.trim().replace(/\s+/g, " ");
  const kelas = normKelas(kelasInput.value);
  const absen = parseInt(absenInput.value, 10);
  const code = roomInput.value.trim();

  if (name.length < 2) return toast("Nama minimal 2 huruf.", "error");
  if (!kelas || !/[A-Z0-9]/.test(kelas)) return toast("Isi kelas, contoh: 7.1 atau IX-IPS1.", "error");
  if (!(absen >= 1 && absen <= 999)) return toast("No. absen harus angka 1–999.", "error");
  if (!/^\d{4}$/.test(code)) return toast("Kode room harus 4 digit angka.", "error");

  setLoading(btn, true, "Menghubungkan…");
  try {
    await auth.authStateReady();
    const user = auth.currentUser || (await signInAnonymously(auth)).user;

    const roomSnap = await getDoc(doc(db, "rooms", code));
    if (!roomSnap.exists()) throw new AppError(`Room ${code} tidak ditemukan. Periksa kembali kodenya.`);
    const room = roomSnap.data();
    if (room.status === "ended") throw new AppError("Room ini sudah berakhir.");

    // Kunci siswa = kelas + no. absen (bukan perangkat)
    const pid = playerKey(kelas, absen);
    const pRef = doc(db, "rooms", code, "players", pid);
    const pSnap = await getDoc(pRef);

    if (pSnap.exists()) {
      const p = pSnap.data();
      if (p.kicked) throw new AppError("Kamu telah dikeluarkan dari room ini oleh guru.");
      if (p.uid === user.uid) {
        // perangkat yang sama → boleh memperbarui ejaan nama
        await updateDoc(pRef, { name, lastSeen: serverTimestamp() });
      } else if (normName(p.name) === normName(name)) {
        // perangkat baru, identitas sama → pindahkan akun ke perangkat ini
        await updateDoc(pRef, { uid: user.uid, lastSeen: serverTimestamp() });
        toast("Selamat datang kembali! Poinmu dipulihkan di perangkat ini. 🎉", "success");
      } else {
        throw new AppError(`No. absen ${absen} di kelas ${kelas} sudah dipakai oleh "${p.name}". Periksa kembali kelas & no. absenmu.`);
      }
    } else {
      if (room.status === "locked") throw new AppError("Room sedang dikunci guru. Minta guru untuk membukanya.");
      await setDoc(pRef, {
        uid: user.uid, name, kelas, absen, kelasLabel: kelasLabel(kelas, absen),
        score: 0, kicked: false, joinedAt: serverTimestamp(), lastSeen: serverTimestamp()
      });
    }

    try {
      localStorage.setItem("educhat_student", JSON.stringify({ name, kelas, absen }));
      localStorage.setItem(`educhat_pid_${code}`, pid);
    } catch { /* abaikan */ }
    location.href = `kelas.html?room=${code}&p=${encodeURIComponent(pid)}`;
  } catch (err) {
    toast(friendlyError(err), "error", 5000);
    setLoading(btn, false);
  }
});
