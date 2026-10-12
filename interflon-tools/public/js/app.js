/* App shell: data loading, views, command bar, help. */
(function () {
  "use strict";
  const IFX = window.IFX;
  const { $, $$, esc } = IFX;

  const VIEWS = ["pros", "pipe", "sel", "cat", "aide"];
  let current = "";

  IFX.go = (view) => {
    if (!VIEWS.includes(view)) view = "pros";
    current = view;
    VIEWS.forEach((v) => $(`#view-${v}`).classList.toggle("hidden", v !== view));
    $$("#keybar .fk").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
    if (location.hash !== "#" + view) history.replaceState(null, "", "#" + view);
    if (view === "pros") IFX.pros.onShow();
    if (view === "pipe") IFX.pipe.onShow();
    if (view === "sel") IFX.sel.onShow();
    if (view === "cat") IFX.sel.onShowCatalog();
  };

  // ------------------------------------------------------------------ commands
  const COMMANDS = {
    PROS: (args) => {
      IFX.go("pros");
      if (args.length) IFX.pros.command(args);
    },
    PIPE: () => IFX.go("pipe"),
    SEL: () => IFX.go("sel"),
    CAT: (args) => {
      IFX.go("cat");
      IFX.sel.catalogQuery(args.join(" "));
    },
    AIDE: () => IFX.go("aide"),
    HELP: () => IFX.go("aide"),
  };
  COMMANDS.CARTE = (args) => {
    COMMANDS.PROS(args);
    const b = $('#res-mode button[data-mode="map"]');
    if (b) b.click();
  };

  function runCommand(text) {
    const parts = text.trim().split(/[\s,;]+/).filter(Boolean);
    if (!parts.length) return;
    const cmd = parts[0].toUpperCase();
    if (COMMANDS[cmd]) return COMMANDS[cmd](parts.slice(1));
    // No command word: treat as a product search if it matches products, else as PROS arguments
    const q = text.trim();
    if (IFX.sel.products().some((p) => window.SelectorCore.matchesQuery(p, q))) return COMMANDS.CAT(parts);
    return COMMANDS.PROS(parts);
  }

  // ------------------------------------------------------------------ help
  function renderHelp(meta, segments) {
    $("#aide").innerHTML = `<div class="phead"><span>AIDE</span><span class="phead-r">AIDE / HELP</span></div><div class="fbody">
      <h2>COMMANDES</h2>
      <p>Tape dans la barre du haut (touche <code>/</code> pour y aller), puis Entrée.</p>
      <table>
        <tr><td><code>PROS 29 35 viande lait</code></td><td>Prospection : sélectionne les départements 29 et 35 et les secteurs « viande » et « lait » (ils remplacent la sélection en cours), puis lance la recherche. <code>agro</code> sélectionne tous les secteurs agroalimentaires.</td></tr>
        <tr><td><code>CARTE 56 bois</code></td><td>Idem, résultats affichés sur la carte</td></tr>
        <tr><td><code>PIPE</code></td><td>Mes prospects : statut, relances, notes, exports</td></tr>
        <tr><td><code>SEL</code></td><td>Sélecteur produit (besoin client ou remplacement d'un produit existant)</td></tr>
        <tr><td><code>CAT food lube</code></td><td>Catalogue filtré sur « food lube »</td></tr>
      </table>

      <h2>PROSPECTION</h2>
      <ul class="tight">
        <li><b>Secteurs</b> : chaque secteur regroupe des codes NAF. Tu peux ajouter n'importe quel code NAF à la main.</li>
        <li><b>Zone</b> : départements, région ou rayon autour d'une ville ou de ta position (50 km max).</li>
        <li><b>Taille du site</b> : effectif de l'établissement (source Insee, souvent avec 1 à 2 ans de décalage). Les sites à effectif non communiqué sont masqués dès qu'un minimum est choisi.</li>
        <li><b>Score /100</b> : taille du site (45) + priorité du secteur (30) + site de production probable (10) + chiffre d'affaires (10) + site récent (5). Survole le score pour le détail.</li>
        <li><b>Mes clients</b> : importe dans PIPE un CSV contenant les SIRET ou SIREN de tes clients pour les masquer ou les repérer (badge GROUPE CLIENT si un autre site de l'entreprise est client).</li>
        <li><b>Limites de l'API</b> : 25 entreprises par page, 10 000 résultats maximum, 7 requêtes par seconde. « Tout charger » s'arrête à 1 000 entreprises.</li>
      </ul>

      <h2>SÉLECTEUR</h2>
      <ul class="tight">
        <li>Les contraintes <b>dures</b> (NSF H1 si contact alimentaire, plage de température, application, famille de produit) écartent un produit ; les produits écartés restent visibles avec la raison.</li>
        <li>Une donnée <b>manquante</b> n'écarte jamais un produit : elle est signalée « ? à vérifier ».</li>
        <li>Badge <span class="badge ok">fiche vérifiée</span> : NSF et température confirmées par une source Interflon. <span class="badge warn">à valider</span> : au moins une donnée critique reste à confirmer.</li>
        <li>« Imprimer / PDF » produit une recommandation d'une page à laisser au client.</li>
      </ul>

      <h2>DONNÉES</h2>
      <ul class="tight">
        <li>Entreprises : <a href="https://recherche-entreprises.api.gouv.fr/docs/" target="_blank" rel="noopener">API Recherche d'entreprises</a> (DINUM, données Insee SIRENE et RNE), libre et gratuite.</li>
        <li>Produits : <code>public/data/produits.json</code>${meta.genere ? ` (généré le ${esc(IFX.fmtDate(meta.genere))})` : ""}. ${esc(meta.avertissement || "")}</li>
        <li>Secteurs : <code>public/data/secteurs.json</code> (${segments.length} secteurs, modifiables : codes NAF, priorité, argumentaire).</li>
        <li>Équivalences concurrents : <code>public/data/equivalences.json</code>, à remplir par le service technique.</li>
        <li>Tes prospects et ta liste de clients restent dans <b>ce navigateur</b> (stockage local). Fais une « Sauvegarde JSON » régulièrement, et pour changer d'appareil.</li>
      </ul>
    </div>`;
  }

  // ------------------------------------------------------------------ boot
  async function loadJson(path, fallback) {
    try {
      const r = await fetch(path, { cache: "no-cache" });
      if (!r.ok) throw new Error(r.status);
      return await r.json();
    } catch (e) {
      if (fallback !== undefined) return fallback;
      throw new Error(`Chargement impossible : ${path}`);
    }
  }

  async function boot() {
    let ref, segs, prods, equiv;
    try {
      [ref, segs, prods, equiv] = await Promise.all([
        loadJson("/data/referentiels.json"),
        loadJson("/data/secteurs.json"),
        loadJson("/data/produits.json", { products: [] }),
        loadJson("/data/equivalences.json", { equivalences: [] }),
      ]);
    } catch (e) {
      document.body.insertAdjacentHTML("afterbegin", `<div class="warnbar">${esc(e.message)}</div>`);
      return;
    }
    const segments = (segs.secteurs || []).filter((s) => s && s.key && Array.isArray(s.naf_codes));
    IFX.pipe.init();
    IFX.pros.init(ref, segments);
    IFX.sel.init(prods, equiv);
    renderHelp(prods._meta || {}, segments);

    $("#keybar").addEventListener("click", (e) => {
      const b = e.target.closest("[data-view]");
      if (b) IFX.go(b.dataset.view);
    });
    $("#pipe-count").addEventListener("click", () => IFX.go("pipe"));
    $("#cmdform").addEventListener("submit", (e) => {
      e.preventDefault();
      runCommand($("#cmd").value);
      $("#cmd").value = "";
      $("#cmd").blur();
    });
    document.addEventListener("keydown", (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (e.key === "/" && !typing) {
        e.preventDefault();
        $("#cmd").focus();
      }
      if (e.key === "Escape") IFX.closeDrawer();
    });
    $("#drawer").addEventListener("click", (e) => {
      if (e.target.id === "drawer") IFX.closeDrawer();
    });
    $("#drawer-close").addEventListener("click", IFX.closeDrawer);
    window.addEventListener("hashchange", () => {
      const v = location.hash.slice(1);
      if (v && v !== current) IFX.go(v);
    });

    const tick = () => {
      const d = new Date();
      $("#clock").textContent = d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    };
    tick();
    setInterval(tick, 15000);

    IFX.go(location.hash.slice(1) || "pros");
  }

  boot();
})();
