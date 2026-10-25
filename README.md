# Outil NR : non-régression tracking automatique

Version 0.1 du 2026-10-25. Prototype testé sur des pages simulées et sur le vrai plan WEBA, **pas encore sur l'environnement de test réel**.

## Ce que fait l'outil

1. **Robot** (`nr-robot.js`) : ouvre Chrome dans une session vierge (même effet qu'un onglet privé) et lit `tc_vars` sur chaque page. Il capture aussi chaque étape d'une page dynamique, comme les étapes du checkout.
2. **Comparateur** (`nr-compare.js`) : confronte chaque capture aux règles de l'onglet « Plan de Tracking - Pages » du plan WEBA. Il produit :
   - `NR_resultat_AAAAMMJJ.xlsx`, onglet **NR** : une ligne par page du périmètre, au format de ton fichier NR actuel. Vert = OK, rouge = KO, orange = à vérifier, blanc = non testée. Le commentaire du KO est en fin de ligne ;
   - onglet **Détail** : chaque variable avec sa valeur attendue, sa valeur observée et son statut (filtrable) ;
   - `..._mail.txt` : le brouillon de réponse au mail de NR avec la liste des KO. **Tu le relis et tu l'envoies toi-même.**

Règles lues dans le plan : valeur exacte (`Boutique`), liste (`Commande|Precommande`, `(FTTH|ADSL|4GBOX)`), champ dynamique (`#id-produit#` = non vide), motif (`Telephone_#nomProduit#`). Les exemples entre parenthèses (« par ex », « si… ») sont ignorés.
Si une variable principale (env, site, univers, parcours, page, pageCategorie, ligneMarche, activiteB2BouB2C, etapeEcommerce) manque, la ligne est KO. Si c'est une sous-variable (`pageVariante.x`, `variablesSpecifiques.x`, produits, panier) qui manque, la ligne passe « à vérifier », parce que ces variables sont souvent conditionnelles.

## Installation (une seule fois, sur le PC pro)

1. Copier le dossier `nr-outil` sur le PC pro.
2. Ouvrir un terminal dans ce dossier, puis lancer `npm install`. Si le réseau pro bloque npm, utiliser le zip qui contient déjà `node_modules`.
3. Aucun navigateur à télécharger : le robot utilise le Chrome du PC (`--navigateur msedge` pour Edge).

## Utilisation à chaque NR

À la réception du mail « [MEP sprint X] : NR Tag » :

**Étape 1 : capturer**, au choix :
- **Mode liste** : copier `urls.exemple.txt` en `urls.txt` (non versionné) et y coller les liens du mail (un par ligne), puis lancer
  `node nr-robot.js --urls urls.txt --sortie captures.json`
  Le robot visite chaque page d'entrée tout seul.
- **Mode manuel** : `node nr-robot.js --url "<lien du mail>" --sortie captures.json`
  Tu fais les parcours (panier, checkout) dans la fenêtre ouverte. Le robot capture chaque page sans que tu aies à ouvrir la console ni l'extension. Ferme la fenêtre pour terminer.
- **Mode automatique** (cible) : `node nr-robot.js --parcours parcours --url-base "https://<domaine du mail>" --sortie captures.json`
  Le robot rejoue les parcours enregistrés (voir plus bas). `--url-base` remplace le domaine, puisque les liens changent à chaque NR.

Les modes s'additionnent : lance-les avec des fichiers de sortie différents, puis fusionne-les (voir FAQ).

**Étape 2 : comparer**
```
node nr-compare.js --plan "Documentations WEBA - Plans de tracking.xlsx" --perimetre NR_Boutique_PlanTracking_PanierV5_20260623.xlsx --captures captures.json --env PREPROD --titre "MEP sprint 16"
```
- `--perimetre` : l'ancien fichier NR (sa colonne A donne les lignes du plan à contrôler) ou une liste `58,60,61`.
- `--env` : valeur attendue de `tc_vars.env` sur l'environnement de test. **À confirmer sur l'environnement de test** (PREPROD ?).
- Le plan est toujours relu dans sa version du jour, donc les colonnes ajoutées depuis juin sont prises en compte.

**Étape 3 : relire et répondre.** Ouvre l'Excel et regarde les lignes rouges et orange. Copie le brouillon de mail dans ta réponse à la demandeuse, ajuste-le et joins l'Excel.

## Enregistrer un parcours (une fois par parcours : FAI, Mobile, Mixte…)

1. Dans Chrome : F12, puis l'onglet **Recorder**, puis « Create a new recording ».
2. Faire le parcours normalement (éligibilité, choix d'offre, panier, checkout jusqu'au paiement).
3. Arrêter l'enregistrement, puis Export > **JSON**, et enregistrer le fichier dans `nr-outil/parcours/` (ex. `01-fai.json`).
4. Exemple de format : `exemple/parcours-exemple.json`.

Si le front change avant la MEP et qu'un bouton n'est plus trouvé, le robot arrête ce parcours et le signale. Les pages suivantes sortent « non testée » et pas en faux KO. Il suffit alors de réenregistrer ce parcours.

## Limites connues (v0.1)

- **Pages Merci, bascule vers le paiement, pages d'erreur** : non testables, comme aujourd'hui.
- **Renouvellement** : il faut un compte de test et un code OTP. En v0.1, tu fais cette partie en mode manuel. L'automatisation de l'OTP est possible plus tard.
- Les **clics** (onglet Evenements) ne sont pas encore contrôlés, seulement les pages.
- Une règle mal rédigée dans le plan peut donner un faux KO (ex. `nom_forfait` écrit comme une valeur fixe). L'onglet Détail permet de le repérer vite.
- Les identifiants de test ne sont jamais écrits dans l'outil : tu les saisis toi-même pendant le parcours.

## FAQ

**Fusionner plusieurs captures** :
`node -e "const f=require('fs');f.writeFileSync('captures.json',JSON.stringify([].concat(...process.argv.slice(1).map(p=>JSON.parse(f.readFileSync(p))))))" cap1.json cap2.json`

**Une page sort « hors périmètre »** : elle a été capturée mais ne correspond à aucune ligne du périmètre (ex. la Home Boutique_web). Ajoute sa ligne au périmètre si elle doit être contrôlée.
