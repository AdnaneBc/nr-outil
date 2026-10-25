// Moteur de comparaison NR : plan WEBA (onglet Pages) <-> captures tc_vars.
// Fonctionne dans le navigateur (window.NREngine) et sous Node (module.exports).
(function (root) {
  "use strict";

  var OK = "OK", KO = "KO", AV = "A_VERIFIER";

  function clean(s) {
    return String(s == null ? "" : s).replace(/ /g, " ").trim();
  }

  // Chemin tc_vars porté par l'en-tête de colonne, ex. "(tc_vars.\npanier.produits[i].\nname)".
  function headerPath(h) {
    var m = clean(h).replace(/\s+/g, "").match(/\(tc_vars\.([^)]+)\)/);
    return m ? m[1] : null;
  }

  function normPath(p) {
    return p.replace(/\(i\]/g, "[i]").replace(/\[i\)/g, "[i]").replace(/\s+/g, "");
  }

  // Transforme une valeur attendue du plan en règle testable.
  function parseRule(raw) {
    var lines = clean(raw).split(/\n/).map(clean).filter(function (l) { return l; });
    if (!lines.length) return null;
    var v = lines[0];
    v = v.replace(/\s*\((par ex|ex|exemple|si)\b.*$/i, "").trim();
    v = v.replace(/^"+|"+$/g, "").trim();
    if (/^\([^()]*\)$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+\(.*$/, "").replace(/\)+$/, "").trim();
    if (!v) return null;
    if (v.indexOf("#") >= 0) {
      var parts = v.split(/#[^#]*#/);
      var re = parts.map(function (p) { return p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }).join(".+");
      var label = /^#[^#]*#$/.test(v) ? "valeur non vide (" + v + ")" : v;
      return { type: "motif", re: new RegExp("^" + re + "$"), label: label };
    }
    if (v.indexOf("|") >= 0) {
      var vals = v.split("|").map(function (x) { return clean(x).replace(/^["(]+|[")]+$/g, ""); });
      return { type: "liste", values: vals, label: vals.join(" | ") };
    }
    if (/^-?\d+([.,]\d+)?$/.test(v)) return { type: "dynamique", label: "valeur non vide (exemple du plan : " + v + ")" };
    return { type: "exact", value: v, label: v };
  }

  // Une cellule « tc_vars.x.y=règle » par ligne (colonnes Autres variables, pageVariante, panier.total).
  function parseAssignments(raw) {
    var out = [], depth = 0;
    clean(raw).split(/\n/).forEach(function (line) {
      // Les lignes situées dans une parenthèse ouverte sont des exemples, pas des règles.
      var d0 = depth;
      depth += (line.match(/\(/g) || []).length - (line.match(/\)/g) || []).length;
      if (depth < 0) depth = 0;
      if (d0 > 0) return;
      var m = clean(line).match(/^"?tc_vars\.([A-Za-z0-9_.\[\]()]+?)\s*=\s*(.*)$/);
      if (m) {
        var r = parseRule(m[2]);
        if (r) out.push({ path: normPath(m[1]), rule: r });
      }
    });
    return out;
  }

  // Colonnes principales : absence = KO. Sous-variables : absence = à vérifier (souvent conditionnelles).
  var STRICT = ["env", "site", "univers", "parcours", "page", "pageCategorie", "ligneMarche", "activiteB2BouB2C", "etapeEcommerce"];

  // Deux règles sur le même chemin = valeurs alternatives (OU).
  function mergeChecks(checks) {
    var byPath = {}, out = [];
    checks.forEach(function (c) {
      var p = byPath[c.path];
      if (!p) { byPath[c.path] = c; out.push(c); return; }
      var rules = (p.rule.type === "ou" ? p.rule.rules : [p.rule]).concat([c.rule]);
      p.rule = { type: "ou", rules: rules, label: rules.map(function (r) { return r.label; }).join(" OU ") };
      p.strict = p.strict || c.strict;
    });
    return out;
  }

  // rows : tableau de lignes (tableaux), la ligne 0 étant l'en-tête de l'onglet Pages.
  function buildPlan(rows) {
    var header = rows[0];
    var cols = header.map(function (h, i) {
      var label = clean(h).split("\n")[0];
      return { index: i, label: label, path: headerPath(h), autres: /^Autres variables/i.test(label) };
    });
    var lines = {};
    for (var r = 1; r < rows.length; r++) {
      var row = rows[r];
      if (!row || row[0] == null || row[0] === "") continue;
      var id = String(row[0]).trim();
      var checks = [];
      cols.forEach(function (c) {
        var cell = row[c.index];
        if (cell == null || clean(cell) === "") return;
        var text = clean(cell);
        if (c.autres || /tc_vars\./.test(text)) {
          parseAssignments(text).forEach(function (a) {
            checks.push({ path: a.path, rule: a.rule, strict: false, col: c.label });
          });
        } else if (c.path) {
          var rule = parseRule(text);
          if (rule) checks.push({ path: normPath(c.path), rule: rule, strict: STRICT.indexOf(c.path) >= 0, col: c.label });
        }
      });
      lines[id] = { id: id, type: clean(row[1]), row: row, checks: mergeChecks(checks) };
    }
    return { header: header, cols: cols, lines: lines };
  }

  // "[VariationHub=v1][typeCommande=Commande]" -> {VariationHub:"v1", typeCommande:"Commande"}
  function bracketDict(v) {
    if (v && typeof v === "object") return v;
    var d = {}, re = /\[([^=\]]+)=([^\]]*)\]/g, m;
    String(v || "").replace(/\s/g, "").length;
    while ((m = re.exec(String(v || "")))) d[m[1].trim()] = m[2].trim();
    return d;
  }

  // Renvoie la liste des valeurs observées pour un chemin (plusieurs si [i]).
  function lookup(tc, path) {
    var segs = path.split(".");
    var cur = [tc];
    for (var s = 0; s < segs.length; s++) {
      var seg = segs[s], isArr = /\[i\]$/.test(seg), key = seg.replace(/\[i\]$/, "");
      var next = [];
      cur.forEach(function (o) {
        if (o == null) return;
        if (typeof o === "string" && (key in bracketDict(o))) { next.push(bracketDict(o)[key]); return; }
        if (typeof o !== "object") return;
        var v = o[key];
        if (isArr) {
          if (Array.isArray(v)) v.forEach(function (x) { next.push(x); });
        } else if (v !== undefined) next.push(v);
      });
      cur = next;
    }
    return cur;
  }

  function test(rule, val) {
    if (val == null) return false;
    var s = typeof val === "object" ? JSON.stringify(val) : String(val).trim();
    if (s === "") return false;
    if (rule.type === "dynamique") return true;
    if (rule.type === "ou") return rule.rules.some(function (r) { return test(r, val); });
    if (rule.type === "exact") return s === rule.value;
    if (rule.type === "liste") return rule.values.some(function (x) { return x.toLowerCase() === s.toLowerCase(); });
    if (rule.type === "motif") return rule.re.test(s);
    return false;
  }

  function checkLine(line, tc) {
    return line.checks.map(function (c) {
      var vals = lookup(tc, c.path);
      var shown = vals.map(function (v) { return typeof v === "object" ? JSON.stringify(v) : String(v); });
      var status;
      if (!vals.length || vals.every(function (v) { return v === "" || v == null; })) status = c.strict ? KO : AV;
      else status = vals.every(function (v) { return test(c.rule, v); }) ? OK : KO;
      return { path: c.path, attendu: c.rule.label, observe: shown.length ? shown.join(" ; ") : "(absent)", statut: status, strict: c.strict };
    });
  }

  // Associe une capture à une ligne du périmètre (site + univers + page + parcours).
  function matchLine(plan, scope, cap) {
    if (cap.ligne && plan.lines[String(cap.ligne)]) return { id: String(cap.ligne), ambigu: false };
    var tc = cap.tc_vars || {};
    function filter(keys) {
      return scope.filter(function (id) {
        var l = plan.lines[id];
        if (!l) return false;
        return keys.every(function (k) {
          var c = l.checks.filter(function (x) { return x.path === k; })[0];
          return !c || test(c.rule, tc[k]);
        });
      });
    }
    var cands = filter(["site", "univers", "page", "parcours"]);
    // Repli sur le seul nom de page : une erreur d'univers ou de parcours doit sortir en KO, pas en « non testée ».
    if (!cands.length) {
      cands = filter(["page"]);
      if (cands.length === 1) return { id: cands[0], ambigu: false };
    }
    if (cands.length > 1) {
      var best = cands.map(function (id) {
        var res = checkLine(plan.lines[id], tc);
        return { id: id, ko: res.filter(function (x) { return x.statut === KO; }).length };
      }).sort(function (a, b) { return a.ko - b.ko; });
      return { id: best[0].id, ambigu: true, autres: cands.filter(function (x) { return x !== best[0].id; }) };
    }
    return cands.length ? { id: cands[0], ambigu: false } : null;
  }

  // scope : liste d'identifiants de lignes du plan ; captures : [{url, tc_vars, ligne?}]
  function run(plan, scope, captures) {
    var byLine = {}, horsPerimetre = [];
    captures.forEach(function (cap) {
      var m = matchLine(plan, scope, cap);
      if (!m) { horsPerimetre.push(cap); return; }
      var res = checkLine(plan.lines[m.id], cap.tc_vars || {});
      var prev = byLine[m.id];
      var nko = res.filter(function (x) { return x.statut === KO; }).length;
      // Si une page est capturée plusieurs fois, on garde la meilleure capture.
      if (!prev || nko < prev.nko) byLine[m.id] = { id: m.id, url: cap.url, checks: res, nko: nko, ambigu: m.ambigu, autres: m.autres };
    });
    var results = scope.map(function (id) {
      var l = plan.lines[id];
      var r = byLine[id];
      if (!l) return { id: id, type: "(ligne absente du plan)", statut: "INCONNUE", checks: [] };
      if (!r) return { id: id, type: l.type, statut: "NON_TESTEE", checks: [] };
      var st = r.checks.some(function (c) { return c.statut === KO; }) ? KO :
        r.checks.some(function (c) { return c.statut === AV; }) ? AV : OK;
      return { id: id, type: l.type, statut: st, url: r.url, checks: r.checks, ambigu: r.ambigu, autres: r.autres };
    });
    return { results: results, horsPerimetre: horsPerimetre };
  }

  function mailDraft(res, titre) {
    var ko = res.results.filter(function (r) { return r.statut === KO; });
    var av = res.results.filter(function (r) { return r.statut === AV; });
    var ok = res.results.filter(function (r) { return r.statut === OK; });
    var nt = res.results.filter(function (r) { return r.statut === "NON_TESTEE"; });
    var L = [];
    L.push("Bonjour,", "", "Voici le résultat de la non-régression tracking" + (titre ? " (" + titre + ")" : "") + " :", "");
    L.push("- Pages OK : " + ok.length);
    L.push("- Pages KO : " + ko.length);
    if (av.length) L.push("- Pages à vérifier (variables conditionnelles absentes) : " + av.length);
    L.push("- Pages non testées : " + nt.length, "");
    if (ko.length) {
      L.push("Détail des KO :");
      ko.forEach(function (r) {
        L.push("", "• Ligne " + r.id + " - " + r.type);
        r.checks.filter(function (c) { return c.statut === KO; }).forEach(function (c) {
          L.push("   " + c.path + " : attendu " + c.attendu + ", observé " + c.observe);
        });
      });
      L.push("");
    }
    L.push("Le fichier de NR est en pièce jointe (lignes vertes = OK, rouges = KO).", "", "Cordialement,");
    return L.join("\n");
  }

  var api = { buildPlan: buildPlan, parseRule: parseRule, parseAssignments: parseAssignments, lookup: lookup, checkLine: checkLine, run: run, mailDraft: mailDraft, OK: OK, KO: KO, AV: AV };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.NREngine = api;
})(this);
