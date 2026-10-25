#!/usr/bin/env node
// Robot de capture NR : ouvre Chrome, capte tc_vars à chaque page (et à chaque étape d'une page dynamique),
// puis écrit captures.json pour nr-compare.js. Utilisable en ligne de commande ou depuis l'interface (nr-app.js).
//
// Mode manuel (tu navigues, le robot capture tout seul) :
//   node nr-robot.js --url "https://lien-preprod..." [--sortie captures.json]
//   -> fermer la fenêtre Chrome (ou Ctrl+C) pour terminer.
//
// Mode automatique (rejoue des parcours enregistrés avec Chrome DevTools > Recorder, export JSON) :
//   node nr-robot.js --parcours parcours/ [--url-base "https://lien-preprod..."] [--sortie captures.json]
//   -> chaque fichier .json du dossier est un parcours (FAI, Mobile, Mixte...).
//
// Mode liste d'URLs (les liens du mail de NR, un par ligne) :
//   node nr-robot.js --urls urls.txt [--sortie captures.json]
//   -> visite chaque URL et capture la page d'arrivée (le reste du parcours passe par --parcours).
//
// Enregistrer un parcours (sans le Recorder de Chrome) :
//   node nr-robot.js --enregistrer "FAI eligibilite panier" --url "https://lien-de-depart..."
//   -> fais le parcours, ferme la fenêtre : le fichier est créé dans parcours/.
//
// Options : --navigateur chrome|msedge (défaut chrome), --invisible (sans fenêtre), --pause 1500 (ms avant capture).
"use strict";
const fs = require("fs");
const path = require("path");
let pw;
try { pw = require("playwright-core"); } catch (e) { pw = require("playwright"); }

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

// Les pages Bouygues chargent beaucoup de scripts tiers : l'événement "load" peut ne jamais arriver à temps.
// On attend le DOM, et un dépassement de délai n'arrête pas le robot (la capture se fait quand tc_vars est là).
async function aller(page, url, log) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  } catch (e) {
    if (!/Timeout/i.test(e.message)) throw e;
    log("  (page lente, on continue : " + url.slice(0, 90) + ")");
  }
}

// opts : { url | urls[] | parcours (dossier ou fichiers[]), urlBase, navigateur, invisible, pause,
//          sortie, log(fn), stop (Promise résolue pour terminer le mode manuel) }
// Renvoie { captures, bilan }.
async function lancerCapture(opts) {
  const log = opts.log || console.log;
  const PAUSE = Number(opts.pause || 1500);
  const captures = [];
  const bilan = [];
  let parcoursCourant = "";

  function sauvegarder() {
    if (opts.sortie) fs.writeFileSync(opts.sortie, JSON.stringify(captures, null, 1), "utf8");
  }

  function brancherCapture(page) {
    let derniere = "";
    async function capturer() {
      const tc = await lireTcVars(page);
      const sig = signature(tc);
      if (!tc || sig === derniere) return;
      derniere = sig;
      captures.push({ parcours: parcoursCourant, url: page.url(), date: new Date().toISOString(), tc_vars: tc });
      // Écrit le fichier à chaque capture : rien n'est perdu si le robot est interrompu.
      sauvegarder();
      log("  capturé : " + (tc.page || "?") + "  (" + page.url().slice(0, 90) + ")");
    }
    page.on("domcontentloaded", () => { setTimeout(capturer, 300); setTimeout(capturer, PAUSE); });
    page.on("load", () => setTimeout(capturer, 300));
    const timer = setInterval(capturer, 1000);
    page.on("close", () => clearInterval(timer));
    return capturer;
  }

  async function rejouer(page, fichier, capturer) {
    const rec = JSON.parse(fs.readFileSync(fichier, "utf8"));
    parcoursCourant = rec.title || path.basename(fichier, ".json");
    log("Parcours : " + parcoursCourant);
    const erreurs = [];
    for (const [i, st] of (rec.steps || []).entries()) {
      try {
        // Capture avant chaque action : une page quittée vite (clic rapide) n'est jamais perdue.
        if (st.type !== "setViewport" && st.type !== "navigate") { await page.waitForTimeout(300); await capturer(); }
        if (st.type === "setViewport") await page.setViewportSize({ width: st.width, height: st.height });
        else if (st.type === "navigate") {
          let url = st.url;
          if (opts.urlBase) { const u = new URL(url); url = opts.urlBase.replace(/\/$/, "") + u.pathname + u.search; }
          await aller(page, url, log);
        } else if (st.type === "click" || st.type === "doubleClick") {
          const el = await premierVisible(page, st.selectors, 15000);
          if (!el) throw new Error("élément introuvable");
          await el.scrollIntoViewIfNeeded();
          await (st.type === "click" ? el.click() : el.dblclick());
        } else if (st.type === "change") {
          const el = await premierVisible(page, st.selectors, 15000);
          if (!el) throw new Error("champ introuvable");
          const tag = await el.evaluate((n) => n.tagName);
          if (st.secret) {
            if (opts.invisible) throw new Error("mot de passe requis : relancer sans le mode invisible");
            log("  >> Saisis le mot de passe dans la fenêtre Chrome (60 s), le robot reprend ensuite.");
            await el.focus();
            const debut = Date.now();
            while (Date.now() - debut < 60000 && !(await el.inputValue().catch(() => ""))) await page.waitForTimeout(500);
            await page.waitForTimeout(1500);
          } else if (tag === "SELECT") await el.selectOption(st.value);
          else {
            // Saisie touche par touche : les champs d'adresse à autocomplétion réagissent comme pour un humain.
            await el.fill("");
            await el.pressSequentially(st.value, { delay: 40 });
          }
        } else if (st.type === "keyDown") await page.keyboard.down(st.key);
        else if (st.type === "keyUp") await page.keyboard.up(st.key);
        else if (st.type === "scroll") await page.mouse.wheel(st.x || 0, st.y || 0);
        else if (st.type === "waitForElement") { if (!(await premierVisible(page, st.selectors, 20000))) throw new Error("élément attendu absent"); }
        await page.waitForTimeout(400);
      } catch (e) {
        const msg = "étape " + (i + 1) + " (" + st.type + ") : " + e.message.split("\n")[0];
        log("  ! " + msg);
        erreurs.push(msg);
        // Le front a peut-être changé : on arrête ce parcours, les pages suivantes sortiront « non testées ».
        if (st.type !== "scroll" && st.type !== "keyUp") break;
      }
    }
    await page.waitForTimeout(PAUSE + 500);
    return { parcours: parcoursCourant, erreurs };
  }

  const browser = await pw.chromium.launch({
    channel: opts.navigateur === "aucun" || process.env.NR_CHROME ? undefined : (opts.navigateur || "chrome"),
    // NR_CHROME : chemin d'un Chrome installé ailleurs que l'emplacement standard.
    executablePath: process.env.NR_CHROME || undefined,
    headless: !!opts.invisible,
    // Ctrl+C est géré par le robot (sauvegarde avant fermeture), pas par Playwright.
    handleSIGINT: false,
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const capturer = brancherCapture(page);

  try {
    if (opts.urls && opts.urls.length) {
      parcoursCourant = "urls";
      for (const u of opts.urls) {
        log("Visite : " + u);
        try { await aller(page, u, log); await page.waitForTimeout(PAUSE + 500); await capturer(); }
        catch (e) { log("  ! " + e.message.split("\n")[0]); bilan.push({ parcours: u, erreurs: ["page non chargée"] }); }
      }
    }
    if (opts.parcours && opts.parcours.length) {
      const fichiers = Array.isArray(opts.parcours) ? opts.parcours
        : fs.statSync(opts.parcours).isDirectory()
          ? fs.readdirSync(opts.parcours).filter((f) => f.endsWith(".json")).sort().map((f) => path.join(opts.parcours, f))
          : [opts.parcours];
      for (const f of fichiers) { bilan.push(await rejouer(page, f, capturer)); await capturer(); }
    }
    if (opts.url) {
      parcoursCourant = "manuel";
      log("Navigue sur les parcours dans la fenêtre Chrome ouverte par le robot (nouveaux onglets compris).");
      // Les liens qui s'ouvrent dans un nouvel onglet sont suivis aussi.
      context.on("page", (p) => { brancherCapture(p); log("  (nouvel onglet suivi)"); });
      await aller(page, opts.url, log);
      await new Promise((r) => {
        browser.on("disconnected", r);
        if (opts.stop) opts.stop.then(r);
        const verifier = () => setTimeout(() => { if (context.pages().length === 0) r(); }, 200);
        page.on("close", verifier);
        context.on("page", (p) => p.on("close", verifier));
      });
    }
  } finally {
    try { await browser.close(); } catch (e) { /* déjà fermé */ }
  }
  sauvegarder();
  return { captures, bilan };
}


// ---------- Enregistrement d'un parcours (sans le Recorder de Chrome) ----------
// Script injecté dans chaque page : note les clics et les saisies avec plusieurs sélecteurs de secours,
// au même format que l'export JSON du Recorder Chrome, pour être rejoué par lancerCapture({ parcours }).
const SCRIPT_ENREGISTREMENT = function () {
  if (window.__nrEnrOn) return;
  window.__nrEnrOn = true;
  function texte(el) {
    const t = (el.getAttribute("aria-label") || el.innerText || el.value || "").trim().split("\n")[0].trim();
    return t.length > 0 && t.length <= 80 ? t : "";
  }
  function cheminCss(el) {
    const parts = [];
    while (el && el.nodeType === 1 && parts.length < 6 && el !== document.body) {
      let p = el.tagName.toLowerCase();
      if (el.id && !/\d{3,}/.test(el.id)) { parts.unshift("#" + CSS.escape(el.id)); break; }
      const freres = el.parentElement ? Array.from(el.parentElement.children).filter((x) => x.tagName === el.tagName) : [];
      if (freres.length > 1) p += ":nth-of-type(" + (freres.indexOf(el) + 1) + ")";
      parts.unshift(p);
      el = el.parentElement;
    }
    return parts.join(" > ");
  }
  function selecteurs(el, avecTexte) {
    const s = [];
    if (el.id && !/\d{3,}/.test(el.id)) s.push(["#" + CSS.escape(el.id)]);
    ["data-testid", "data-test", "data-qa", "data-cy"].forEach((a) => { if (el.getAttribute(a)) s.push(["[" + a + '="' + el.getAttribute(a) + '"]']); });
    if (el.getAttribute("name")) s.push([el.tagName.toLowerCase() + '[name="' + el.getAttribute("name") + '"]']);
    const label = el.getAttribute("aria-label") || el.getAttribute("placeholder") || (el.labels && el.labels[0] && el.labels[0].innerText.trim());
    if (label) s.push(["aria/" + label]);
    if (avecTexte) { const t = texte(el); if (t) { s.push(["aria/" + t]); s.push(["text/" + t]); } }
    s.push([cheminCss(el)]);
    return s;
  }
  document.addEventListener("click", (e) => {
    const el = e.target.closest("button,a,[role=button],[role=link],[role=tab],[role=option],[role=radio],[role=checkbox],label,input[type=radio],input[type=checkbox],input[type=submit],summary") || e.target;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) && !["radio", "checkbox", "submit", "button"].includes(el.type)) return;
    window.__nrEnr({ type: "click", selectors: selecteurs(el, true) });
  }, true);
  document.addEventListener("change", (e) => {
    const el = e.target;
    if (!["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || ["radio", "checkbox", "submit", "button"].includes(el.type)) return;
    // Les mots de passe ne sont jamais enregistrés : le robot s'arrêtera sur ce champ pour saisie manuelle.
    const secret = el.type === "password";
    window.__nrEnr({ type: "change", value: secret ? "" : el.value, secret, selectors: selecteurs(el, false) });
  }, true);
};

// opts : { url, titre, sortie (fichier .json), navigateur, log, stop }
async function enregistrerParcours(opts) {
  const log = opts.log || console.log;
  const steps = [{ type: "setViewport", width: 1366, height: 900 }, { type: "navigate", url: opts.url }];
  let derniereAction = Date.now();
  const browser = await pw.chromium.launch({
    channel: opts.navigateur === "aucun" || process.env.NR_CHROME ? undefined : (opts.navigateur || "chrome"),
    executablePath: process.env.NR_CHROME || undefined,
    headless: !!opts.invisible, handleSIGINT: false,
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1366, height: 900 } });
  await context.exposeBinding("__nrEnr", (src, step) => {
    // Une saisie répétée sur le même champ remplace la précédente.
    const prev = steps[steps.length - 1];
    if (step.type === "change" && prev && prev.type === "change" && JSON.stringify(prev.selectors) === JSON.stringify(step.selectors)) steps.pop();
    steps.push(step);
    derniereAction = Date.now();
    log("  enregistré : " + step.type + " " + (step.secret ? "(mot de passe à saisir à la main)" : step.type === "change" ? '"' + step.value + '"' : step.selectors[0][0]).slice(0, 90));
  });
  await context.addInitScript(SCRIPT_ENREGISTREMENT);
  const page = await context.newPage();
  // Une URL tapée à la main dans la barre d'adresse (sans clic juste avant) devient une étape de navigation.
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame() && Date.now() - derniereAction > 3000 && steps.length > 2 && f.url() !== "about:blank") {
      steps.push({ type: "navigate", url: f.url() });
      log("  enregistré : navigation " + f.url().slice(0, 90));
    }
  });
  log("Fais ton parcours dans la fenêtre Chrome. Ferme-la (ou termine depuis l'interface) pour sauvegarder.");
  await aller(page, opts.url, log);
  if (opts.onPage) opts.onPage(page); // utilisé par les tests automatiques
  await new Promise((r) => {
    browser.on("disconnected", r);
    page.on("close", r);
    if (opts.stop) opts.stop.then(r);
  });
  try { await browser.close(); } catch (e) { /* déjà fermé */ }
  const rec = { title: opts.titre || "Parcours", steps };
  fs.writeFileSync(opts.sortie, JSON.stringify(rec, null, 1), "utf8");
  log((steps.length - 2) + " actions enregistrées -> " + path.resolve(opts.sortie));
  return rec;
}

module.exports = { lancerCapture, enregistrerParcours };

// ---------- Ligne de commande ----------
if (require.main === module) {
  const a = {}, v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) if (v[i].startsWith("--")) a[v[i].slice(2)] = v[i + 1] && !v[i + 1].startsWith("--") ? v[++i] : true;
  const sortie = a.sortie || "captures.json";
  if (a.enregistrer) {
    if (!a.url) { console.error("Indique --url de départ avec --enregistrer \"Nom du parcours\"."); process.exit(1); }
    let fin; const stopEnr = new Promise((r) => (fin = r));
    process.on("SIGINT", () => fin());
    const nom = String(a.enregistrer === true ? "parcours" : a.enregistrer);
    const fichier = a.sortie || path.join("parcours", nom.replace(/[^\w\-]+/g, "_") + ".json");
    fs.mkdirSync(path.dirname(fichier), { recursive: true });
    enregistrerParcours({ url: a.url, titre: nom, sortie: fichier, navigateur: a.navigateur, invisible: a.invisible, stop: stopEnr })
      .then(() => process.exit(0)).catch((e) => { console.error("Erreur : " + e.message); process.exit(1); });
    return;
  }
  if (!a.url && !a.urls && !a.parcours) { console.error("Indique --url (mode manuel), --urls (liste) ou --parcours (mode automatique)."); process.exit(1); }
  let arreter;
  const stop = new Promise((r) => (arreter = r));
  process.on("SIGINT", () => {
    console.log("\nArrêt demandé, sauvegarde en cours...");
    arreter();
    setTimeout(() => process.exit(0), 5000);
  });
  if (a.url) console.log("Pour finir : ferme la fenêtre, ou Ctrl+C ici.");
  const urls = a.urls ? fs.readFileSync(a.urls, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => /^https?:\/\//.test(l)) : null;
  lancerCapture({ url: a.url, urls, parcours: a.parcours, urlBase: a["url-base"], navigateur: a.navigateur, invisible: a.invisible, pause: a.pause, sortie, stop })
    .then(({ captures, bilan }) => {
      console.log("\n" + captures.length + " pages capturées -> " + path.resolve(sortie));
      bilan.filter((b) => b.erreurs.length).forEach((b) => console.log("Parcours interrompu : " + b.parcours + " -> " + b.erreurs.join(" ; ")));
      process.exit(0);
    })
    .catch((e) => { console.error("Erreur : " + e.message); process.exit(1); });
}
