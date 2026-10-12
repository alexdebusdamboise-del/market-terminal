/* PIPE — saved prospects (status, next action, notes) + list of existing
 * customers (SIRET/SIREN) used to hide or flag them in searches.
 * Everything lives in this browser's localStorage: export regularly. */
(function () {
  "use strict";
  const IFX = window.IFX;
  const { esc, $ } = IFX;
  const PIPE = (IFX.pipe = {});

  const LS_PROSPECTS = "ifx.prospects";
  const LS_CLIENTS = "ifx.clients";

  const STATUSES = {
    a_contacter: "À contacter",
    contacte: "Contacté",
    rdv: "RDV planifié",
    essai: "Essai en cours",
    client: "Client",
    perdu: "Perdu / pas intéressé",
  };

  let prospects = IFX.store.get(LS_PROSPECTS, {}) || {};
  let clients = IFX.store.get(LS_CLIENTS, { sirets: [], sirens: [] }) || { sirets: [], sirens: [] };
  let siretSet = new Set(clients.sirets);
  let sirenSet = new Set(clients.sirens);
  let groupSet = new Set(clients.sirets.map((s) => s.slice(0, 9)));
  let filterStatus = "";

  const save = () => {
    IFX.store.set(LS_PROSPECTS, prospects);
    updateCount();
  };
  const saveClients = () => {
    clients = { sirets: Array.from(siretSet), sirens: Array.from(sirenSet) };
    groupSet = new Set(clients.sirets.map((s) => s.slice(0, 9)));
    IFX.store.set(LS_CLIENTS, clients);
  };

  PIPE.has = (siret) => !!prospects[siret];
  PIPE.get = (siret) => prospects[siret] || null;
  PIPE.all = () => Object.values(prospects);
  PIPE.statusLabel = (s) => STATUSES[s] || s;
  PIPE.statusOptions = (cur) => Object.entries(STATUSES).map(([k, v]) => `<option value="${k}" ${k === cur ? "selected" : ""}>${esc(v)}</option>`).join("");

  // "site": this SIRET (or its whole SIREN) is a customer; "groupe": another site of the company is
  PIPE.clientStatus = (siret, siren) => {
    if ((siret && siretSet.has(siret)) || (siren && sirenSet.has(siren))) return "site";
    if (siren && groupSet.has(siren)) return "groupe";
    return "";
  };

  PIPE.add = (row, patch) => {
    const { co, et, seg } = row;
    const prev = prospects[et.siret] || {};
    const now = new Date().toISOString();
    // follow-up fields survive from the previous record; identity data is refreshed
    prospects[et.siret] = Object.assign(
      { status: "a_contacter", next_date: "", note: "", added: now },
      prev,
      {
        siret: et.siret,
        siren: co.siren,
        nom: co.nom,
        enseigne: (et.enseignes || [])[0] || "",
        adresse: et.adresse,
        code_postal: et.code_postal,
        commune: et.commune,
        departement: et.departement || "",
        naf: et.naf,
        naf_entreprise: co.naf,
        segment: seg ? seg.key : "",
        tranche: et.tranche,
        tranche_entreprise: co.tranche,
        categorie: co.categorie,
        ca: co.ca,
        ca_annee: co.ca_annee,
        date_creation: et.date_creation,
        dirigeants: co.dirigeants || [],
        lat: et.lat,
        lon: et.lon,
      },
      patch || {},
      { updated: now }
    );
    save();
    return prospects[et.siret];
  };

  PIPE.update = (siret, patch) => {
    if (!prospects[siret]) return;
    Object.assign(prospects[siret], patch, { updated: new Date().toISOString() });
    save();
  };

  PIPE.remove = (siret) => {
    delete prospects[siret];
    save();
  };

  function updateCount() {
    const n = Object.keys(prospects).length;
    const due = PIPE.all().filter(isDue).length;
    const el = $("#pipe-count");
    if (el) el.textContent = `${n} PROSPECT${n > 1 ? "S" : ""}${due ? ` · ${due} À RELANCER` : ""}`;
  }

  const isDue = (p) => p.next_date && p.next_date <= IFX.today() && p.status !== "client" && p.status !== "perdu";

  // ------------------------------------------------------------------ view
  function render() {
    const all = PIPE.all();
    const counts = {};
    all.forEach((p) => (counts[p.status] = (counts[p.status] || 0) + 1));
    $("#pipe-stats").innerHTML =
      `<div class="stat ${filterStatus === "" ? "on" : ""}" data-st=""><b>${all.length}</b>Tous</div>` +
      Object.entries(STATUSES)
        .map(([k, v]) => `<div class="stat st-${k} ${filterStatus === k ? "on" : ""}" data-st="${k}"><b>${counts[k] || 0}</b>${esc(v)}</div>`)
        .join("");

    const words = IFX.norm($("#pipe-text").value).split(/\s+/).filter(Boolean);
    const dueOnly = $("#pipe-due").checked;
    const segs = IFX.pros.segments();
    const rows = all
      .filter((p) => !filterStatus || p.status === filterStatus)
      .filter((p) => !dueOnly || isDue(p))
      .filter((p) => {
        if (!words.length) return true;
        const hay = IFX.norm([p.nom, p.enseigne, p.commune, p.code_postal, p.note].join(" "));
        return words.every((w) => hay.includes(w));
      })
      .sort((a, b) => (a.next_date || "9999").localeCompare(b.next_date || "9999") || String(a.nom).localeCompare(String(b.nom)));

    $("#clients-info").textContent = siretSet.size || sirenSet.size ? `Clients importés : ${siretSet.size} SIRET, ${sirenSet.size} SIREN` : "Aucun client importé";

    if (!rows.length) {
      $("#pipe-list").innerHTML = `<div class="empty"><p>${all.length ? "Aucun prospect pour ce filtre." : "Aucun prospect enregistré."}</p>
        <p class="muted">Dans PROS, clique sur ★ ou ouvre une fiche pour suivre un site.</p></div>`;
      return;
    }
    $("#pipe-list").innerHTML = `<table class="grid"><thead><tr>
      <th>Établissement</th><th class="hide-sm">Secteur</th><th>Commune</th><th>Statut</th><th>Prochaine action</th><th>Note</th><th></th></tr></thead><tbody>
      ${rows
        .map((p) => {
          const seg = segs.find((s) => s.key === p.segment);
          return `<tr data-siret="${esc(p.siret)}">
          <td><a href="#" class="name" data-open="${esc(p.siret)}">${esc(p.nom)}</a>${p.enseigne ? `<div class="sub">${esc(p.enseigne)}</div>` : ""}
            <div class="sub">${esc(IFX.pros.trLabel(p.tranche))}</div></td>
          <td class="hide-sm">${seg ? esc(seg.label) : '<span class="muted">—</span>'}</td>
          <td>${esc(p.commune)}<div class="sub">${esc(p.code_postal)}</div></td>
          <td><select class="inline st-${esc(p.status)}" data-f="status">${PIPE.statusOptions(p.status)}</select></td>
          <td><input class="inline ${isDue(p) ? "overdue" : ""}" type="date" data-f="next_date" value="${esc(p.next_date || "")}"/></td>
          <td><input class="inline" type="text" data-f="note" value="${esc(p.note || "")}" placeholder="…"/></td>
          <td><button type="button" class="linkbtn" data-del="${esc(p.siret)}" title="Retirer">✕</button></td></tr>`;
        })
        .join("")}</tbody></table>`;
  }

  function bind() {
    $("#pipe-stats").addEventListener("click", (e) => {
      const s = e.target.closest("[data-st]");
      if (!s) return;
      filterStatus = s.dataset.st;
      render();
    });
    $("#pipe-text").addEventListener("input", render);
    $("#pipe-due").addEventListener("change", render);
    $("#pipe-list").addEventListener("change", (e) => {
      const f = e.target.dataset.f;
      const tr = e.target.closest("tr[data-siret]");
      if (!f || !tr) return;
      PIPE.update(tr.dataset.siret, { [f]: e.target.value });
      if (f !== "note") render();
    });
    $("#pipe-list").addEventListener("click", (e) => {
      const del = e.target.closest("[data-del]");
      if (del) {
        const p = PIPE.get(del.dataset.del);
        if (p && confirm(`Retirer « ${p.nom} » de tes prospects ?`)) {
          PIPE.remove(del.dataset.del);
          render();
        }
        return;
      }
      const open = e.target.closest("[data-open]");
      if (open) {
        e.preventDefault();
        const p = PIPE.get(open.dataset.open);
        if (p) IFX.pros.openSaved(p);
      }
    });
    $("#pipe-csv").addEventListener("click", exportCsv);
    $("#pipe-json").addEventListener("click", () =>
      IFX.download(`prospects-sauvegarde-${IFX.today()}.json`, JSON.stringify({ version: 1, exported: new Date().toISOString(), prospects, clients }, null, 1), "application/json")
    );
    $("#pipe-import").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (!file) return;
      try {
        const data = JSON.parse(await IFX.readFile(file));
        const incoming = data.prospects || {};
        let n = 0;
        Object.values(incoming).forEach((p) => {
          if (!p || !/^\d{14}$/.test(p.siret || "")) return;
          const cur = prospects[p.siret];
          if (!cur || (p.updated || "") > (cur.updated || "")) {
            prospects[p.siret] = p;
            n++;
          }
        });
        if (data.clients) {
          (data.clients.sirets || []).forEach((s) => /^\d{14}$/.test(s) && siretSet.add(s));
          (data.clients.sirens || []).forEach((s) => /^\d{9}$/.test(s) && sirenSet.add(s));
          saveClients();
        }
        save();
        render();
        IFX.toast(`${n} prospect(s) restauré(s) ou mis à jour`);
      } catch (err) {
        IFX.toast("Fichier invalide : " + err.message, true);
      }
    });
    $("#clients-import").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      e.target.value = "";
      if (!file) return;
      const { sirets, sirens } = PIPE.parseClients(await IFX.readFile(file));
      if (!sirets.length && !sirens.length) return IFX.toast("Aucun SIRET (14 chiffres) ni SIREN (9 chiffres) trouvé dans le fichier", true);
      const replace = siretSet.size + sirenSet.size > 0 && confirm("Remplacer la liste de clients existante ?\n(OK = remplacer, Annuler = ajouter)");
      if (replace) {
        siretSet = new Set();
        sirenSet = new Set();
      }
      sirets.forEach((s) => siretSet.add(s));
      sirens.forEach((s) => sirenSet.add(s));
      saveClients();
      render();
      IFX.pros.refresh();
      IFX.toast(`${sirets.length} SIRET et ${sirens.length} SIREN importés`);
    });
  }

  // Accepts any CSV/TXT export: picks 14-digit SIRETs and 9-digit SIRENs,
  // tolerating "123 456 789 00012"-style spacing.
  PIPE.parseClients = (text) => {
    const sirets = new Set();
    const sirens = new Set();
    String(text)
      .split(/\r?\n/)
      .forEach((line) => {
        const compact = line.replace(/(\d)[ . ](?=\d)/g, "$1");
        (compact.match(/(?<!\d)\d{14}(?!\d)/g) || []).forEach((s) => sirets.add(s));
        (compact.match(/(?<!\d)\d{9}(?!\d)/g) || []).forEach((s) => sirens.add(s));
      });
    return { sirets: Array.from(sirets), sirens: Array.from(sirens) };
  };

  function exportCsv() {
    const segs = IFX.pros.segments();
    const head = ["Raison sociale", "Enseigne", "SIRET", "SIREN", "Adresse", "Code postal", "Commune", "Secteur", "NAF", "Effectif site", "Statut", "Prochaine action", "Note", "Ajouté le", "Mis à jour"];
    const data = PIPE.all().map((p) => {
      const seg = segs.find((s) => s.key === p.segment);
      return [p.nom, p.enseigne, p.siret, p.siren, p.adresse, p.code_postal, p.commune, seg ? seg.label : "", p.naf, IFX.pros.trLabel(p.tranche), STATUSES[p.status] || p.status, p.next_date, p.note, (p.added || "").slice(0, 10), (p.updated || "").slice(0, 10)];
    });
    IFX.download(`mes-prospects-${IFX.today()}.csv`, IFX.csv([head].concat(data)), "text/csv;charset=utf-8");
  }

  PIPE.init = () => {
    bind();
    updateCount();
  };
  PIPE.onShow = render;
})();
