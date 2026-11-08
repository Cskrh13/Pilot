"use strict";

// ========== CONSTANTES ET VARIABLES GLOBALES ==========
const $ = (id) => document.getElementById(id);
let vault = null;
let selectedMonth = new Date().toISOString().slice(0, 7);
let categories = [
  "Logement", "Alimentation", "Santé", "Banque", "Transports",
  "Mutuelle", "Téléphonie", "Assurances", "Voiture", "Maison",
  "Restaurants", "Loisirs", "Épargne", "Revenus", "Autre"
];
let excelDataPreview = [];

// ========== FONCTIONS UTILITAIRES ==========
const enc = new TextEncoder();
const dec = new TextDecoder();
const money = (n) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(Number(n) || 0);
const monthNow = () => new Date().toISOString().slice(0, 7);
const latestFlowMonth = (data) => {
  const dates = (data?.flows || []).map(f => String(f.date || "").slice(0, 7)).filter(m => /^\d{4}-\d{2}$/.test(m));
  return dates.sort().at(-1) || null;
};

// Convertit les dates Excel (numéros de série) et répare les anciennes dates
// dont le numéro de série avait été interprété comme une année très éloignée.
function normalizeFlowDate(value) {
  if (typeof value === "number" || (typeof value === "string" && /^\d{5}(?:\.0+)?$/.test(value.trim()))) {
    const serial = Number(value);
    if (window.XLSX?.SSF?.parse_date_code) {
      const d = XLSX.SSF.parse_date_code(serial);
      if (d) return `${String(d.y).padStart(4, "0")}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
    }
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  const raw = String(value ?? "").trim();
  const broken = raw.match(/^\+?0*(\d{5})-(\d{2})-(\d{2})$/);
  if (broken) return normalizeFlowDate(Number(broken[1]));
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return raw;
  const fr = raw.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})$/);
  if (fr) return `${fr[3]}-${fr[2].padStart(2, "0")}-${fr[1].padStart(2, "0")}`;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString().slice(0, 10);
}

function uid() {
  return crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
}

function monthAdd(ym, n) {
  let [y, m] = ym.split("-").map(Number);
  let d = new Date(y, m - 1 + n, 1);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}

function monthLabel(ym) {
  return new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" }).format(new Date(ym + "-01T12:00:00"));
}

function safe(s) {
  return String(s ?? "").replace(/[&<>\"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}

function blankVault() {
  return { version: 2, createdAt: new Date().toISOString(), flows: [], recurrences: [], categories: [...categories] };
}

// ========== CHIFFREMENT ==========
async function deriveKey(password, salt) {
  return crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"])
    .then(k => crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: 310000, hash: "SHA-256" },
      k,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    ));
}

function b64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function un64(s) {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function encryptVault(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(JSON.stringify(vault))
  );
  return {
    app: "PILOT",
    format: 2,
    kdf: "PBKDF2-SHA-256",
    iterations: 310000,
    cipher: "AES-256-GCM",
    salt: b64(salt),
    iv: b64(iv),
    data: b64(cipher),
    categories: vault.categories
  };
}

async function decryptVault(obj, password) {
  if (obj.app !== "PILOT" || (obj.format !== 1 && obj.format !== 2)) {
    throw new Error("Format de coffre non reconnu.");
  }
  const key = await deriveKey(password, un64(obj.salt));
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: un64(obj.iv) },
    key,
    un64(obj.data)
  );
  const v = JSON.parse(dec.decode(plain));
  if (!Array.isArray(v.flows) || !Array.isArray(v.recurrences)) {
    throw new Error("Structure de données invalide.");
  }
  v.recurrences = Array.isArray(v.recurrences) ? v.recurrences : [];
  v.flows = Array.isArray(v.flows) ? v.flows : [];
  v.flows.forEach(flow => { flow.date = normalizeFlowDate(flow.date); });
  // Compatibilité : les anciennes versions stockaient la fréquence sur le flux sans créer de règle.
  v.flows.forEach(flow => {
    if (!flow.recurrence || !flow.date || v.recurrences.some(r => r.sourceFlowId === flow.id)) return;
    v.recurrences.push({
      id: uid(), sourceFlowId: flow.id, type: flow.type, amount: Number(flow.amount) || 0,
      category: flow.category || "Autre", label: flow.label || "", freq: flow.recurrence,
      day: Math.min(28, Math.max(1, Number(flow.date.slice(8, 10)) || 1)),
      start: flow.date.slice(0, 7), end: null, active: true
    });
  });
  if (obj.categories && Array.isArray(obj.categories)) {
    categories = [...new Set([...categories, ...obj.categories])];
  } else if (v.categories) {
    categories = [...new Set([...categories, ...v.categories])];
  }
  return v;
}

// ========== GESTION DE L'INTERFACE ==========
function showUnlock(msg = "") {
  $("unlock").classList.remove("hidden");
  $("app").classList.add("hidden");
  $("unlockMsg").textContent = msg;
}

function showApp() {
  $("unlock").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("monthPick").value = selectedMonth;
  renderAll();
  renderCategoryList();
}

function tab(name) {
  document.querySelectorAll(".nav button").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === name);
  });
  ["overview", "flows", "recurring", "forecast", "categories"].forEach((t) => {
    $(`tab-${t}`).classList.toggle("hidden", t !== name);
  });
}

// ========== GESTION DES FLUX ==========
function flowsFor(ym) {
  return vault.flows.filter((f) => f.date.slice(0, 7) === ym);
}

function sum(arr, type) {
  return arr.filter((x) => x.type === type).reduce((s, x) => s + Number(x.amount), 0);
}

function renderFlows() {
  $("flowCount").textContent = vault.flows.length + " mouvement(s)";
  $("flowTable").innerHTML = flowRows(vault.flows, undefined, true);
  $("recent").innerHTML = flowRows(flowsFor(selectedMonth), 6, false);
  const bulkButton = $("deleteSelectedFlows");
  if (bulkButton) bulkButton.disabled = true;
  const selectAllButton = $("selectAllFlows");
  if (selectAllButton) selectAllButton.textContent = "Tout sélectionner";
  const deleteAllButton = $("deleteAllFlows");
  if (deleteAllButton) deleteAllButton.disabled = vault.flows.length === 0;
}

function flowRows(arr, limit, selectable = false) {
  const sorted = [...arr].sort((a, b) => b.date.localeCompare(a.date));
  if (!sorted.length) return '<div class="empty">Aucun mouvement à afficher.</div>';
  return `
    <div style="overflow-x:auto">
      <table>
        <thead>
          <tr>
            ${selectable ? '<th><input type="checkbox" id="toggleVisibleFlows" aria-label="Sélectionner les mouvements affichés"></th>' : ''}
            <th>Date</th>
            <th>Nature</th>
            <th>Catégorie</th>
            <th>Libellé</th>
            <th style="text-align:right">Montant</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${sorted.slice(0, limit || sorted.length).map((f) => `
            <tr>
              ${selectable ? `<td><input type="checkbox" class="flow-select" data-flow-id="${safe(f.id)}" aria-label="Sélectionner ce mouvement"></td>` : ''}
              <td>${safe(normalizeFlowDate(f.date))}</td>
              <td><span class="pill ${f.type}">${f.type === "in" ? "Recette" : "Dépense"}</span></td>
              <td>${safe(f.category)}</td>
              <td>${safe(f.label || "—")}</td>
              <td class="num ${f.type === "in" ? "green" : "red"}">
                ${f.type === "in" ? "+" : "−"}${money(f.amount)}
              </td>
              <td class="flow-row-actions">${selectable ? `
                <button class="secondary" style="padding:5px 8px" data-edit-flow="${safe(f.id)}" aria-label="Modifier">Modifier</button>
                <button class="danger" style="padding:5px 8px" data-del-flow="${safe(f.id)}" aria-label="Supprimer">×</button>` : ""}
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

// ========== GESTION DES RÉCURRENCES ==========
function due(rule, ym) {
  if (ym < rule.start || (rule.end && ym > rule.end)) return false;
  let diff = (Number(ym.slice(0, 4)) - Number(rule.start.slice(0, 4))) * 12 +
             (Number(ym.slice(5, 7)) - Number(rule.start.slice(5, 7)));
  return rule.freq === "monthly" ||
         (rule.freq === "quarterly" && diff % 3 === 0) ||
         (rule.freq === "yearly" && diff % 12 === 0);
}

function recurringFor(ym) {
  let result = { in: 0, out: 0 };
  vault.recurrences.filter((r) => r.active !== false && due(r, ym)).forEach((r) => {
    result[r.type] += Number(r.amount);
  });
  return result;
}

function renderRules() {
  if (!vault.recurrences.length) {
    $("ruleList").innerHTML = '<div class="empty">Aucun engagement récurrent défini.</div>';
    return;
  }
  $("ruleList").innerHTML = vault.recurrences.map((r) => `
    <div class="listitem">
      <div>
        <strong>${safe(r.label || r.category)} <span class="pill ${r.type}">${r.type === "in" ? "Recette" : "Dépense"}</span></strong>
        <small>
          ${safe(r.category)} ·
          ${r.freq === "monthly" ? "Mensuelle" : r.freq === "quarterly" ? "Trimestrielle" : "Annuelle"} ·
          jour ${r.day} ·
          depuis ${safe(r.start)}${r.end ? " · jusqu'à " + safe(r.end) : ""}
        </small>
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        <strong>${money(r.amount)}</strong>
        <button class="danger" data-del-rule="${safe(r.id)}">Supprimer</button>
      </div>
    </div>
  `).join("");
}

// ========== GESTION DES PRÉVISIONS ==========
function renderForecast() {
  const n = Number($("horizon").value);
  const months = Array.from({ length: n }, (_, i) => monthAdd(selectedMonth, i));
  let totals = { actualIn: 0, actualOut: 0, plannedIn: 0, plannedOut: 0 };
  const rows = months.map((m) => {
    const planned = recurringFor(m);
    const actual = flowsFor(m);
    const actualIn = sum(actual, "in");
    const actualOut = sum(actual, "out");
    totals.actualIn += actualIn; totals.actualOut += actualOut;
    totals.plannedIn += planned.in; totals.plannedOut += planned.out;
    return { m, actualIn, actualOut, plannedIn: planned.in, plannedOut: planned.out };
  });
  $("forecastMetrics").innerHTML = [
    ["Recettes enregistrées", money(totals.actualIn), "green"],
    ["Dépenses enregistrées", money(totals.actualOut), "red"],
    ["Recettes récurrentes prévues", money(totals.plannedIn), "green"],
    ["Dépenses récurrentes prévues", money(totals.plannedOut), "amber"]
  ].map((x) => `
    <div class="card metric"><small>${x[0]}</small><strong class="${x[2]}">${x[1]}</strong><em>${n} mois affichés</em></div>
  `).join("");
  $("forecastTable").innerHTML = `
    <div style="overflow-x:auto"><table>
      <thead><tr>
        <th>Mois</th><th style="text-align:right">Recettes enregistrées</th>
        <th style="text-align:right">Dépenses enregistrées</th>
        <th style="text-align:right">Recettes prévues</th>
        <th style="text-align:right">Dépenses prévues</th>
        <th style="text-align:right">Solde prévisionnel</th>
      </tr></thead><tbody>
        ${rows.map((r) => `
          <tr><td style="text-transform:capitalize">${monthLabel(r.m)}</td>
          <td class="num green">${money(r.actualIn)}</td><td class="num red">${money(r.actualOut)}</td>
          <td class="num green">${money(r.plannedIn)}</td><td class="num red">${money(r.plannedOut)}</td>
          <td class="num ${(r.actualIn + r.plannedIn - r.actualOut - r.plannedOut) >= 0 ? "green" : "red"}">${money(r.actualIn + r.plannedIn - r.actualOut - r.plannedOut)}</td></tr>
        `).join("")}
      </tbody></table></div>
    <p class="small muted">Les mouvements enregistrés sont affichés séparément des récurrences prévues. Le solde prévisionnel additionne les deux sans modifier l'historique.</p>
  `;
}

// ========== GESTION DES CATÉGORIES ==========
function renderCategoryList() {
  const categoryList = $("categoryList");
  if (!categories.length) {
    categoryList.innerHTML = '<div class="empty">Aucune catégorie définie.</div>';
    return;
  }
  categoryList.innerHTML = categories.map((cat) => `
    <div class="barrow" style="grid-template-columns: 1fr auto auto; gap: 10px;">
      <span>${safe(cat)}</span>
      <button class="secondary" data-edit-category="${safe(cat)}" style="padding: 5px 10px;">Renommer</button>
      <button class="danger" data-del-category="${safe(cat)}" style="padding: 5px 10px;">×</button>
    </div>
  `).join("");
}

function addCategory(name) {
  if (!name.trim() || categories.includes(name)) return false;
  categories.push(name);
  vault.categories = [...new Set(categories)];
  return true;
}

function renameCategory(oldName, newName) {
  if (!newName.trim() || categories.includes(newName) || oldName === newName) return false;
  const index = categories.indexOf(oldName);
  if (index === -1) return false;

  vault.flows.forEach((flow) => {
    if (flow.category === oldName) flow.category = newName;
  });

  vault.recurrences.forEach((recurrence) => {
    if (recurrence.category === oldName) recurrence.category = newName;
  });

  categories[index] = newName;
  vault.categories = [...new Set(categories)];
  return true;
}

function deleteCategory(name) {
  const isUsedInFlows = vault.flows.some((flow) => flow.category === name);
  const isUsedInRecurrences = vault.recurrences.some((recurrence) => recurrence.category === name);
  if (isUsedInFlows || isUsedInRecurrences) {
    alert(`Impossible de supprimer la catégorie "${name}" : elle est utilisée dans des flux ou récurrences. Renommez-la d'abord.`);
    return false;
  }

  categories = categories.filter((cat) => cat !== name);
  vault.categories = [...new Set(categories)];
  return true;
}

// ========== IMPORT EXCEL ==========
function parseExcelFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: "array" });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        const jsonData = XLSX.utils.sheet_to_json(firstSheet, { header: 1 });

        const headers = jsonData[0].map((h) => String(h).trim().toLowerCase());
        const rows = jsonData.slice(1);

        const requiredColumns = ["date", "type", "montant"];
        const hasRequiredColumns = requiredColumns.every((col) =>
          headers.some((h) => h.includes(col))
        );
        if (!hasRequiredColumns) {
          reject(new Error("Le fichier doit contenir au moins les colonnes : Date, Type, Montant."));
          return;
        }

        const parsedData = rows.map((row) => {
          const rowObj = {};
          headers.forEach((header, i) => {
            rowObj[header] = row[i];
          });

          const date = rowObj.date ? String(rowObj.date).trim() : "";
          const type = rowObj.type ? String(rowObj.type).trim().toLowerCase() : "";
          const amount = rowObj.montant ? parseFloat(String(rowObj.montant).replace(",", ".")) : 0;
          const category = rowObj.catégorie ? String(rowObj.catégorie).trim() : "Autre";
          const label = rowObj.libellé ? String(rowObj.libellé).trim().slice(0, 32) : "";

          if (!date || !type || isNaN(amount) || amount <= 0) return null;

          let normalizedType;
          if (type.includes("dépense") || type.includes("out")) normalizedType = "out";
          else if (type.includes("recette") || type.includes("in")) normalizedType = "in";
          else return null;

          let normalizedDate;
          try {
            normalizedDate = normalizeFlowDate(rowObj.date);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDate) || Number.isNaN(Date.parse(normalizedDate + "T12:00:00"))) return null;
          } catch { return null; }

          let normalizedCategory = category;
          if (!categories.includes(normalizedCategory)) {
            categories.push(normalizedCategory);
            vault.categories = [...new Set(categories)];
          }

          return {
            id: uid(),
            date: normalizedDate,
            type: normalizedType,
            amount: Math.round(amount * 100) / 100,
            category: normalizedCategory,
            label: label || null,
            recurrence: null
          };
        }).filter((row) => row !== null);

        resolve(parsedData);
      } catch (error) {
        reject(new Error("Erreur lors de la lecture du fichier : " + error.message));
      }
    };
    reader.onerror = () => reject(new Error("Erreur lors de la lecture du fichier."));
    reader.readAsArrayBuffer(file);
  });
}

function showExcelPreview(data) {
  const preview = $("excelPreview");
  if (!data.length) {
    preview.innerHTML = "<p class='empty'>Aucune donnée valide à importer.</p>";
    return;
  }

  const table = document.createElement("table");
  table.innerHTML = `
    <thead>
      <tr>
        <th>Date</th>
        <th>Type</th>
        <th>Montant</th>
        <th>Catégorie</th>
        <th>Libellé</th>
      </tr>
    </thead>
    <tbody>
      ${data.slice(0, 10).map((row) => `
        <tr>
          <td>${row.date}</td>
          <td><span class="pill ${row.type}">${row.type === "in" ? "Recette" : "Dépense"}</span></td>
          <td class="num ${row.type === "in" ? "green" : "red"}">
            ${row.type === "in" ? "+" : "−"}${money(row.amount)}
          </td>
          <td>${safe(row.category)}</td>
          <td>${safe(row.label || "—")}</td>
        </tr>
      `).join("")}
      ${data.length > 10 ? `<tr><td colspan="5" class="muted small">... et ${data.length - 10} lignes supplémentaires</td></tr>` : ""}
    </tbody>
  `;
  preview.innerHTML = "";
  preview.appendChild(table);
}

// ========== RENDU GLOBAL ==========
function renderMetrics() {
  const fs = flowsFor(selectedMonth);
  const income = sum(fs, "in");
  const out = sum(fs, "out");
  const balance = income - out;
  const items = [
    ["Recettes", money(income), "Entrées du mois", "green"],
    ["Dépenses", money(out), "Sorties du mois", "red"],
    ["Solde mensuel", money(balance), "Recettes − dépenses", balance >= 0 ? "green" : "red"],
    ["Récurrences", money(recurringFor(selectedMonth).out), "Dépenses prévues", "amber"]
  ];
  $("metrics").innerHTML = items.map(([a, b, c, d]) => `
    <div class="card metric">
      <small>${a}</small>
      <strong class="${d}">${b}</strong>
      <em>${c}</em>
    </div>
  `).join("");
}

function renderBars() {
  const fs = flowsFor(selectedMonth).filter((f) => f.type === "out");
  const map = {};
  fs.forEach((f) => {
    map[f.category] = (map[f.category] || 0) + Number(f.amount);
  });
  const rows = Object.entries(map).sort((a, b) => b[1] - a[1]);
  if (!rows.length) {
    $("categoryBars").innerHTML = '<div class="empty">Aucune dépense enregistrée pour ce mois.</div>';
    return;
  }
  const max = rows[0][1];
  $("categoryBars").innerHTML = rows.map(([c, v]) => `
    <div class="barrow">
      <span>${safe(c)}</span>
      <div class="track">
        <div class="fill" style="width:${v / max * 100}%"></div>
      </div>
      <span class="amount">${money(v)}</span>
    </div>
  `).join("");
}

function renderInsight() {
  const fs = flowsFor(selectedMonth);
  const inc = sum(fs, "in");
  const out = sum(fs, "out");
  const bal = inc - out;
  const prev = flowsFor(monthAdd(selectedMonth, -1));
  const prevOut = sum(prev, "out");
  const delta = out - prevOut;
  const rec = recurringFor(selectedMonth);
  $("monthInsight").innerHTML = `
    <div class="listitem">
      <span>Solde après mouvements</span>
      <strong class="${bal >= 0 ? 'green' : 'red'}">${money(bal)}</strong>
    </div>
    <div class="listitem">
      <span>Dépenses vs mois précédent</span>
      <strong class="${delta <= 0 ? 'green' : 'red'}">${delta > 0 ? '+' : ''}${money(delta)}</strong>
    </div>
    <div class="listitem">
      <span>Engagements prévus</span>
      <strong>${money(rec.out)}</strong>
    </div>
    <div class="listitem">
      <span>Recettes récurrentes prévues</span>
      <strong class="green">${money(rec.in)}</strong>
    </div>
    <p class="small muted">Les prévisions et les mouvements réellement enregistrés restent séparés.</p>
  `;
}

function renderAll() {
  renderMetrics();
  renderBars();
  renderInsight();
  renderFlows();
  renderRules();
  renderForecast();
}

// ========== ÉCOUTEURS D'ÉVÉNEMENTS ==========
document.addEventListener("DOMContentLoaded", () => {
  // Navigation
  document.querySelectorAll(".nav button").forEach((b) => {
    b.addEventListener("click", () => tab(b.dataset.tab));
  });
  document.querySelectorAll("[data-goto]").forEach((b) => {
    b.addEventListener("click", () => tab(b.dataset.goto));
  });

  // Déverrouillage
  $("newVault").onclick = async () => {
    const p = $("pass").value;
    if (p.length < 16) {
      $("unlockMsg").textContent = "Utilise au moins 16 caractères pour la phrase secrète.";
      return;
    }
    if (!crypto?.subtle) {
      $("unlockMsg").textContent = "Web Crypto indisponible. Ouvre l'application depuis localhost (voir le guide).";
      return;
    }
    vault = blankVault();
    selectedMonth = monthNow();
    showApp();
    $("pass").value = "";
  };

  $("openVault").onclick = () => $("fileIn").click();
  $("importBtn").onclick = () => $("fileIn").click();
  $("fileIn").onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const p = $("pass").value;
    if (p.length < 16) {
      $("unlockMsg").textContent = "Saisis la phrase secrète (16 caractères minimum).";
      return;
    }
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const obj = JSON.parse(reader.result);
        vault = await decryptVault(obj, p);
        selectedMonth = latestFlowMonth(vault) || monthNow();
        $("pass").value = "";
        showApp();
      } catch (e) {
        $("unlockMsg").textContent = "Ouverture impossible : " +
          (e.message.includes("decrypt") ? "mot de passe incorrect ou fichier altéré." : e.message);
      }
    };
    reader.readAsText(file);
  };

  // Export
  $("exportBtn").onclick = async () => {
    try {
      const p = prompt("Phrase secrète du coffre (16 caractères minimum) :");
      if (!p) return;
      if (p.length < 16) throw new Error("16 caractères minimum.");
      const encrypted = await encryptVault(p);
      const blob = new Blob([JSON.stringify(encrypted, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `pilot-coffre-${monthNow()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert("Export impossible : " + e.message);
    }
  };

  // Fermeture
  $("closeBtn").onclick = () => {
    vault = null;
    showUnlock("Coffre fermé. Les données en mémoire ont été abandonnées.");
  };

  // Mois
  $("monthPick").onchange = (e) => {
    selectedMonth = e.target.value;
    renderAll();
  };
  $("prevMonth").onclick = () => {
    selectedMonth = monthAdd(selectedMonth, -1);
    $("monthPick").value = selectedMonth;
    renderAll();
  };
  $("nextMonth").onclick = () => {
    selectedMonth = monthAdd(selectedMonth, 1);
    $("monthPick").value = selectedMonth;
    renderAll();
  };

  // Flux
  function catOptions(id) {
    $(id).innerHTML = categories.map((c) => `<option>${safe(c)}</option>`).join("");
  }

  catOptions("fCategory");
  catOptions("rCategory");
  $("fDate").value = new Date().toISOString().slice(0, 10);
  $("rStart").value = monthNow();

  let editingFlowId = null;
  function openFlowForm(flow = null) {
    editingFlowId = flow?.id || null;
    $("flowFormTitle").textContent = flow ? "Modifier le mouvement" : "Nouveau mouvement";
    $("saveFlow").textContent = flow ? "Enregistrer les modifications" : "Ajouter au coffre en mémoire";
    $("fDate").value = flow ? normalizeFlowDate(flow.date) : new Date().toISOString().slice(0, 10);
    $("fType").value = flow?.type || "out";
    $("fAmount").value = flow?.amount ?? "";
    $("fCategory").value = flow?.category || categories[0];
    $("fLabel").value = flow?.label || "";
    $("fRecurring").value = flow?.recurrence || "";
    $("flowForm").classList.remove("hidden");
    $("flowForm").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  function syncFlowRecurrence(flow) {
    const rule = vault.recurrences.find(r => r.sourceFlowId === flow.id);
    if (!flow.recurrence) {
      if (rule) vault.recurrences = vault.recurrences.filter(r => r.sourceFlowId !== flow.id);
      return;
    }
    const data = {
      sourceFlowId: flow.id, type: flow.type, amount: flow.amount,
      category: flow.category, label: flow.label, freq: flow.recurrence,
      day: Math.min(28, Math.max(1, Number(flow.date.slice(8, 10)) || 1)),
      start: flow.date.slice(0, 7), end: null, active: true
    };
    if (rule) Object.assign(rule, data);
    else vault.recurrences.push({ id: uid(), ...data });
  }
  $("addFlow").onclick = () => openFlowForm();
  $("cancelFlow").onclick = () => { editingFlowId = null; $("flowForm").classList.add("hidden"); };
  $("saveFlow").onclick = () => {
    const date = $("fDate").value;
    const amount = Number($("fAmount").value);
    if (!date || !Number.isFinite(amount) || amount <= 0) {
      alert("Date et montant positif requis.");
      return;
    }
    const values = {
      date, type: $("fType").value,
      amount: Math.round(amount * 100) / 100,
      category: $("fCategory").value, label: $("fLabel").value.trim(),
      recurrence: $("fRecurring").value || null
    };
    let flow;
    if (editingFlowId) {
      flow = vault.flows.find(f => f.id === editingFlowId);
      if (!flow) { alert("Ce mouvement n'existe plus."); return; }
      Object.assign(flow, values);
    } else {
      flow = { id: uid(), ...values };
      vault.flows.push(flow);
    }
    syncFlowRecurrence(flow);
    selectedMonth = date.slice(0, 7);
    $("monthPick").value = selectedMonth;
    editingFlowId = null;
    $("fAmount").value = "";
    $("fLabel").value = "";
    $("flowForm").classList.add("hidden");
    renderAll();
  };

  function updateFlowSelectionUI() {
    const selected = document.querySelectorAll("#flowTable .flow-select:checked").length;
    const total = document.querySelectorAll("#flowTable .flow-select").length;
    $("deleteSelectedFlows").disabled = selected === 0;
    $("deleteSelectedFlows").textContent = selected ? `Supprimer la sélection (${selected})` : "Supprimer la sélection";
    const master = $("flowTable").querySelector("#toggleVisibleFlows");
    if (master) { master.checked = total > 0 && selected === total; master.indeterminate = selected > 0 && selected < total; }
    $("selectAllFlows").textContent = total > 0 && selected === total ? "Tout désélectionner" : "Tout sélectionner";
  }

  $("flowTable").addEventListener("change", (e) => {
    if (e.target.id === "toggleVisibleFlows") {
      $("flowTable").querySelectorAll(".flow-select").forEach(cb => cb.checked = e.target.checked);
    }
    updateFlowSelectionUI();
  });
  $("flowTable").onclick = (e) => {
    const edit = e.target.closest("[data-edit-flow]");
    if (edit) {
      const flow = vault.flows.find(f => f.id === edit.dataset.editFlow);
      if (flow) openFlowForm(flow);
      return;
    }
    const del = e.target.closest("[data-del-flow]");
    if (del && confirm("Supprimer ce mouvement de la mémoire de travail ?")) {
      const deletedId = del.dataset.delFlow;
      vault.flows = vault.flows.filter((f) => f.id !== deletedId);
      vault.recurrences = vault.recurrences.filter(r => r.sourceFlowId !== deletedId);
      renderAll();
    }
  };
  $("selectAllFlows").onclick = () => {
    const boxes = [...document.querySelectorAll("#flowTable .flow-select")];
    const allChecked = boxes.length > 0 && boxes.every(cb => cb.checked);
    boxes.forEach(cb => cb.checked = !allChecked);
    updateFlowSelectionUI();
  };
  $("deleteSelectedFlows").onclick = () => {
    const ids = new Set([...document.querySelectorAll("#flowTable .flow-select:checked")].map(cb => cb.dataset.flowId));
    if (!ids.size) return;
    if (confirm(`Supprimer définitivement ${ids.size} mouvement(s) de la mémoire de travail ?`)) {
      vault.flows = vault.flows.filter(f => !ids.has(f.id));
      vault.recurrences = vault.recurrences.filter(r => !ids.has(r.sourceFlowId));
      renderAll();
    }
  };
  $("deleteAllFlows").onclick = () => {
    if (!vault.flows.length) return;
    if (confirm(`Supprimer les ${vault.flows.length} mouvements du coffre ? Cette action ne peut pas être annulée.`)) {
      vault.flows = [];
      vault.recurrences = vault.recurrences.filter(r => !r.sourceFlowId);
      renderAll();
    }
  };

  // Récurrences
  $("addRule").onclick = () => $("ruleForm").classList.remove("hidden");
  $("cancelRule").onclick = () => $("ruleForm").classList.add("hidden");
  $("saveRule").onclick = () => {
    const amount = Number($("rAmount").value);
    const start = $("rStart").value;
    const day = Number($("rDay").value);
    const end = $("rEnd").value;
    if (!start || amount <= 0 || day < 1 || day > 28 || (end && end < start)) {
      alert("Vérifie le montant, les dates et le jour (1 à 28).");
      return;
    }
    vault.recurrences.push({
      id: uid(),
      type: $("rType").value,
      amount: Math.round(amount * 100) / 100,
      category: $("rCategory").value,
      label: $("rLabel").value.trim(),
      freq: $("rFreq").value,
      day,
      start,
      end: end || null,
      active: true
    });
    $("rAmount").value = "";
    $("rLabel").value = "";
    $("ruleForm").classList.add("hidden");
    renderAll();
  };

  $("ruleList").onclick = (e) => {
    const b = e.target.closest("[data-del-rule]");
    if (b && confirm("Supprimer cette récurrence ?")) {
      vault.recurrences = vault.recurrences.filter((r) => r.id !== b.dataset.delRule);
      renderAll();
    }
  };

  // Prévisions
  $("horizon").onchange = renderForecast;

  // Catégories
  $("addCategoryBtn").onclick = () => {
    $("modalTitle").textContent = "Ajouter une catégorie";
    $("newCategoryName").value = "";
    $("replaceCategoryField").style.display = "none";
    $("categoryModal").classList.remove("hidden");
  };

  $("categoryList").onclick = (e) => {
    const editBtn = e.target.closest("[data-edit-category]");
    const delBtn = e.target.closest("[data-del-category]");

    if (editBtn) {
      const oldName = editBtn.dataset.editCategory;
      $("modalTitle").textContent = "Renommer une catégorie";
      $("newCategoryName").value = oldName;
      const select = $("replaceCategorySelect");
      select.innerHTML = `<option value="${oldName}">${oldName}</option>`;
      $("replaceCategoryField").style.display = "block";
      $("categoryModal").classList.remove("hidden");
    }

    if (delBtn) {
      const name = delBtn.dataset.delCategory;
      if (confirm(`Supprimer la catégorie "${name}" ?`)) {
        deleteCategory(name);
        renderCategoryList();
        renderAll();
      }
    }
  };

  $("cancelCategory").onclick = () => {
    $("categoryModal").classList.add("hidden");
  };

  $("saveCategory").onclick = () => {
    const newName = $("newCategoryName").value.trim();
    if (!newName) {
      alert("Le nom de la catégorie ne peut pas être vide.");
      return;
    }

    const oldName = $("replaceCategorySelect").value;
    if ($("modalTitle").textContent === "Ajouter une catégorie") {
      if (addCategory(newName)) {
        renderCategoryList();
        catOptions("fCategory");
        catOptions("rCategory");
      } else {
        alert(`La catégorie "${newName}" existe déjà.`);
      }
    } else {
      if (renameCategory(oldName, newName)) {
        renderCategoryList();
        catOptions("fCategory");
        catOptions("rCategory");
        renderAll();
      } else {
        alert(`Impossible de renommer la catégorie. Vérifiez que le nouveau nom n'existe pas déjà.`);
      }
    }
    $("categoryModal").classList.add("hidden");
  };

  // Import Excel
  $("importExcelBtn").onclick = () => {
    excelDataPreview = [];
    $("excelPreview").innerHTML = "";
    $("excelFile").value = "";
    $("importExcelModal").classList.remove("hidden");
  };

  $("cancelExcelImport").onclick = () => {
    $("importExcelModal").classList.add("hidden");
  };

  $("excelFile").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    try {
      const parsedData = await parseExcelFile(file);
      excelDataPreview = parsedData;
      showExcelPreview(parsedData);
    } catch (error) {
      alert("Erreur : " + error.message);
      $("excelPreview").innerHTML = `<p class="red">${error.message}</p>`;
    }
  };

  $("confirmExcelImport").onclick = () => {
    if (!excelDataPreview.length) {
      alert("Aucune donnée valide à importer.");
      return;
    }

    if (confirm(`Importer ${excelDataPreview.length} mouvements ?`)) {
      vault.flows.push(...excelDataPreview);
      selectedMonth = latestFlowMonth(vault) || selectedMonth;
      $("monthPick").value = selectedMonth;
      renderAll();
      $("importExcelModal").classList.add("hidden");
      alert(`Succès : ${excelDataPreview.length} mouvements importés.`);
    }
  };

  // Initialisation
  showUnlock();
});