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
  $("flowTable").innerHTML = flowRows(vault.flows);
  $("recent").innerHTML = flowRows(flowsFor(selectedMonth), 6);
}

function flowRows(arr, limit) {
  const sorted = [...arr].sort((a, b) => b.date.localeCompare(a.date));
  if (!sorted.length) return '<div class="empty">Aucun mouvement à afficher.</div>';
  return `
    <div style="overflow-x:auto">
      <table>
        <thead>
          <tr>
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
              <td>${safe(f.date)}</td>
              <td><span class="pill ${f.type}">${f.type === "in" ? "Recette" : "Dépense"}</span></td>
              <td>${safe(f.category)}</td>
              <td>${safe(f.label || "—")}</td>
              <td class="num ${f.type === "in" ? "green" : "red"}">
                ${f.type === "in" ? "+" : "−"}${money(f.amount)}
              </td>
              <td>
                <button class="danger" style="padding:5px 8px" data-del-flow="${safe(f.id)}" aria-label="Supprimer">×</button>
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
  let totals = { in: 0, out: 0 };
  const rows = months.map((m) => {
    const r = recurringFor(m);
    totals.in += r.in;
    totals.out += r.out;
    return { m, ...r };
  });
  $("forecastMetrics").innerHTML = [
    ["Recettes prévues", money(totals.in), "green"],
    ["Dépenses prévues", money(totals.out), "red"],
    ["Solde prévisionnel", money(totals.in - totals.out), totals.in >= totals.out ? "green" : "red"],
    ["Moyenne mensuelle", money((totals.out - totals.in) / n), "amber"]
  ].map((x) => `
    <div class="card metric">
      <small>${x[0]}</small>
      <strong class="${x[2]}">${x[1]}</strong>
      <em>${x[0] === "Moyenne mensuelle" ? "Sorties nettes moyennes" : n + " mois cumulés"}</em>
    </div>
  `).join("");
  $("forecastTable").innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Mois</th>
          <th style="text-align:right">Recettes prévues</th>
          <th style="text-align:right">Dépenses prévues</th>
          <th style="text-align:right">Solde prévu</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((r) => `
          <tr>
            <td style="text-transform:capitalize">${monthLabel(r.m)}</td>
            <td class="num green">${money(r.in)}</td>
            <td class="num red">${money(r.out)}</td>
            <td class="num ${(r.in - r.out) >= 0 ? "green" : "red"}">${money(r.in - r.out)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
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
            const dateObj = new Date(date);
            if (isNaN(dateObj.getTime())) return null;
            normalizedDate = dateObj.toISOString().slice(0, 10);
          } catch {
            return null;
          }

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
        selectedMonth = monthNow();
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

  $("addFlow").onclick = () => $("flowForm").classList.remove("hidden");
  $("cancelFlow").onclick = () => $("flowForm").classList.add("hidden");
  $("saveFlow").onclick = () => {
    const date = $("fDate").value;
    const amount = Number($("fAmount").value);
    if (!date || !Number.isFinite(amount) || amount <= 0) {
      alert("Date et montant positif requis.");
      return;
    }
    vault.flows.push({
      id: uid(),
      date,
      type: $("fType").value,
      amount: Math.round(amount * 100) / 100,
      category: $("fCategory").value,
      label: $("fLabel").value.trim(),
      recurrence: $("fRecurring").value || null
    });
    $("fAmount").value = "";
    $("fLabel").value = "";
    $("flowForm").classList.add("hidden");
    renderAll();
  };

  $("flowTable").onclick = (e) => {
    const b = e.target.closest("[data-del-flow]");
    if (b && confirm("Supprimer ce mouvement de la mémoire de travail ?")) {
      vault.flows = vault.flows.filter((f) => f.id !== b.dataset.delFlow);
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
      renderAll();
      $("importExcelModal").classList.add("hidden");
      alert(`Succès : ${excelDataPreview.length} mouvements importés.`);
    }
  };

  // Initialisation
  showUnlock();
});