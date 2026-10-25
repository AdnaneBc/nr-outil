#!/usr/bin/env node
// Interface graphique de l'outil NR : `npm start` puis la page s'ouvre dans le navigateur.
// Un seul bouton enchaîne navigation (liens + parcours enregistrés + navigation manuelle), capture et comparaison.
// Tout reste en local : le serveur n'écoute que sur 127.0.0.1, les fichiers sont dans ./donnees (non versionné).
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { lancerCapture, enregistrerParcours } = require("./nr-robot.js");
const { comparer } = require("./nr-compare.js");

const PORT = Number(process.env.NR_PORT || 3737);
const RACINE = __dirname;
const DONNEES = path.join(RACINE, "donnees");
const RESULTATS = path.join(DONNEES, "resultats");
const PARCOURS = path.join(RACINE, "parcours");
const CONFIG = path.join(DONNEES, "config.json");
[DONNEES, RESULTATS, PARCOURS].forEach((d) => fs.mkdirSync(d, { recursive: true }));

const DEFAUT = {
  plan: "", perimetre: "", urls: "", urlBase: "", parcours: [], manuel: false,
  variables: "", env: "", navigateur: "chrome", invisible: false, titre: "",
};

function lireConfig() {
  try { return Object.assign({}, DEFAUT, JSON.parse(fs.readFileSync(CONFIG, "utf8"))); } catch (e) { return Object.assign({}, DEFAUT); }
}
function ecrireConfig(c) { fs.writeFileSync(CONFIG, JSON.stringify(c, null, 1), "utf8"); }

// ---------- État de l'exécution en cours ----------
let job = null; // { logs: [], etat: "en_cours"|"termine"|"erreur", resultat, arreter }
const abonnes = new Set();

function diffuser(type, data) {
  const msg = "event: " + type + "\ndata: " + JSON.stringify(data) + "\n\n";
  abonnes.forEach((res) => res.write(msg));
}
function log(ligne) {
  console.log(ligne);
  if (job) job.logs.push(ligne);
  diffuser("log", ligne);
}

function nomSur(n) { return path.basename(String(n || "fichier")).replace(/[^\w.\- ]+/g, "_"); }

function listerParcours() {
  return fs.readdirSync(PARCOURS).filter((f) => f.endsWith(".json")).sort().map((f) => {
    let titre = f;
    try { titre = JSON.parse(fs.readFileSync(path.join(PARCOURS, f), "utf8")).title || f; } catch (e) { /* fichier illisible */ }
    return { fichier: f, titre };
  });
}

function resumeResultat(r) {
  return {
    compte: r.compte,
    mail: r.mail,
    fichier: path.basename(r.sortie),
    lignes: r.res.results.map((x) => ({
      id: x.id, type: x.type, statut: x.statut, url: x.url || "",
      ko: x.checks.filter((c) => c.statut !== "OK").map((c) => ({ variable: c.path, attendu: c.attendu, observe: c.observe, statut: c.statut })),
    })),
    horsPerimetre: r.res.horsPerimetre.map((c) => ({ url: c.url, page: (c.tc_vars || {}).page, univers: (c.tc_vars || {}).univers })),
    ecartees: r.res.ecartees.map((c) => ({ id: c.id, url: c.url, page: (c.tc_vars || {}).page, univers: (c.tc_vars || {}).univers })),
  };
}

async function lancer(c) {
  let arreter;
  const stop = new Promise((r) => (arreter = r));
  job = { logs: [], etat: "en_cours", resultat: null, arreter, manuel: !!c.manuel };
  diffuser("etat", { etat: "en_cours", manuel: !!c.manuel });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 13).replace("T", "_");
  try {
    if (!c.plan || !fs.existsSync(path.join(DONNEES, c.plan))) throw new Error("Ajoute d'abord le plan WEBA (étape 1).");
    if (!c.perimetre || !fs.existsSync(path.join(DONNEES, c.perimetre))) throw new Error("Ajoute d'abord le fichier de périmètre (étape 1).");
    const urls = String(c.urls || "").split(/\s+/).map((l) => l.trim()).filter((l) => /^https?:\/\//.test(l));
    // Domaine de test déduit du premier lien du mail si non renseigné (les liens changent à chaque NR).
    let urlBase = (c.urlBase || "").trim();
    if (!urlBase && urls.length) { const u = new URL(urls[0]); urlBase = u.protocol + "//" + u.host; }
    const parcours = (c.parcours || []).map((f) => path.join(PARCOURS, nomSur(f))).filter((f) => fs.existsSync(f));
    if (!urls.length && !parcours.length && !c.manuel) throw new Error("Colle au moins un lien, coche un parcours ou active la navigation manuelle.");

    log("=== 1/2 Navigation et capture ===");
    if (urlBase && parcours.length) log("Domaine de test : " + urlBase);
    const capFile = path.join(RESULTATS, "captures_" + stamp + ".json");
    const { captures, bilan } = await lancerCapture({
      urls, parcours, urlBase,
      url: c.manuel ? (urls[0] || urlBase) : undefined,
      navigateur: c.navigateur, invisible: !!c.invisible && !c.manuel,
      sortie: capFile, log, stop,
    });
    bilan.filter((b) => b.erreurs.length).forEach((b) => log("Parcours interrompu : " + b.parcours + " -> " + b.erreurs.join(" ; ")));
    log(captures.length + " pages capturées.");
    if (!captures.length) throw new Error("Aucune page capturée : vérifie le VPN et les liens.");

    log("=== 2/2 Comparaison au plan WEBA ===");
    const r = await comparer({
      plan: path.join(DONNEES, c.plan),
      perimetre: path.join(DONNEES, c.perimetre),
      captures, env: c.env || undefined, variables: c.variables || undefined, titre: c.titre || undefined,
      sortie: path.join(RESULTATS, "NR_resultat_" + stamp + ".xlsx"), log,
    });
    job.etat = "termine";
    job.resultat = resumeResultat(r);
    diffuser("fin", job.resultat);
  } catch (e) {
    job.etat = "erreur";
    log("Erreur : " + e.message);
    diffuser("erreur", e.message);
  }
}

async function enregistrer(c, url, titre) {
  let arreter;
  const stop = new Promise((r) => (arreter = r));
  job = { logs: [], etat: "en_cours", resultat: null, arreter, manuel: true, enregistrement: true };
  diffuser("etat", { etat: "en_cours", manuel: true, enregistrement: true });
  try {
    if (!/^https?:\/\//.test(url || "")) throw new Error("Indique l'URL de départ du parcours (ex. la page test d'éligibilité).");
    const fichier = path.join(PARCOURS, nomSur(titre || "parcours").replace(/\s+/g, "_").replace(/\.json$/i, "") + ".json");
    log("=== Enregistrement du parcours « " + (titre || "parcours") + " » ===");
    await enregistrerParcours({ url, titre: titre || "Parcours", sortie: fichier, navigateur: c.navigateur, log, stop });
    job.etat = "termine";
    diffuser("parcours", listerParcours());
    diffuser("etat", { etat: "termine" });
  } catch (e) {
    job.etat = "erreur";
    log("Erreur : " + e.message);
    diffuser("erreur", e.message);
  }
}

// ---------- Serveur HTTP ----------
function json(res, code, data) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}
function lireCorps(req, max) {
  return new Promise((ok, ko) => {
    const morceaux = []; let taille = 0;
    req.on("data", (d) => { taille += d.length; if (taille > max) { ko(new Error("Fichier trop gros")); req.destroy(); } else morceaux.push(d); });
    req.on("end", () => ok(Buffer.concat(morceaux)));
    req.on("error", ko);
  });
}

const serveur = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  try {
    if (req.method === "GET" && u.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return fs.createReadStream(path.join(RACINE, "nr-app.html")).pipe(res);
    }
    if (req.method === "GET" && u.pathname === "/api/etat") {
      const c = lireConfig();
      return json(res, 200, {
        config: c, parcoursDispo: listerParcours(),
        planOk: !!c.plan && fs.existsSync(path.join(DONNEES, c.plan)),
        perimetreOk: !!c.perimetre && fs.existsSync(path.join(DONNEES, c.perimetre)),
        job: job ? { etat: job.etat, logs: job.logs, resultat: job.resultat, manuel: job.manuel } : null,
      });
    }
    if (req.method === "POST" && u.pathname === "/api/config") {
      const c = Object.assign(lireConfig(), JSON.parse((await lireCorps(req, 1e6)).toString("utf8")));
      ecrireConfig(c);
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && u.pathname === "/api/fichier") {
      const type = u.searchParams.get("type");
      const nom = nomSur(u.searchParams.get("nom"));
      const corps = await lireCorps(req, 50e6);
      if (type === "parcours") {
        JSON.parse(corps.toString("utf8")); // refuse un fichier qui n'est pas un export JSON
        fs.writeFileSync(path.join(PARCOURS, nom.endsWith(".json") ? nom : nom + ".json"), corps);
        return json(res, 200, { ok: true });
      }
      if (type !== "plan" && type !== "perimetre") return json(res, 400, { erreur: "type inconnu" });
      if (!/\.xlsx$/i.test(nom)) return json(res, 400, { erreur: "Il faut un fichier .xlsx" });
      fs.writeFileSync(path.join(DONNEES, nom), corps);
      const c = lireConfig(); c[type] = nom; ecrireConfig(c);
      return json(res, 200, { ok: true, nom });
    }
    if (req.method === "POST" && u.pathname === "/api/lancer") {
      if (job && job.etat === "en_cours") return json(res, 409, { erreur: "Une NR est déjà en cours." });
      const c = Object.assign(lireConfig(), JSON.parse((await lireCorps(req, 1e6)).toString("utf8")));
      ecrireConfig(c);
      lancer(c);
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && u.pathname === "/api/enregistrer") {
      if (job && job.etat === "en_cours") return json(res, 409, { erreur: "Une action est déjà en cours." });
      const b = JSON.parse((await lireCorps(req, 1e6)).toString("utf8"));
      enregistrer(lireConfig(), b.url, b.titre);
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && u.pathname === "/api/supprimer-parcours") {
      const b = JSON.parse((await lireCorps(req, 1e6)).toString("utf8"));
      const f = path.join(PARCOURS, nomSur(b.fichier));
      if (fs.existsSync(f)) fs.unlinkSync(f);
      return json(res, 200, { ok: true, parcours: listerParcours() });
    }
    if (req.method === "POST" && u.pathname === "/api/terminer") {
      if (job && job.arreter) job.arreter();
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && u.pathname === "/api/flux") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(": ok\n\n");
      abonnes.add(res);
      req.on("close", () => abonnes.delete(res));
      return;
    }
    if (req.method === "GET" && u.pathname === "/api/telecharger") {
      const f = path.join(RESULTATS, nomSur(u.searchParams.get("f")));
      if (!fs.existsSync(f)) return json(res, 404, { erreur: "introuvable" });
      res.writeHead(200, {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": 'attachment; filename="' + path.basename(f) + '"',
      });
      return fs.createReadStream(f).pipe(res);
    }
    json(res, 404, { erreur: "introuvable" });
  } catch (e) {
    json(res, 500, { erreur: e.message });
  }
});

serveur.listen(PORT, "127.0.0.1", () => {
  const adresse = "http://127.0.0.1:" + PORT;
  console.log("Outil NR prêt : " + adresse + "  (Ctrl+C pour quitter)");
  if (!process.env.NR_SANS_NAVIGATEUR) {
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start \"\"" : "xdg-open";
    exec(cmd + " " + adresse, () => {});
  }
});
