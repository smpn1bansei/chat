// =============================================================
//  EDUCHAT — Bank soal & editor pilihan ganda (dipakai dashboard & room guru)
// =============================================================
import { db, $, $$, esc, toast, friendlyError, fmtTimer, LETTERS } from "./common.js";
import {
  collection, doc, addDoc, updateDoc, deleteDoc, serverTimestamp, onSnapshot, query, orderBy
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export const bankCol = uid => collection(db, "teachers", uid, "bank");

export function listenBank(uid, cb) {
  return onSnapshot(query(bankCol(uid), orderBy("createdAt", "desc")), snap => {
    cb(snap.docs.map(d => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) })));
  }, e => toast(friendlyError(e), "error"));
}

export async function deleteBankItem(uid, id) {
  await deleteDoc(doc(db, "teachers", uid, "bank", id));
}

/** Simpan soal ke bank (id = null → soal baru) */
export async function saveBankItem(uid, id, data) {
  const clean = {
    kind: data.kind === "mc" ? "mc" : "text",
    text: data.text,
    options: data.kind === "mc" ? data.options : [],
    correct: data.kind === "mc" ? data.correct : null,
    points: data.points || null,
    timer: data.timer || 0,
    tag: (data.tag || "").trim(),
    updatedAt: serverTimestamp()
  };
  if (id) await updateDoc(doc(db, "teachers", uid, "bank", id), clean);
  else await addDoc(bankCol(uid), { ...clean, createdAt: serverTimestamp() });
}

// ---------- Editor opsi pilihan ganda ----------
/**
 * Pasang editor opsi A–F di dalam `el`.
 * get() → { options, correct, error } dengan opsi kosong sudah dibuang.
 */
export function optionEditor(el, { options = ["", "", "", ""], correct = null } = {}) {
  const name = "opt" + Math.random().toString(36).slice(2, 8);
  let opts = options.length >= 2 ? [...options] : ["", "", "", ""];
  let key = correct;

  function render() {
    el.innerHTML = `<div class="opt-grid">${opts.map((o, i) => `
      <label class="opt-row ${key === i ? "is-key" : ""}" title="Pilih sebagai jawaban benar">
        <input type="radio" name="${name}" value="${i}" ${key === i ? "checked" : ""}>
        <span class="opt-letter">${LETTERS[i]}</span>
        <input type="text" class="opt-text" data-i="${i}" maxlength="200" placeholder="Opsi ${LETTERS[i]}" value="${esc(o)}">
        ${opts.length > 2 ? `<button type="button" class="opt-del" data-del="${i}" aria-label="Hapus opsi">✕</button>` : ""}
      </label>`).join("")}</div>
      <div class="opt-foot">
        ${opts.length < LETTERS.length ? `<button type="button" class="btn btn-ghost btn-sm" data-add>＋ Opsi</button>` : ""}
        <span class="hint" style="margin:0">Klik bulatan untuk menandai <b>kunci jawaban</b>.</span>
      </div>`;
    $$(".opt-text", el).forEach(inp => inp.oninput = () => { opts[+inp.dataset.i] = inp.value; });
    $$(`input[name="${name}"]`, el).forEach(r => r.onchange = () => {
      key = +r.value;
      $$(".opt-row", el).forEach((row, i) => row.classList.toggle("is-key", i === key));
    });
    $$("[data-del]", el).forEach(b => b.onclick = e => {
      e.preventDefault();
      const i = +b.dataset.del;
      opts.splice(i, 1);
      if (key === i) key = null; else if (key > i) key--;
      render();
    });
    const add = $("[data-add]", el);
    if (add) add.onclick = () => { opts.push(""); render(); $$(".opt-text", el).at(-1)?.focus(); };
  }
  render();

  return {
    get() {
      const filled = [];
      let newKey = null;
      opts.forEach((o, i) => {
        const t = o.trim();
        if (!t) return;
        if (i === key) newKey = filled.length;
        filled.push(t);
      });
      let error = null;
      if (filled.length < 2) error = "Pilihan ganda minimal 2 opsi terisi.";
      else if (newKey === null) error = "Tandai kunci jawaban (klik bulatan di samping opsi yang benar).";
      return { options: filled, correct: newKey, error };
    },
    set(o, c) { opts = o?.length >= 2 ? [...o] : ["", "", "", ""]; key = c ?? null; render(); },
    reset() { this.set(["", "", "", ""], null); }
  };
}

// ---------- Modal tambah/edit soal bank ----------
const TIMERS = [0, 15, 30, 60, 90, 120, 300];

export function openBankEditor(uid, item = null) {
  return new Promise(resolve => {
    const back = document.createElement("div");
    back.className = "modal-back show";
    const kind0 = item?.kind || "text";
    back.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h3 class="modal-title" style="margin:0">${item ? "✏️ Edit Soal" : "📚 Tambah Soal ke Bank"}</h3>
        <button class="btn btn-ghost btn-icon btn-sm" data-x aria-label="Tutup">✕</button>
      </div>
      <form novalidate>
        <div class="field"><span>Jenis soal</span>
          <div class="seg" data-kind>
            <button type="button" data-v="text" class="${kind0 === "text" ? "active" : ""}">✍️ Isian (dinilai guru)</button>
            <button type="button" data-v="mc" class="${kind0 === "mc" ? "active" : ""}">🔘 Pilihan Ganda (otomatis)</button>
          </div>
        </div>
        <label class="field"><span>Pertanyaan</span>
          <textarea name="text" rows="3" maxlength="1000" required placeholder="Tulis pertanyaan…">${esc(item?.text || "")}</textarea>
        </label>
        <div class="field mc-only"><span>Opsi jawaban</span><div data-opts></div></div>
        <div class="settings-grid">
          <label class="field"><span>Poin</span>
            <input name="points" type="number" min="1" max="1000" placeholder="Ikuti default room" value="${item?.points || ""}">
          </label>
          <label class="field"><span>Timer</span>
            <select name="timer">${TIMERS.map(t => `<option value="${t}" ${(item?.timer || 0) === t ? "selected" : ""}>${fmtTimer(t)}</option>`).join("")}</select>
          </label>
        </div>
        <label class="field"><span>Label / Bab <small class="muted">(opsional, untuk mencari)</small></span>
          <input name="tag" maxlength="40" placeholder="cth. IPA Bab 3" value="${esc(item?.tag || "")}">
        </label>
        <div class="modal-actions">
          <button type="button" class="btn btn-ghost" data-x>Batal</button>
          <button type="submit" class="btn btn-primary">💾 Simpan</button>
        </div>
      </form>
    </div>`;
    document.body.appendChild(back);

    let kind = kind0;
    const ed = optionEditor($("[data-opts]", back), { options: item?.options, correct: item?.correct });
    const syncKind = () => $$(".mc-only", back).forEach(x => x.classList.toggle("hidden", kind !== "mc"));
    syncKind();
    $$("[data-kind] button", back).forEach(b => b.onclick = () => {
      kind = b.dataset.v;
      $$("[data-kind] button", back).forEach(x => x.classList.toggle("active", x === b));
      syncKind();
    });

    const close = val => { back.remove(); document.removeEventListener("keydown", onKey); resolve(val); };
    const onKey = e => { if (e.key === "Escape") close(null); };
    document.addEventListener("keydown", onKey);
    $$("[data-x]", back).forEach(b => b.onclick = () => close(null));
    setTimeout(() => $("textarea", back).focus(), 30);

    $("form", back).onsubmit = async e => {
      e.preventDefault();
      const f = e.target;
      const text = f.text.value.trim();
      if (!text) return toast("Pertanyaan wajib diisi.", "error");
      const points = f.points.value ? Math.round(Number(f.points.value)) : null;
      if (points !== null && !(points >= 1 && points <= 1000)) return toast("Poin harus 1–1000.", "error");
      const data = { kind, text, points, timer: Number(f.timer.value), tag: f.tag.value };
      if (kind === "mc") {
        const o = ed.get();
        if (o.error) return toast(o.error, "error");
        Object.assign(data, { options: o.options, correct: o.correct });
      }
      const btn = $('button[type="submit"]', back);
      btn.disabled = true;
      try {
        await saveBankItem(uid, item?.id || null, data);
        toast(item ? "Soal diperbarui." : "Soal disimpan ke bank.", "success");
        close(true);
      } catch (err) {
        toast(friendlyError(err), "error");
        btn.disabled = false;
      }
    };
  });
}

/** Kartu ringkas soal bank (HTML) */
export function bankItemHtml(it, actions) {
  return `<div class="bank-item">
    <div class="bank-main">
      <div class="bank-meta">
        <span class="badge ${it.kind === "mc" ? "badge-accent" : "badge-primary"}">${it.kind === "mc" ? "🔘 Pilihan Ganda" : "✍️ Isian"}</span>
        ${it.points ? `<span class="badge">⭐ ${it.points}</span>` : ""}
        ${it.timer ? `<span class="badge">⏱ ${fmtTimer(it.timer)}</span>` : ""}
        ${it.tag ? `<span class="badge">🏷 ${esc(it.tag)}</span>` : ""}
      </div>
      <div class="bank-text">${esc(it.text)}</div>
      ${it.kind === "mc" ? `<div class="bank-opts">${(it.options || []).map((o, i) =>
        `<span class="${i === it.correct ? "key" : ""}">${LETTERS[i]}. ${esc(o)}</span>`).join("")}</div>` : ""}
    </div>
    <div class="bank-actions">${actions}</div>
  </div>`;
}

export function filterBank(items, q, tag = "") {
  q = (q || "").trim().toLowerCase();
  return items.filter(it =>
    (!tag || (it.tag || "") === tag) &&
    (!q || [it.text, it.tag, ...(it.options || [])].some(v => String(v || "").toLowerCase().includes(q))));
}

// ---------- Daftar bank soal: cari + filter label + paginasi ----------
export const BANK_PER_PAGE = 20;
const NO_TAG = "\u0000tanpa-label";

/**
 * Pasang daftar bank soal berhalaman.
 * actions(item) → HTML tombol aksi; emptyHtml(totalAll) → HTML saat kosong.
 * Mengembalikan { setItems(items), render() }.
 */
export function bankBrowser({ listEl, searchEl, tagEl, pagerEl, actions, emptyHtml, perPage = BANK_PER_PAGE }) {
  let items = [], page = 1;

  function fillTags() {
    const cur = tagEl.value;
    const tags = [...new Set(items.map(it => it.tag || NO_TAG))]
      .sort((a, b) => a === NO_TAG ? 1 : b === NO_TAG ? -1 : a.localeCompare(b, "id"));
    tagEl.innerHTML = `<option value="">🏷 Semua label (${items.length})</option>` + tags.map(t => {
      const n = items.filter(it => (it.tag || NO_TAG) === t).length;
      return `<option value="${esc(t)}">${t === NO_TAG ? "Tanpa label" : esc(t)} (${n})</option>`;
    }).join("");
    tagEl.value = tags.includes(cur) ? cur : "";
  }

  function render() {
    const tag = tagEl.value;
    const list = tag === NO_TAG
      ? filterBank(items.filter(it => !it.tag), searchEl.value)
      : filterBank(items, searchEl.value, tag);
    const pages = Math.max(1, Math.ceil(list.length / perPage));
    page = Math.min(Math.max(1, page), pages);
    const from = (page - 1) * perPage;
    const slice = list.slice(from, from + perPage);

    listEl.innerHTML = slice.length ? slice.map(it => bankItemHtml(it, actions(it))).join("") : emptyHtml(items.length);
    pagerEl.classList.toggle("hidden", list.length <= perPage);
    pagerEl.innerHTML = `
      <button type="button" class="btn btn-ghost btn-sm" data-page="${page - 1}" ${page <= 1 ? "disabled" : ""}>‹ <span class="hide-xs">Sebelumnya</span></button>
      <span class="pager-info"><b>${from + 1}–${from + slice.length}</b> dari ${list.length} soal · hal. ${page}/${pages}</span>
      <button type="button" class="btn btn-ghost btn-sm" data-page="${page + 1}" ${page >= pages ? "disabled" : ""}><span class="hide-xs">Berikutnya</span> ›</button>`;
  }

  searchEl.addEventListener("input", () => { page = 1; render(); });
  tagEl.addEventListener("change", () => { page = 1; render(); });
  pagerEl.addEventListener("click", e => {
    const b = e.target.closest("[data-page]");
    if (!b || b.disabled) return;
    page = Number(b.dataset.page);
    render();
    listEl.scrollIntoView({ block: "start", behavior: "smooth" });
  });

  return {
    setItems(list) { items = list; fillTags(); render(); },
    render
  };
}
