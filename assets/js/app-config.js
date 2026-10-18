// =============================================================
//  KONFIGURASI APLIKASI — EDUCHAT
//  Ubah `version` setiap ada pembaruan, misal "1.0" → "1.1".
//  Nilai ini otomatis tampil di judul brand & footer semua halaman.
// =============================================================
export const APP = {
  name: "Educhat",
  version: "1.0",
  releaseDate: "2026-10-18",
  developer: "Andri Fernanda, S.Pd., Gr.",
  contact: "smpn01bandarseikijang@gmail.com",
  year: 2026
};

/** "Educhat v.1.0" */
export const appTitle = () => `${APP.name} v.${APP.version}`;

/** Isi semua elemen penanda versi di halaman */
export function applyAppInfo(root = document) {
  root.querySelectorAll("[data-app-title]").forEach(el => { el.textContent = appTitle(); });
  root.querySelectorAll("[data-app-version]").forEach(el => { el.textContent = `v.${APP.version}`; });
  root.querySelectorAll("[data-app-developer]").forEach(el => { el.textContent = APP.developer; });
  root.querySelectorAll("[data-app-year]").forEach(el => { el.textContent = APP.year; });
  root.querySelectorAll("[data-app-contact]").forEach(el => {
    el.textContent = APP.contact;
    if (el.tagName === "A") el.href = `mailto:${APP.contact}`;
  });
}
