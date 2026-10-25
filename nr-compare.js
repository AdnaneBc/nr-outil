#!/usr/bin/env node
// Compare des captures tc_vars au plan WEBA et produit le fichier NR (vert/rouge) + le brouillon de mail.
//
// Usage :
//   node nr-compare.js --plan "Documentations WEBA - Plans de tracking.xlsx" \
//                      --perimetre NR_Boutique_precedente.xlsx \
//                      --captures captures.json \
//                      [--env PREPROD] [--titre "MEP du 28/10"] [--sortie NR_resultat.xlsx]
//
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

async function main() {
  const a = args();
  if (!a.plan || !a.perimetre || !a.captures) {
    console.error("Paramètres requis : --plan, --perimetre, --captures (voir l'en-tête du script).");
    process.exit(1);
  }
  const planRows = await readRows(a.plan, "Plan de Tracking - Pages");
  const plan = E.buildPlan(planRows);
  if (a.env) {
    Object.values(plan.lines).forEach((l) => l.checks.forEach((c) => {
      if (c.path === "env") c.rule = { type: "exact", value: a.env, label: a.env };
    }));
  }
  const scope = await readScope(a.perimetre);
  const captures = JSON.parse(fs.readFileSync(a.captures, "utf8"));
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

  if (res.horsPerimetre.length) {
    const wh = wb.addWorksheet("Hors périmètre");
    wh.addRow(["URL", "site", "univers", "parcours", "page"]);
    res.horsPerimetre.forEach((c) => { const t = c.tc_vars || {}; wh.addRow([c.url, t.site, t.univers, t.parcours, t.page]); });
  }

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const out = a.sortie || "NR_resultat_" + stamp + ".xlsx";
  await wb.xlsx.writeFile(out);
  const mail = E.mailDraft(res, a.titre);
  const mailFile = out.replace(/\.xlsx$/i, "_mail.txt");
  fs.writeFileSync(mailFile, mail, "utf8");

  const count = (s) => res.results.filter((r) => r.statut === s).length;
  console.log("NR terminée : " + count(E.OK) + " OK, " + count(E.KO) + " KO, " + count(E.AV) + " à vérifier, " + count("NON_TESTEE") + " non testées, " + res.horsPerimetre.length + " captures hors périmètre.");
  console.log("Fichier : " + path.resolve(out));
  console.log("Mail    : " + path.resolve(mailFile));
}

main().catch((e) => { console.error("Erreur : " + e.message); process.exit(1); });
