# 💬 Educhat — Aplikasi Chat Kuis Pembelajaran

Educhat adalah aplikasi kuis berbentuk ruang chat untuk **siswa** dan **guru**, dibuat dengan HTML, CSS, dan JavaScript murni plus **Firebase** (Authentication + Cloud Firestore) secara realtime.

> Development by **Andri Fernanda, S.Pd., Gr.** © 2026

---

## ✨ Fitur

### Siswa (`index.html` → `kelas.html`)
- Masuk dengan **Nama**, **Kelas** (7–12), **Rombel** (misal `IPA 1`), dan **Kode Room 4 digit**. Tidak perlu akun.
- Tampilan chat: pertanyaan guru muncul sebagai gelembung chat, siswa langsung membalas.
- Hitung mundur timer, info slot "N tercepat", status jawaban (menunggu / benar / salah).
- Notifikasi suara + konfeti saat jawaban dinilai **benar**.
- **Papan skor live** dengan podium juara 1–3 dan peringkat pribadi.
- Layar hasil akhir (peringkat & poin) saat guru mengakhiri permainan.
- Bisa masuk lagi dengan kode yang sama tanpa kehilangan poin. Link `index.html?room=1234` (dari QR) langsung mengisi kode.

### Guru (`guru.html` → `guru-room.html`)
- Login **email & password**, ada fitur lupa password.
- Dashboard **semua room** (termasuk milik guru lain) + filter "Room Saya" dan pencarian.
- **Buat room** dengan kode 4 digit sendiri atau acak 🎲 — ketersediaan dicek langsung, dan kode **tidak bisa bentrok** (kode = ID dokumen, dijaga transaksi & aturan keamanan).
- Guru **hanya bisa masuk, mengelola, dan menghapus room miliknya sendiri** (dijaga di UI dan di Firestore Rules).
- **Pengaturan room live** (bisa diubah kapan saja selama permainan):
  - Mode jawaban: **1× jawab per pertanyaan** *(default)* atau **boleh berkali-kali**.
  - **Poin default** per pertanyaan *(default 10)*.
  - **Maks. penjawab tercepat** (misal 5 = hanya 5 siswa tercepat yang bisa mengirim; 0 = tanpa batas).
  - Jawaban teman terlihat langsung / setelah pertanyaan ditutup (anti-mencontek).
  - Timer default pertanyaan.
- Kirim **pertanyaan** (poin & timer bisa diatur per soal) atau **pengumuman**.
- Jawaban diurutkan dari yang tercepat (🥇🥈🥉 + selisih detik). **Klik jawaban** untuk menandai benar (poin masuk) / salah — atau pakai tombol ✓ / ✗. Klik lagi untuk membatalkan.
- Tutup / buka lagi pertanyaan, ubah poin pertanyaan (otomatis menyesuaikan skor), hapus pertanyaan (poin ditarik kembali). Pertanyaan bertimer ditutup otomatis.
- Papan skor dengan indikator online, ubah poin manual (±), keluarkan siswa / pulihkan.
- **Layar Proyektor**: kode besar + QR code + papan skor teratas, mode layar penuh.
- Kunci room (tolak siswa baru), akhiri permainan, **unduh rekap nilai CSV** (bisa dibuka di Excel).
- Mode gelap/terang dan tampilan responsif (HP, tablet, laptop).

---

## 🚀 Cara Setup

### 1. Buat proyek Firebase
1. Buka <https://console.firebase.google.com> → **Add project**.
2. Di **Build → Authentication → Sign-in method**, aktifkan:
   - **Email/Password** (untuk guru)
   - **Anonymous** (untuk siswa)
3. Di **Build → Firestore Database** → **Create database** (mode production, pilih lokasi misal `asia-southeast2` Jakarta).
4. Di **Project settings → General → Your apps** → tambahkan **Web app** (`</>`), lalu salin konfigurasinya.

### 2. Isi konfigurasi
Buka `assets/js/firebase-config.js` dan ganti nilai `GANTI_...` dengan konfigurasi proyek Anda.

### 3. Pasang aturan keamanan
Salin isi `firestore.rules` ke **Firestore → Rules** lalu **Publish**, atau deploy dengan Firebase CLI:
```bash
firebase deploy --only firestore:rules
```

### 4. Buat akun guru
Akun guru dibuat oleh admin di **Authentication → Users → Add user** (email + password). Setiap guru yang login otomatis punya profil; nama tampilan bisa diubah dari dashboard.

### 5. Jalankan
Aplikasi **harus dibuka lewat http/https** (bukan klik ganda file `.html`), karena modul JavaScript dan Firebase Auth tidak berjalan di `file://`.

Uji di komputer sendiri:
```bash
npx serve .
```
lalu buka `http://localhost:3000`. Pastikan `localhost` ada di **Authentication → Settings → Authorized domains** (biasanya sudah ada).

Online-kan dengan Firebase Hosting:
```bash
npm install -g firebase-tools
firebase login
firebase use --add
firebase deploy
```

---

## 🗂️ Struktur Proyek
```
index.html          Halaman awal siswa (gabung room)
kelas.html          Ruang kuis siswa (chat + papan skor)
guru.html           Login & dashboard guru
guru-room.html      Kelola room (pertanyaan, penilaian, pengaturan, skor)
assets/css/style.css
assets/js/firebase-config.js   ← isi konfigurasi Firebase di sini
assets/js/common.js            Inisialisasi Firebase & fungsi bersama
assets/js/siswa-join.js / siswa-room.js / guru.js / guru-room.js
firestore.rules     Aturan keamanan Firestore
firebase.json       Konfigurasi Firebase Hosting & Rules
```

## 🧱 Struktur Data Firestore
```
teachers/{uid}                      displayName, email
rooms/{kode4digit}                  code, name, ownerUid, ownerName, status(open|locked|ended), settings{...}
rooms/{kode}/players/{uid}          name, kelas, rombel, kelasLabel, score, kicked, lastSeen
rooms/{kode}/messages/{id}          type(question|info), number, text, points, status(open|closed),
                                    deadline, responders[], answerCount
rooms/{kode}/answers/{id}           questionId, uid, name, text, status(pending|correct|wrong), points
```

Aturan mode jawaban dan batas "N tercepat" tidak hanya dicek di aplikasi, tapi juga di **Firestore Rules**. Siswa mengambil slot dalam satu transaksi, jadi batas tetap berlaku walau banyak siswa mengirim di detik yang sama.

---

Development by **Andri Fernanda, S.Pd., Gr.** © 2026
