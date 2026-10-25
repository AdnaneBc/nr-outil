#!/usr/bin/env node
// Compare des captures tc_vars au plan WEBA et produit le fichier NR (vert/rouge) + le brouillon de mail.
//
// Usage :
//   node nr-compare.js --plan "Documentations WEBA - Plans de tracking.xlsx" \
//                      --perimetre NR_Boutique_precedente.xlsx \
//                      --captures captures.json \
//                      [--env PREPROD] [--titre "MEP du 28/10"] [--sortie NR_resultat.xlsx]
//                      [--variables site,univers,parcours,page]
//
// --variables : ne contrôler que ces variables (par défaut : toutes celles du plan).
// --perimetre : un ancien fichier NR (colonne A = numéros de ligne du plan) ou une liste "58,60,61".
"use strict";
const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const E = require("./nr-engine.js");

const VERT = "FF00B050", ROUGE = "FFFF0000", ORANGE = "FFFFC000";

function args() {
  const a = {}, v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) if (v[i].startsWith("--")) a[v[i].slice(2)] = v[i + 1] && !v[i + 1].startsWith("--") ? v[++i] : true;
  return a;
}

function cellVal(c) {
  const v = c.value;
  if (v == null) return null;
  if (typeof v === "object") {
    if (v.richText) return v.richText.map((t) => t.text).join("");
    if ("result" in v) return v.result;
    if (v.text) return typeof v.text === "string" ? v.text : v.text.richText.map((t) => t.text).join("");
    if (v.hyperlink) return v.hyperlink;
  }
  return v;
}

async function readRows(file, sheetName) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = sheetName ? wb.getWorksheet(sheetName) : wb.worksheets[0];
  if (!ws) throw new Error("Onglet introuvable : " + sheetName + " dans " + file);
  const n = Math.min(ws.columnCount, 60), out = [];
  ws.eachRow({ includeEmpty: true }, (r, i) => {
    const a = [];
    for (let c = 1; c <= n; c++) a.push(cellVal(r.getCell(c)));
    out[i - 1] = a;
  });
  return out;
}

async function readScope(p) {
  if (/\.xlsx$/i.test(p)) {
    const rows = await readRows(p);
    return rows.slice(1).map((r) => r && r[0]).filter((x) => x != null && String(x).trim() !== "").map((x) => String(x).trim());
  }
  return String(p).split(/[,;\s]+/).filter(Boolean);
}

function fill(cell, argb) {
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb } };
}

// opts : { plan, perimetre, captures (tableau ou chemin), env, variables, titre, sortie, log }
// Renvoie { res, sortie, mailFile, mail, compte }.
async function comparer(opts) {
  const log = opts.log || console.log;
  const planRows = await readRows(opts.plan, "Plan de Tracking - Pages");
  const plan = E.buildPlan(planRows);
  if (opts.env) {
    Object.values(plan.lines).forEach((l) => l.checks.forEach((c) => {
      if (c.path === "env") c.rule = { type: "exact", value: opts.env, label: opts.env };
    }));
  }
  if (opts.variables) {
    const keep = (Array.isArray(opts.variables) ? opts.variables : String(opts.variables).split(/[,;\s]+/)).filter(Boolean);
    Object.values(plan.lines).forEach((l) => { l.checks = l.checks.filter((c) => keep.indexOf(c.path) >= 0); });
    log("Variables contrôlées : " + keep.join(", "));
  }
  const scope = await readScope(opts.perimetre);
  const captures = Array.isArray(opts.captures) ? opts.captures : JSON.parse(fs.readFileSync(opts.captures, "utf8"));
  const res = E.run(plan, scope, captures);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("NR");
  const header = plan.header.slice(0, plan.cols.filter((c) => c.label).length);
  ws.addRow(header.concat(["Statut NR", "URL testée", "Commentaire"]));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { wrapText: true, vertical: "top" };
  res.results.forEach((r) => {
    const line = plan.lines[r.id];
    const base = line ? line.row.slice(0, header.length) : [r.id, r.type];
    const ko = r.checks.filter((c) => c.statut === E.KO).map((c) => c.path + " : attendu " + c.attendu + ", observé " + c.observe);
    const av = r.checks.filter((c) => c.statut === E.AV).map((c) => c.path + " absent");
    let com = ko.join("\n");
    if (r.statut === "NON_TESTEE") com = "Page non capturée";
    else if (!com && av.length) com = "À vérifier (variables conditionnelles absentes) : " + av.join(", ");
    if (r.ambigu) com += (com ? "\n" : "") + "Correspondance ambiguë, autres lignes possibles : " + r.autres.join(", ");
    const row = ws.addRow(base.map((v) => (v == null ? "" : v)).concat([r.statut, r.url || "", com]));
    row.alignment = { wrapText: true, vertical: "top" };
    const color = r.statut === E.OK ? VERT : r.statut === E.KO ? ROUGE : r.statut === E.AV ? ORANGE : null;
    if (color) for (let c = 1; c <= header.length + 3; c++) fill(row.getCell(c), color);
  });
  ws.columns.forEach((col, i) => { col.width = i === 1 ? 45 : i >= header.length ? 50 : 22; });
  ws.views = [{ state: "frozen", xSplit: 2, ySplit: 1 }];

  const wd = wb.addWorksheet("Détail");
  wd.addRow(["Ligne", "Type de page", "Variable", "Attendu (plan)", "Observé (tc_vars)", "Statut", "URL"]);
  wd.getRow(1).font = { bold: true };
  res.results.forEach((r) => r.checks.forEach((c) => {
    const row = wd.addRow([r.id, r.type, c.path, c.attendu, c.observe, c.statut, r.url || ""]);
    const color = c.statut === E.OK ? VERT : c.statut === E.KO ? ROUGE : ORANGE;
    fill(row.getCell(6), color);
  }));
  [8, 45, 34, 40, 40, 12, 50].forEach((w, i) => (wd.getColumn(i + 1).width = w));
  wd.autoFilter = "A1:G1";

  if (res.ecartees.length) {
    const we = wb.addWorksheet("Captures écartées");
    we.addRow(["Ligne rapprochée", "URL", "site", "univers", "parcours", "page", "KO"]);
    we.getRow(1).font = { bold: true };
    res.ecartees.forEach((c) => {
      const t = c.tc_vars || {};
      const row = we.addRow([c.id, c.url, t.site, t.univers, t.parcours, t.page,
        c.checks.filter((x) => x.statut === E.KO).map((x) => x.path + " : attendu " + x.attendu + ", observé " + x.observe).join("\n")]);
      fill(row.getCell(7), ROUGE);
    });
    [10, 50, 14, 18, 14, 30, 60].forEach((w, i) => (we.getColumn(i + 1).width = w));
  }

  if (res.horsPerimetre.length) {
    const wh = wb.addWorksheet("Hors périmètre");
    wh.addRow(["URL", "site", "univers", "parcours", "page"]);
    res.horsPerimetre.forEach((c) => { const t = c.tc_vars || {}; wh.addRow([c.url, t.site, t.univers, t.parcours, t.page]); });
  }

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const out = opts.sortie || "NR_resultat_" + stamp + ".xlsx";
  await wb.xlsx.writeFile(out);
  const mail = E.mailDraft(res, opts.titre);
  const mailFile = out.replace(/\.xlsx$/i, "_mail.txt");
  fs.writeFileSync(mailFile, mail, "utf8");
  const count = (s) => res.results.filter((r) => r.statut === s).length;
  const compte = { ok: count(E.OK), ko: count(E.KO), aVerifier: count(E.AV), nonTestees: count("NON_TESTEE"), horsPerimetre: res.horsPerimetre.length, ecartees: res.ecartees.length };
  log("NR terminée : " + compte.ok + " OK, " + compte.ko + " KO, " + compte.aVerifier + " à vérifier, " + compte.nonTestees + " non testées, " + compte.horsPerimetre + " captures hors périmètre, " + compte.ecartees + " captures écartées en erreur.");
  return { res, sortie: path.resolve(out), mailFile: path.resolve(mailFile), mail, compte };
}

module.exports = { comparer, readScope };

// ---------- Ligne de commande ----------
if (require.main === module) {
  const a = args();
  if (!a.plan || !a.perimetre || !a.captures) {
    console.error("Paramètres requis : --plan, --perimetre, --captures (voir l'en-tête du script).");
    process.exit(1);
  }
  comparer({ plan: a.plan, perimetre: a.perimetre, captures: a.captures, env: a.env, variables: a.variables, titre: a.titre, sortie: a.sortie })
    .then((r) => { console.log("Fichier : " + r.sortie); console.log("Mail    : " + r.mailFile); })
    .catch((e) => { console.error("Erreur : " + e.message); process.exit(1); });
}
