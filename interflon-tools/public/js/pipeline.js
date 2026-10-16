/* PIPE — saved prospects (status, next action, notes) + list of existing
 * customers (SIRET/SIREN) used to hide or flag them in searches.
 * This browser's localStorage always holds a copy. In the claude.ai page, the
 * viewer's private db space (data/users/<id>/…) is the reference, so the PC and
 * the phone share one pipeline; the installed version stays on this browser. */
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

  // Another tab may have written since we loaded: always merge into the latest copy
  const reload = () => {
    prospects = IFX.store.get(LS_PROSPECTS, {}) || {};
  };
  const reloadClients = () => {
    clients = IFX.store.get(LS_CLIENTS, { sirets: [], sirens: [] }) || { sirets: [], sirens: [] };
    siretSet = new Set(clients.sirets || []);
    sirenSet = new Set(clients.sirens || []);
    groupSet = new Set((clients.sirets || []).map((s) => s.slice(0, 9)));
  };
  const viewVisible = () => {
    const v = document.getElementById("view-pipe");
    return v && !v.classList.contains("hidden");
  };
  // keep both PIPE and PROS in sync after any change, whoever made it
  const changed = () => {
    updateCount();
    if (viewVisible()) render();
    if (IFX.pros && IFX.pros.refresh) IFX.pros.refresh();
  };
  const save = () => {
    IFX.store.set(LS_PROSPECTS, prospects);
    changed();
  };
  const saveClients = () => {
    clients = { sirets: Array.from(siretSet), sirens: Array.from(sirenSet) };
    groupSet = new Set(clients.sirets.map((s) => s.slice(0, 9)));
    IFX.store.set(LS_CLIENTS, clients);
    pushClients();
  };

  // ------------------------------------------------------------------ sync (claude.ai db)
  const cloud = { col: null, clientsDoc: null, ready: false, queue: new Map(), clientsBusy: false, clientsAgain: false };

  function setSyncInfo(state, extra) {
    const el = $("#sync-info");
    if (!el) return;
    const text = {
      cloud: "Synchronisé : les mêmes prospects sur ton PC et ton téléphone.",
      local: IFX.STATIC
        ? "Enregistré dans ce navigateur uniquement (synchronisation indisponible ici)."
        : "Version installée : prospects enregistrés dans ce navigateur. Pour les retrouver sur ton téléphone, fais « Sauvegarde JSON » ici puis « Restaurer JSON » dans le Terminal en ligne.",
      error: "Synchronisation interrompue : tes modifications restent dans ce navigateur. Recharge la page pour la relancer.",
    }[state];
    el.textContent = text + (extra ? " " + extra : "");
    el.classList.toggle("sync-on", state === "cloud");
  }

  function syncFailed(e) {
    if (e && e.code === "quota_exceeded") return IFX.toast("Espace de synchronisation plein : supprime des prospects perdus ou exporte-les.", true);
    if (e && (e.code === "revoked" || e.code === "not_granted" || e.code === "capability_disabled")) {
      cloud.ready = false;
      setSyncInfo("error");
    }
  }

  // one write at a time per prospect; a change made meanwhile is written right after
  function pushRemote(siret) {
    if (!cloud.ready) return;
    const busy = cloud.queue.get(siret);
    if (busy) return void (busy.again = true);
    const job = { again: false };
    cloud.queue.set(siret, job);
    (async () => {
      do {
        job.again = false;
        const p = prospects[siret];
        try {
          if (p) await cloud.col.doc(siret).set(p);
          else await cloud.col.doc(siret).delete();
        } catch (e) {
          syncFailed(e);
        }
      } while (job.again && cloud.ready);
      cloud.queue.delete(siret);
    })();
  }

  function pushClients() {
    if (!cloud.ready) return;
    if (cloud.clientsBusy) return void (cloud.clientsAgain = true);
    cloud.clientsBusy = true;
    (async () => {
      do {
        cloud.clientsAgain = false;
        try {
          await cloud.clientsDoc.set({ sirets: Array.from(siretSet), sirens: Array.from(sirenSet), updated: new Date().toISOString() });
        } catch (e) {
          syncFailed(e);
        }
      } while (cloud.clientsAgain && cloud.ready);
      cloud.clientsBusy = false;
    })();
  }

  async function connectCloud() {
    if (!window.claude || typeof window.claude.use !== "function") return setSyncInfo("local");
    let db = null;
    let user = null;
    try {
      [db, user] = await Promise.all([window.claude.use("db"), window.claude.use("user")]);
    } catch (e) {
      /* treated as unavailable */
    }
    const uid = user ? await user.id() : null;
    if (!db || !uid) return setSyncInfo("local");
    cloud.col = db.doc(`data/users/${uid}/pipe`).collection("prospects");
    cloud.clientsDoc = db.doc(`data/users/${uid}/clients`);

    let first = true;
    cloud.col.onSnapshot(
      (snap) => {
        if (first && snap.metadata.fromCache) return; // merge only against the server's view
        const remote = {};
        snap.docs.forEach((d) => {
          const p = sanitize(d.data());
          if (p) remote[p.siret] = p;
        });
        if (first) {
          first = false;
          // what this browser has and the synced space lacks (or holds in an older state) goes up
          const localOnly = Object.values(prospects).filter((p) => !remote[p.siret] || (p.updated || "") > (remote[p.siret].updated || ""));
          Object.assign(remote, Object.fromEntries(localOnly.map((p) => [p.siret, p])));
          prospects = remote;
          cloud.ready = true;
          localOnly.forEach((p) => pushRemote(p.siret));
          setSyncInfo("cloud");
          if (localOnly.length) IFX.toast(`${localOnly.length} prospect(s) de ce navigateur ajouté(s) à ta synchronisation`);
        } else prospects = remote;
        IFX.store.set(LS_PROSPECTS, prospects);
        changed();
      },
      (e) => {
        cloud.ready = false;
        setSyncInfo("error");
      }
    );

    let firstClients = true;
    cloud.clientsDoc.onSnapshot(
      (snap) => {
        if (firstClients && snap.metadata.fromCache) return;
        const isFirst = firstClients;
        firstClients = false;
        if (!snap.exists) {
          if (isFirst && (siretSet.size || sirenSet.size)) pushClients(); // first device to sync sends its list
          return;
        }
        const d = snap.data() || {};
        const remoteSirets = (d.sirets || []).filter((s) => /^\d{14}$/.test(s));
        const remoteSirens = (d.sirens || []).filter((s) => /^\d{9}$/.test(s));
        // first contact: keep this browser's customers too, then send the union
        const grows = isFirst && (Array.from(siretSet).some((s) => !remoteSirets.includes(s)) || Array.from(sirenSet).some((s) => !remoteSirens.includes(s)));
        siretSet = new Set(isFirst ? remoteSirets.concat(Array.from(siretSet)) : remoteSirets);
        sirenSet = new Set(isFirst ? remoteSirens.concat(Array.from(sirenSet)) : remoteSirens);
        if (grows) pushClients();
        clients = { sirets: Array.from(siretSet), sirens: Array.from(sirenSet) };
        groupSet = new Set(clients.sirets.map((s) => s.slice(0, 9)));
        IFX.store.set(LS_CLIENTS, clients);
        changed();
      },
      () => {}
    );
  }

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
    reload();
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
    pushRemote(et.siret);
    return prospects[et.siret];
  };

  PIPE.update = (siret, patch, rerender) => {
    reload();
    if (!prospects[siret]) return;
    prospects[siret] = Object.assign({}, prospects[siret], patch, { updated: new Date().toISOString() });
    IFX.store.set(LS_PROSPECTS, prospects);
    pushRemote(siret);
    updateCount();
    if (rerender && viewVisible()) render();
    if (IFX.pros && IFX.pros.refresh) IFX.pros.refresh();
  };

  PIPE.remove = (siret) => {
    reload();
    delete prospects[siret];
    save();
    pushRemote(siret);
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
      `<button type="button" class="stat ${filterStatus === "" ? "on" : ""}" data-st=""><b>${all.length}</b>Tous</button>` +
      Object.entries(STATUSES)
        .map(([k, v]) => `<button type="button" class="stat st-${k} ${filterStatus === k ? "on" : ""}" data-st="${k}"><b>${counts[k] || 0}</b>${esc(v)}</button>`)
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

    $("#clients-info").innerHTML =
      siretSet.size || sirenSet.size
        ? `Clients importés : ${siretSet.size} SIRET, ${sirenSet.size} SIREN <button type="button" class="linkbtn" id="clients-clear">vider</button>`
        : "Aucun client importé";

    if (!rows.length) {
      $("#pipe-list").innerHTML = `<div class="empty"><p>${all.length ? "Aucun prospect pour ce filtre." : "Aucun prospect enregistré."}</p>
        <p class="muted">Dans PROS, clique sur ★ ou ouvre une fiche pour suivre un site.</p></div>`;
      return;
    }
    $("#pipe-list").innerHTML = `<table class="grid"><thead><tr>
      <th>Établissement</th><th class="hide-sm">Secteur</th><th class="hide-sm">Commune</th><th>Statut</th><th>Prochaine action</th><th>Note</th><th></th></tr></thead><tbody>
      ${rows
        .map((p) => {
          const seg = segs.find((s) => s.key === p.segment);
          return `<tr data-siret="${esc(p.siret)}">
          <td><a href="#" class="name" data-open="${esc(p.siret)}">${esc(p.nom)}</a>${p.enseigne ? `<div class="sub">${esc(p.enseigne)}</div>` : ""}
            <div class="sub">${esc(IFX.pros.trLabel(p.tranche))}<span class="show-sm"> · ${esc(p.commune)}</span></div></td>
          <td class="hide-sm">${seg ? esc(seg.label) : '<span class="muted">—</span>'}</td>
          <td class="hide-sm">${esc(p.commune)}<div class="sub">${esc(p.code_postal)}</div></td>
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
    $("#clients-info").addEventListener("click", async (e) => {
      if (e.target.id !== "clients-clear") return;
      if (!(await IFX.confirm("Vider la liste de clients ? Ils réapparaîtront dans la prospection.", "Vider la liste"))) return;
      siretSet = new Set();
      sirenSet = new Set();
      saveClients();
      changed();
      IFX.toast("Liste de clients vidée");
    });
    $("#pipe-due").addEventListener("change", render);
    $("#pipe-list").addEventListener("change", (e) => {
      const f = e.target.dataset.f;
      const tr = e.target.closest("tr[data-siret]");
      if (!f || !tr) return;
      PIPE.update(tr.dataset.siret, { [f]: e.target.value }, f === "status");
      // never rebuild the table while a date is being typed (Chrome fires change at the 1st valid year digit)
      if (f === "next_date") e.target.classList.toggle("overdue", !!isDue(PIPE.get(tr.dataset.siret)));
    });
    $("#pipe-list").addEventListener("click", async (e) => {
      const del = e.target.closest("[data-del]");
      if (del) {
        const p = PIPE.get(del.dataset.del);
        if (p && (await IFX.confirm(`Retirer « ${p.nom} » de tes prospects ?`, "Retirer"))) {
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
        const incoming = Object.values(data.prospects || {}).map(sanitize).filter(Boolean);
        if (!incoming.length && !data.clients) throw new Error("aucun prospect reconnu");
        reload();
        const changedSirets = [];
        incoming.forEach((p) => {
          const cur = prospects[p.siret];
          if (!cur || p.updated > (cur.updated || "")) {
            prospects[p.siret] = p;
            changedSirets.push(p.siret);
          }
        });
        const n = changedSirets.length;
        changedSirets.forEach(pushRemote);
        if (data.clients) {
          reloadClients();
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
      reloadClients();
      if (!(await IFX.confirm(`Importer ${sirets.length} SIRET et ${sirens.length} SIREN comme clients ? Ils seront masqués de la prospection.`, "Importer"))) return;
      const replace =
        siretSet.size + sirenSet.size > 0 &&
        (await IFX.confirm("Une liste de clients existe déjà. Remplacer la liste, ou ajouter ces clients à la liste actuelle ?", "Remplacer la liste", "Ajouter à la liste"));
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

  // Coerce a restored record to the shape the app relies on (hand-edited backups…)
  const STR_FIELDS = ["siren", "nom", "enseigne", "adresse", "code_postal", "commune", "departement", "naf", "naf_entreprise", "segment", "tranche", "tranche_entreprise", "categorie", "ca_annee", "date_creation", "note", "added", "updated"];
  function sanitize(p) {
    if (!p || typeof p !== "object" || !/^\d{14}$/.test(String(p.siret || ""))) return null;
    const out = Object.assign({}, p, { siret: String(p.siret) });
    STR_FIELDS.forEach((k) => (out[k] = p[k] === null || p[k] === undefined ? "" : String(p[k])));
    out.status = STATUSES[p.status] ? p.status : "a_contacter";
    out.next_date = /^\d{4}-\d{2}-\d{2}$/.test(String(p.next_date || "")) ? p.next_date : "";
    out.dirigeants = Array.isArray(p.dirigeants) ? p.dirigeants.filter((d) => d && typeof d.nom === "string") : [];
    ["lat", "lon", "ca"].forEach((k) => (out[k] = typeof p[k] === "number" && isFinite(p[k]) ? p[k] : null));
    return out;
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
        const lineSirets = compact.match(/(?<!\d)\d{14}(?!\d)/g) || [];
        lineSirets.forEach((s) => sirets.add(s));
        // "SIREN;SIRET" exports: the SIREN only identifies the company of that site
        (compact.match(/(?<!\d)\d{9}(?!\d)/g) || []).filter((s) => !lineSirets.some((t) => t.startsWith(s))).forEach((s) => sirens.add(s));
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
    connectCloud();
    window.addEventListener("storage", (e) => {
      if (e.key === LS_PROSPECTS) reload();
      else if (e.key === LS_CLIENTS) reloadClients();
      else return;
      changed();
    });
  };
  PIPE.onShow = render;
})();
