#!/usr/bin/env node
// Robot de capture NR : ouvre Chrome, capte tc_vars à chaque page (et à chaque étape d'une page dynamique),
// puis écrit captures.json pour nr-compare.js.
//
// Mode manuel (tu navigues, le robot capture tout seul) :
//   node nr-robot.js --url "https://lien-preprod..." [--sortie captures.json]
//   -> fermer la fenêtre Chrome pour terminer.
//
// Mode automatique (rejoue des parcours enregistrés avec Chrome DevTools > Recorder, export JSON) :
//   node nr-robot.js --parcours parcours/ [--url-base "https://lien-preprod..."] [--sortie captures.json]
//   -> chaque fichier .json du dossier est un parcours (FAI, Mobile, Mixte...).
//
// Mode liste d'URLs (les liens du mail de NR, un par ligne) :
//   node nr-robot.js --urls urls.txt [--sortie captures.json]
//   -> visite chaque URL et capture la page d'arrivée (le reste du parcours passe par --parcours).
//
// Options : --navigateur chrome|msedge (défaut chrome), --invisible (sans fenêtre), --pause 1500 (ms avant capture).
"use strict";
const fs = require("fs");
const path = require("path");
let pw;
try { pw = require("playwright-core"); } catch (e) { pw = require("playwright"); }

function args() {
  const a = {}, v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) if (v[i].startsWith("--")) a[v[i].slice(2)] = v[i + 1] && !v[i + 1].startsWith("--") ? v[++i] : true;
  return a;
}

const a = args();
const PAUSE = Number(a.pause || 1500);
const captures = [];
let parcoursCourant = "";

// Signature d'une page : on capture de nouveau quand l'une de ces variables change (étapes d'un checkout dynamique).
function signature(tc) {
  if (!tc) return "";
  return [tc.page, tc.pageCategorie, tc.etapeEcommerce, tc.pageVariante, tc.univers].join("|");
}

async function lireTcVars(page) {
  try {
    return await page.evaluate(() => (window.tc_vars ? JSON.parse(JSON.stringify(window.tc_vars)) : null));
  } catch (e) {
    return null;
  }
}

function brancherCapture(page) {
  let derniere = "";
  async function capturer() {
    const tc = await lireTcVars(page);
    const sig = signature(tc);
    if (!tc || sig === derniere) return;
    derniere = sig;
    captures.push({ parcours: parcoursCourant, url: page.url(), date: new Date().toISOString(), tc_vars: tc });
    console.log("  capturé : " + (tc.page || "?") + "  (" + page.url().slice(0, 90) + ")");
  }
  page.on("load", () => { setTimeout(capturer, 300); setTimeout(capturer, PAUSE); });
  const timer = setInterval(capturer, 1000);
  page.on("close", () => clearInterval(timer));
  return capturer;
}

// Sélecteurs du Recorder Chrome : ["aria/Texte"], ["#css"], ["xpath//..."], ["text/..."], ["pierce/css"].
function locator(page, selectors) {
  const list = [];
  (selectors || []).forEach((group) => {
    const s = Array.isArray(group) ? group[0] : group;
    if (!s) return;
    if (s.startsWith("aria/")) {
      const name = s.slice(5).replace(/\[role="[^"]*"\]$/, "");
      list.push(page.getByRole("button", { name }), page.getByRole("link", { name }), page.getByLabel(name), page.getByText(name, { exact: true }));
    } else if (s.startsWith("xpath/")) list.push(page.locator("xpath=" + s.slice(6)));
    else if (s.startsWith("text/")) list.push(page.getByText(s.slice(5)));
    else if (s.startsWith("pierce/")) list.push(page.locator(s.slice(7)));
    else list.push(page.locator(s));
  });
  return list;
}

async function premierVisible(page, selectors, timeout) {
  const fin = Date.now() + timeout;
  while (Date.now() < fin) {
    for (const l of locator(page, selectors)) {
      try { if (await l.first().isVisible()) return l.first(); } catch (e) { /* sélecteur suivant */ }
    }
    await page.waitForTimeout(300);
  }
  return null;
}

async function rejouer(page, fichier, urlBase, capturer) {
  const rec = JSON.parse(fs.readFileSync(fichier, "utf8"));
  parcoursCourant = rec.title || path.basename(fichier, ".json");
  console.log("Parcours : " + parcoursCourant);
  const erreurs = [];
  for (const [i, st] of (rec.steps || []).entries()) {
    try {
      // Capture avant chaque action : une page quittée vite (clic rapide) n'est jamais perdue.
      if (st.type !== "setViewport" && st.type !== "navigate") { await page.waitForTimeout(300); await capturer(); }
      if (st.type === "setViewport") await page.setViewportSize({ width: st.width, height: st.height });
      else if (st.type === "navigate") {
        let url = st.url;
        if (urlBase) { const u = new URL(url); url = urlBase.replace(/\/$/, "") + u.pathname + u.search; }
        await page.goto(url, { waitUntil: "load" });
      } else if (st.type === "click" || st.type === "doubleClick") {
        const el = await premierVisible(page, st.selectors, 15000);
        if (!el) throw new Error("élément introuvable");
        await el.scrollIntoViewIfNeeded();
        await (st.type === "click" ? el.click() : el.dblclick());
      } else if (st.type === "change") {
        const el = await premierVisible(page, st.selectors, 15000);
        if (!el) throw new Error("champ introuvable");
        const tag = await el.evaluate((n) => n.tagName);
        if (tag === "SELECT") await el.selectOption(st.value); else await el.fill(st.value);
      } else if (st.type === "keyDown") await page.keyboard.down(st.key);
      else if (st.type === "keyUp") await page.keyboard.up(st.key);
      else if (st.type === "scroll") await page.mouse.wheel(st.x || 0, st.y || 0);
      else if (st.type === "waitForElement") { if (!(await premierVisible(page, st.selectors, 20000))) throw new Error("élément attendu absent"); }
      await page.waitForTimeout(400);
    } catch (e) {
      const msg = "étape " + (i + 1) + " (" + st.type + ") : " + e.message.split("\n")[0];
      console.log("  ! " + msg);
      erreurs.push(msg);
      // Le front a peut-être changé : on arrête ce parcours, les pages suivantes sortiront « non testées ».
      if (st.type !== "scroll" && st.type !== "keyUp") break;
    }
  }
  await page.waitForTimeout(PAUSE + 500);
  return { parcours: parcoursCourant, erreurs };
}

async function main() {
  const browser = await pw.chromium.launch({
    channel: a.navigateur === "aucun" ? undefined : (a.navigateur || "chrome"),
    headless: !!a.invisible,
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const capturer = brancherCapture(page);
  const bilan = [];

  if (a.urls) {
    const urls = fs.readFileSync(a.urls, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => /^https?:\/\//.test(l));
    parcoursCourant = "urls";
    for (const u of urls) {
      console.log("Visite : " + u);
      try { await page.goto(u, { waitUntil: "load", timeout: 60000 }); await page.waitForTimeout(PAUSE + 500); await capturer(); }
      catch (e) { console.log("  ! " + e.message.split("\n")[0]); bilan.push({ parcours: u, erreurs: ["page non chargée"] }); }
    }
    await browser.close();
  } else if (a.parcours) {
    const dir = a.parcours;
    const fichiers = fs.statSync(dir).isDirectory()
      ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => path.join(dir, f))
      : [dir];
    for (const f of fichiers) { bilan.push(await rejouer(page, f, a["url-base"], capturer)); await capturer(); }
    await browser.close();
  } else {
    if (!a.url) { console.error("Indique --url (mode manuel) ou --parcours (mode automatique)."); process.exit(1); }
    parcoursCourant = "manuel";
    await page.goto(a.url);
    console.log("Navigue sur les parcours. Ferme la fenêtre Chrome quand tu as fini.");
    await new Promise((r) => { page.on("close", r); browser.on("disconnected", r); });
    try { await browser.close(); } catch (e) { /* déjà fermé */ }
  }

  const out = a.sortie || "captures.json";
  fs.writeFileSync(out, JSON.stringify(captures, null, 1), "utf8");
  console.log("\n" + captures.length + " pages capturées -> " + path.resolve(out));
  bilan.filter((b) => b.erreurs.length).forEach((b) => console.log("Parcours interrompu : " + b.parcours + " -> " + b.erreurs.join(" ; ")));
}

main().catch((e) => { console.error("Erreur : " + e.message); process.exit(1); });
