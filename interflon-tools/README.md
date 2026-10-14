# Terminal Interflon : prospection et sélecteur produit

Un outil web pour les commerciaux et les techniciens, dans le même esprit « terminal » que le
market terminal à la racine du dépôt :

- **PROS (prospection)** : trouver les usines d'un territoire par secteur d'activité, les
  classer par potentiel, les voir sur une carte, ouvrir une fiche entreprise et les suivre.
- **PIPE (mes prospects)** : statut, prochaine relance, notes, exports, et import de la liste
  de clients pour ne pas les re-prospecter.
- **SEL (sélecteur produit)** : décrire le besoin du client (contact alimentaire, application,
  température, environnement, conditionnement) ou le produit qu'il utilise aujourd'hui, et
  obtenir les produits Interflon adaptés, avec la raison de chaque choix et de chaque exclusion.
- **CAT (catalogue)** : tous les produits, filtrables, avec leur fiche et leurs sources.

Aucune installation : Python 3 suffit (bibliothèque standard uniquement, pas de `pip`).

## Lancer

```bash
cd interflon-tools
python3 server.py            # puis ouvrir http://127.0.0.1:8766
```

Sur Mac, double-cliquer sur `start.command`.

### Versions à partager (sans installation)

```bash
python3 build_offline.py              # dist/terminal-interflon.html : terminal complet en un fichier, avec le logo
python3 selecteur/build_interflon.py  # dist/selecteur-interflon.html : sélecteur seul, blanc et rouge, avec le logo
python3 build_artifact.py             # dist/claude-ai/ : page publiée sur claude.ai (sans logo)
```

Les deux fichiers `dist/*.html` s'ouvrent par double-clic, sans serveur ni connexion.
La prospection (PROS) y est remplacée par un message : elle passe par `server.py`.
Le logo officiel est dans `public/img/logo-interflon.png`.

### Mettre en ligne (Render)

Le `render.yaml` à la racine du dépôt déclare un second service `terminal-interflon`
(dossier `interflon-tools`). Dans Render : **New + → Blueprint → ce dépôt → Apply**.
Définir la variable d'environnement **`APP_PASSWORD`** : l'accès demandera alors ce mot de
passe (n'importe quel identifiant). Sans elle, l'outil est ouvert à toute personne qui
connaît l'URL.

## Utilisation

Barre de commande en haut (touche `/`) :

| Commande | Effet |
|---|---|
| `PROS 29 35 viande lait` | sélectionne les départements 29 et 35 et les secteurs correspondants (ils remplacent la sélection en cours), lance la recherche ; `agro` = tous les secteurs agroalimentaires |
| `CARTE 56 bois` | idem, affiché sur la carte |
| `PIPE` | mes prospects |
| `SEL` | sélecteur produit |
| `CAT food lube` | catalogue filtré |
| `AIDE` | aide complète |

### Prospection : comment ça marche

1. **Secteurs** : chaque secteur de `public/data/secteurs.json` regroupe des codes NAF.
   On peut ajouter n'importe quel code NAF à la main, en tapant le code ou un mot de l'activité.
2. **Zone** : départements, région, ou rayon (≤ 50 km) autour d'une ville, de sa position ou
   d'un point cliqué sur la carte.
3. **Taille du site** : effectif de l'établissement, et non de l'entreprise. C'est ce qui
   distingue une usine de 250 personnes d'un bureau commercial.

Le **score /100** additionne :
- la taille du site (45 points) ;
- la priorité du secteur (30) ;
- un site de production probable, c'est-à-dire un code NAF industriel (10) ;
- le chiffre d'affaires (10) ;
- un site créé il y a moins de 2 ans (5).

Le détail s'affiche au survol. Les pondérations sont dans `scoreRow()` de
`public/js/prospect.js`.

La **fiche** d'un site regroupe :
- l'adresse, le SIRET, l'activité et l'effectif ;
- l'entreprise (catégorie, CA, nombre de sites) et ses dirigeants (RNE) ;
- l'argumentaire Interflon du secteur, avec les points de lubrification typiques, les
  produits souvent proposés et des cas clients ;
- des liens directs vers l'Annuaire des entreprises, Google Maps, LinkedIn (« maintenance +
  entreprise ») et Google (« responsable maintenance »).

**Mes clients** : dans PIPE, « Importer mes clients (CSV) » accepte n'importe quel export
(CRM, ERP, Excel) contenant des SIRET (14 chiffres) ou des SIREN (9 chiffres), espacés ou non.
Ces sites sont alors masqués de la prospection. Un autre site d'un groupe déjà client
apparaît avec le badge « GROUPE CLIENT ».

**Stockage** : les prospects et la liste de clients restent dans le navigateur
(localStorage), sur l'appareil utilisé. Rien n'est envoyé au serveur. Fais une
« Sauvegarde JSON » régulièrement, et pour passer d'un appareil à l'autre.

### Sélecteur : règles

- **Contraintes dures**, qui écartent un produit :
  - NSF H1 si un contact alimentaire est possible (3H accepté pour un démoulant, A/C/K
    pour un nettoyant) ;
  - plage de température connue qui ne couvre pas le besoin ;
  - application non prévue ;
  - mauvaise famille en mode remplacement (huile ou graisse).

  Les produits écartés restent listés avec la raison.
- **Une donnée manquante n'écarte jamais un produit** : elle est signalée « ? à vérifier ».
  Les autres repères : ✔ conforme, ≈ application voisine, ! à vérifier chez le client
  (contact alimentaire non précisé), ✖ non conforme. Une donnée sans objet (température
  d'un nettoyant ou d'un additif, NLGI d'une huile, viscosité d'une graisse) n'est pas signalée.
- **Critères souples**, qui servent au classement : environnement, conditionnement,
  viscosité ISO VG ou grade NLGI identiques au produit remplacé.
- « Imprimer / PDF » produit une recommandation d'une page à laisser au client.

## Données

| Fichier | Contenu | Qui le maintient |
|---|---|---|
| `public/data/produits.json` | fiches produits (NSF, températures, viscosité, formats, applications, sources) | service technique |
| `public/data/secteurs.json` | secteurs → codes NAF, priorité, argumentaire, produits, cas clients | marketing / ventes |
| `public/data/equivalences.json` | références concurrentes → produit Interflon (vide au départ) | service technique |
| `public/data/referentiels.json` | codes NAF, départements, régions, tranches d'effectif | repris du dépôt de l'API (licence MIT) |

**Important : les fiches produits ont été constituées à partir de sources publiques**
(pages interflon.com, fiches techniques et FDS publiées, listings NSF, distributeurs) et
**doivent être validées par le service technique** avant un usage client. Chaque fiche indique :
- ses sources ;
- les champs restés incertains ;
- un badge « fiche vérifiée » ou « à valider ».

Une valeur n'est renseignée que si une source citée l'affirme ; sinon le champ reste vide.

État au 12/10/2026 :
- 78 produits : 51 avec une catégorie NSF sourcée, 37 avec une plage de température, 20 fiches « vérifiées » ;
- 27 secteurs, dont 22 appuyés par des cas clients publiés par Interflon (chiffres annoncés par Interflon).

Chaque valeur critique (NSF, températures, viscosité, NLGI, conditionnements, applications) est
accompagnée de la citation exacte de sa source : bouton « Détails » d'un produit, section PREUVES.
Les fiches les moins complètes (« à valider ») sont la priorité de relecture.
Après modification d'un fichier, `python3 tests/check_data.py` vérifie sa cohérence (champs,
codes NAF valides, produits référencés existants).

### Sources des entreprises

[API Recherche d'entreprises](https://recherche-entreprises.api.gouv.fr/docs/) (DINUM), à
partir des bases Insee SIRENE et RNE, mise à jour quotidiennement. Gratuite, sans clé.

Limites :
- 7 requêtes/s par adresse IP (le serveur se limite à 5/s et met les réponses en cache 6 h) ;
- 25 entreprises par page ;
- 10 000 résultats au maximum.

Le filtre NAF porte sur l'activité principale de l'entreprise. Les effectifs Insee ont souvent
1 à 2 ans de décalage, et un site dont l'effectif n'est pas communiqué est masqué dès qu'une
taille minimale est choisie.

Les noms de dirigeants affichés sont des données publiques du RNE. Leur usage en prospection
B2B reste soumis au RGPD (intérêt légitime, droit d'opposition) : ne pas les exporter hors de
l'usage commercial.

## Tests

```bash
python3 -m unittest discover -s tests -v   # serveur : validation, normalisation, cache, erreurs, sécurité
node --test tests/*.test.js                # logique du sélecteur
python3 tests/check_data.py                # cohérence des fichiers de données
```

`tests/fake_upstream.py` simule l'API (format exact de sa spécification OpenAPI), ce qui
permet de tester sans réseau :

```bash
python3 tests/fake_upstream.py --port 8799 &
RECHERCHE_ENTREPRISES_URL=http://127.0.0.1:8799 GEOCODE_URLS=http://127.0.0.1:8799/geocode python3 server.py
```

## Structure

```
interflon-tools/
├── server.py            # serveur Python (stdlib) : fichiers statiques + proxy API + géocodage
├── start.command        # lanceur macOS
├── public/
│   ├── index.html, styles.css
│   ├── js/util.js            # utilitaires (échappement HTML, CSV, stockage, autocomplétion)
│   ├── js/prospect.js        # PROS
│   ├── js/pipeline.js        # PIPE
│   ├── js/selector-core.js   # logique du sélecteur (pure, testée avec Node)
│   ├── js/selector.js        # SEL + CAT
│   ├── js/app.js             # navigation, commandes, aide
│   ├── data/                 # données éditables (voir plus haut)
│   └── vendor/leaflet/       # Leaflet 1.9.4 (carte, licence BSD-2), fonds OpenStreetMap
└── tests/
```
