// live-plan (#257): die Ansicht, ohne Bibliothek. "/" zeigt die Liste aus /api/liste, "/REPO/SLUG"
// eine Sitzung aus /api/REPO/SLUG, neu gelesen bei jeder Dateiaenderung (SSE /ereignisse). Ein
// Klick auf eine Option schickt POST .../entscheidung, ebenso eine eigene Antwort (Freitext, mit
// eigen: true); alles andere aendert nur der Agent.
//
// Aufbau nach der Vorlage im Things-Stil: Kopf mit Icon, Kurztext und Tags, Ueberblick in drei Karten,
// Teil 1 Sitzung und Fortschritt (Verbrauch, Fortschritt mit Phasen, vier Kacheln aus Issue 320, genau eine
// Jetzt-Zeile, dann in zwei Spalten Agenten, Fragen an Sie, Offen, Anforderungen, Entscheidungen; die
// Abschnitte aus ueberblick in logik.ts), in einem Firstmate-Home der Abschnitt Firstmate (Worker-Karten,
// Captain-Inbox, Warteschlange, Projekte aus GET .../firstmate), Teil 2 Dokumentation, darunter Dateien und der Fuss. Verbrauch,
// Fortschritt und Agenten kommen aus der Register-JSON (S8).
// Die Zeichenfunktionen haengen nicht am DOM und stehen unter globalThis.LivePlanAnsicht, damit
// die Tests sie ohne Browser pruefen.
(function () {
  "use strict";
  var G = globalThis;
  var doc = G.document;
  var wurzel = doc.getElementById("lp");
  var teile = G.location.pathname.split("/").filter(Boolean);
  var REPO = teile.length === 2 ? decodeURIComponent(teile[0]) : null;
  var SLUG = teile.length === 2 ? decodeURIComponent(teile[1]) : null;
  var API = REPO ? "/api/" + encodeURIComponent(REPO) + "/" + encodeURIComponent(SLUG) : null;
  // ?handout=1 (#328): wie die Seite ohne Sitzungsdetails (Kopf, Ueberblick, Anforderungen, Entscheidungen, Dokumentation), dunkel, 1600 px breit.
  var handout = /(^|[?&])handout=1(&|$)/.test(G.location.search || "");
  var BELEG = REPO ? "/beleg/" + encodeURIComponent(REPO) + "/" + encodeURIComponent(SLUG) + "/" : null;
  var THEMEN = [["auto", "Auto"], ["hell", "Hell"], ["dunkel", "Dunkel"]];
  /** Zustand einer Anforderung (S23): dieselben Zeichen wie die Status der Schritte. */
  var ZUSTAND = { erfuellt: ["✓", "erfüllt"], "in-arbeit": ["●", "in Arbeit"], offen: ["○", "offen"] };
  var GATE_TEXT = { jetzt: "jetzt", mensch: "wartet auf Mensch", spaeter: "spaeter" };
  /** Das Gate eines Blatts in Offen als kurze Marke, das volle Wort im title (S29, M1). */
  /** Entschiedene Fragen, die Fragen an Sie ohne Aufklappen zeigt. */
  var FRAGEN_N = 5;
  var GATE_MARKE = { jetzt: "jetzt", mensch: "Mensch", spaeter: "später" };
  /** Glyph und Farbe je Gate: Stern wartet auf Sie, halber Ring jetzt, Ring spaeter. */
  var GATE_GLYPH = { jetzt: ["laeuft", "var(--l1)"], mensch: ["mensch", "var(--l4)"], spaeter: ["aktion", "var(--st-offen)"] };
  /** Die Phasen des Fortschritts, wie sie die Mod live-plan-sitzung kennt. */
  var PHASEN = ["plan", "design", "delegate", "review", "close"];
  var D = null;
  var sel = null;
  /** Id der Anforderung, deren Beweisbild im Modal steht (A20). */
  var modal = null;
  /** Die Datei, deren Diff im Modal steht: {p, s, daten | fehler}; ohne daten und fehler laedt sie noch. */
  var diffAuf = null;
  var zielAuf = false;
  /** Eigene Antworten im Entstehen und ihr letzter Fehler, je Frage-Id: ein Neuzeichnen verliert nichts. */
  var eigenText = {};
  var eigenFehler = {};
  /** Fester Zeitpunkt fuer die Tests (setzeJetzt); sonst gilt die Uhr des Browsers. */
  var jetztFest = null;

  // --- Speicher ---------------------------------------------------------------------------
  function lies(schluessel) {
    try {
      return G.localStorage ? G.localStorage.getItem(schluessel) : null;
    } catch (e) {
      return null;
    }
  }
  function merke(schluessel, wert) {
    try {
      if (G.localStorage) G.localStorage.setItem(schluessel, wert);
    } catch (e) {
      /* privates Fenster: dann gilt die Wahl nur bis zum Neuladen */
    }
  }
  function medien(abfrage) {
    return typeof G.matchMedia === "function" && G.matchMedia(abfrage).matches;
  }

  // --- Thema (S18): Auto, Hell, Dunkel; Vorgabe dunkel ---------------------------------------
  function thema(wert) {
    return THEMEN.some(function (t) { return t[0] === wert; }) ? wert : "dunkel";
  }
  function setzeThema(wert) {
    var t = thema(wert);
    doc.documentElement.dataset.thema = t;
    merke("live-plan.thema", t);
    if (wurzel) {
      Array.prototype.forEach.call(wurzel.querySelectorAll(".lp-thema button[data-thema]"), function (b) {
        b.classList.toggle("aktiv", b.dataset.thema === t);
        b.setAttribute("aria-pressed", String(b.dataset.thema === t));
      });
    }
    return t;
  }
  function themaSchalter() {
    var t = thema(doc.documentElement.dataset.thema);
    return '<div class="lp-thema seg" role="group" aria-label="Thema">' + THEMEN.map(function (x) {
      return '<button type="button" class="' + (x[0] === t ? "aktiv" : "") + '" data-thema="' + x[0] + '" aria-pressed="' + (x[0] === t) + '">' + x[1] + "</button>";
    }).join("") + "</div>";
  }
  // Im Handout gilt dunkel, ohne die Wahl des Nutzers zu speichern.
  doc.documentElement.dataset.thema = handout ? "dunkel" : thema(lies("live-plan.thema"));
  if (handout) doc.documentElement.dataset.handout = "1";

  // --- Hilfen ------------------------------------------------------------------------------
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function jetztMs() {
    return jetztFest === null ? Date.now() : jetztFest;
  }
  /** Die verstrichene Zeit (A21), gleich wie verstrichen() in logik.ts: jetzt, 13m, 2h 13m, 3T. */
  function verstrichen(iso, jetzt) {
    if (!iso) return "";
    var t = new Date(iso).getTime();
    var n = jetzt === undefined ? jetztMs() : typeof jetzt === "number" ? jetzt : new Date(jetzt).getTime();
    if (isNaN(t) || isNaN(n)) return "";
    var minuten = Math.floor((n - t) / 60000);
    if (minuten < 1) return "jetzt";
    if (minuten < 60) return minuten + "m";
    if (minuten < 1440) return Math.floor(minuten / 60) + "h " + (minuten % 60) + "m";
    return Math.floor(minuten / 1440) + "T";
  }
  /** Alter in einer Einheit fuer jeden Punkt (Nutzerwunsch 2026-10-11): 1m, 3h, 2d, 1w; unter einer Minute 1m. */
  function alterKurz(iso, jetzt) {
    if (!iso) return "";
    var t = new Date(iso).getTime();
    var n = jetzt === undefined ? jetztMs() : typeof jetzt === "number" ? jetzt : new Date(jetzt).getTime();
    if (isNaN(t) || isNaN(n)) return "";
    var minuten = Math.max(1, Math.floor((n - t) / 60000));
    if (minuten < 60) return minuten + "m";
    if (minuten < 1440) return Math.floor(minuten / 60) + "h";
    if (minuten < 10080) return Math.floor(minuten / 1440) + "d";
    return Math.floor(minuten / 10080) + "w";
  }
  function zwei(n) {
    return String(n).padStart(2, "0");
  }
  /** Die volle Ortszeit TT.MM. HH:MM, nur fuer den title. */
  function ortszeit(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return zwei(d.getDate()) + "." + zwei(d.getMonth() + 1) + ". " + zwei(d.getHours()) + ":" + zwei(d.getMinutes());
  }
  /** Eine Zeitangabe: sichtbar die verstrichene Zeit, die Ortszeit im title, die ISO-Zeit in data-um fuer den Takt. */
  function zeitAngabe(iso, cls) {
    if (!iso) return "";
    return '<span class="' + (cls || "uhr") + '" data-um="' + esc(iso) + '" title="' + esc(ortszeit(iso)) + '">' + esc(verstrichen(iso)) + "</span>";
  }
  /** Ein Belegpfad als URL, je Segment kodiert (S29, K3): `#` und `?` bleiben Teil des Namens. */
  function belegUrl(rel) {
    return BELEG + String(rel).split("/").map(encodeURIComponent).join("/");
  }
  var ART = {
    bauen: '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="3.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
    mensch: '<svg viewBox="0 0 10 10"><path d="M5 1 9 5 5 9 1 5Z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
    neu: '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.5 1.5"/></svg>',
  };
  function schritt(id) {
    return D.plan.schritte.find(function (s) { return s.id === id; });
  }
  function frage(id) {
    return D.plan.fragen.find(function (f) { return f.id === id; });
  }
  /** Eine eigene Antwort: entschieden, aber mit keinem label der Optionen. */
  function istEigen(f) {
    return !!(f && f.entscheidung) && !f.optionen.some(function (o) { return o.label === f.entscheidung; });
  }
  function zeit(id) {
    return (D.zeiten.je && D.zeiten.je[id]) || {};
  }

  // --- Kopf (S26): Titel und Thema, Ziel auf zwei Zeilen, eine Meta-Zeile ----------------------
  function gitText() {
    var g = D.git || {};
    if (g.branch === undefined) return '<span class="unbekannt">Git-Stand unbekannt</span>';
    var git = "<b>" + (g.branch === null ? "Branch unbekannt" : esc(g.branch)) + "</b>";
    git += " · " + (g.dateien === null ? "Dateien vs origin/main unbekannt" : g.dateien + " Datei" + (g.dateien === 1 ? "" : "en") + " vs origin/main");
    if (g.gitbutler === null) git += ' · <span class="unbekannt">GitButler unbekannt</span>';
    else if (!g.gitbutler) git += ' · <span class="aus">GitButler aus</span>';
    else {
      var br = g.branches;
      git += ' · <span class="an" title="' + esc(br ? br.join("\n") : "Branches unbekannt") + '">GitButler an' + (br ? " · " + br.length + " Branch" + (br.length === 1 ? "" : "es") : " · Branches unbekannt") + "</span>";
    }
    return git;
  }

  /** Ring mit Torte wie das Icon der Vorlage: der Anteil 0..1 als gefuelltes Stueck. */
  function torte(anteil, gr) {
    var a = Math.max(0, Math.min(1, zahl(anteil))), g = gr || 30;
    var r2 = function (n) { return Math.round(n * 100) / 100; };
    var w = a * 2 * Math.PI;
    var stueck = a >= 1 ? '<circle cx="15" cy="15" r="9" fill="var(--l1)"/>'
      : a > 0 ? '<path d="M15 15 V6 A9 9 0 ' + (a > 0.5 ? 1 : 0) + " 1 " + r2(15 + 9 * Math.sin(w)) + " " + r2(15 - 9 * Math.cos(w)) + ' Z" fill="var(--l1)"/>' : "";
    return '<svg class="lp-torte" width="' + g + '" height="' + g + '" viewBox="0 0 30 30" aria-hidden="true"><circle cx="15" cy="15" r="13" fill="none" stroke="var(--l1)" stroke-width="2.4"/>' + stueck + "</svg>";
  }
  function anteilFertig(p) {
    var S = p.schritte || [];
    return S.length ? S.filter(function (s) { return s.status === "fertig"; }).length / S.length : 0;
  }
  /** Das Ziel auf zwei Zeilen, ein Klick klappt es auf; fest (Handout) immer ganz. */
  function zielAbsatz(p, fest) {
    if (!p.ziel) return "";
    return fest ? '<p class="lp-ziel voll">' + esc(p.ziel) + "</p>"
      : '<p class="lp-ziel' + (zielAuf ? " voll" : "") + '" title="' + esc(p.ziel) + '" data-ziel tabindex="0">' + esc(p.ziel) + "</p>";
  }
  /** Unter dem Titel: doku.kurz mit doku.untertitel fett davor, sonst das Ziel; darunter Status und Tags als Chips. */
  function kopfText(p, fest) {
    var d = p.doku || {};
    var notiz = d.kurz ? '<p class="lp-notiz">' + (d.untertitel ? "<b>" + esc(d.untertitel) + "</b> " : "") + esc(d.kurz) + "</p>" : zielAbsatz(p, fest);
    var tags = (d.status ? [dokuTag(d.status, "blau")] : []).concat((d.tags || []).map(function (t) { return dokuTag(t); }));
    return notiz + (tags.length ? '<div class="lp-tags" data-testid="sitzung-tags">' + tags.join("") + "</div>" : "");
  }

  /** Icon und Titel mit dem Git-Stand rechts daneben (Pfad der Sitzungsdatei nur im title) und Thema, darunter Kurztext oder Ziel und die Tags. */
  function kopf() {
    var p = D.plan;
    return (
      '<header class="lp-kopf">' +
      '<div class="lp-oben"><a class="lp-zurueck" href="/" title="alle Sitzungen"></a>' + torte(anteilFertig(p)) + '<h1 data-testid="sitzung-titel">' + esc(p.titel || D.slug) + "</h1>" +
      '<span class="lp-git" data-testid="sitzung-git" title="' + esc(D.repo + "/.live-plan/" + D.slug + ".yaml") + '">' + gitText() + "</span>" + themaSchalter() + "</div>" +
      kopfText(p) + "</header>"
    );
  }

  /** Eine Ueberschrift der Vorlage: blau, rechts grau eine Zahl oder ein Stand (HTML, schon escaped). */
  function ueberschrift(titel, rechts) {
    return '<h2 class="lp-h">' + esc(titel) + (rechts ? ' <span class="zaehler">' + rechts + "</span>" : "") + "</h2>";
  }
  /** Kopf eines Teils: `Teil 1` klein, der Titel gross, rechts der Untertitel. */
  function teilKopf(nr, titel, unter) {
    return '<div class="lp-teil" data-teil="' + nr + '"><i>Teil ' + nr + "</i><strong>" + esc(titel) + "</strong>" + (unter ? "<span>" + esc(unter) + "</span>" : "") + "</div>";
  }

  // --- Ueberblick (Vorlage): Problem, Loesung, Fuer wen aus doku.ueberblick; ein Text als Absatz ------
  var UEBER_KARTEN = [["problem", "Problem", "flagge", "var(--rot)"], ["loesung", "Lösung", "aktion", "var(--l1)"], ["fuer_wen", "Für wen", "mensch", "var(--l4)"]];
  function ueberblickKarten() {
    var u = D.plan && D.plan.doku && D.plan.doku.ueberblick;
    if (!u) return "";
    var inhalt = typeof u === "string" ? '<p class="lp-ueber-text">' + esc(u) + "</p>"
      : UEBER_KARTEN.filter(function (k) { return u[k[0]]; }).map(function (k) {
        return dokuZeile(dokuGlyph(k[2], k[3]), "<b>" + k[1] + "</b>", esc(u[k[0]]));
      }).join("");
    if (!inhalt) return "";
    return '<section class="lp-ueber" data-testid="sitzung-karten">' + ueberschrift("Überblick") + (typeof u === "string" ? inhalt : '<div class="lp-karten">' + inhalt + "</div>") + "</section>";
  }

  // --- Teil 1 (Vorlage): Kopf des Teils, Verbrauch, Fortschritt mit Phasen und Balken -----------------
  function registerVon() {
    var L = D && D.live;
    return L && typeof L === "object" ? L : null;
  }
  function teilEins(fest) {
    var p = D.plan;
    // With doku.kurz in the head, the goal moves under the heading of part 1.
    return teilKopf(1, "Sitzung und Fortschritt", p.stand && p.stand.thema) + (p.doku && p.doku.kurz ? zielAbsatz(p, fest) : "");
  }
  function verbrauchTeil() {
    var L = registerVon();
    return L ? '<section class="lp-verbrauch">' + ueberschrift("Verbrauch") + verbrauch(L) + "</section>" : "";
  }
  /**
   * Fortschritt der Anforderungen (Nutzerwunsch 2026-10-11): ein Segment je Anforderung, nach Wellen
   * gruppiert -- die Welle einer Anforderung ist die spaeteste Welle ihrer `erfuellt_mit`-Schritte, ohne
   * Schritt steht sie am Ende. Erfuellt voll, in Arbeit schraffiert; rechts `x / y erfüllt · %`, unter
   * dem Balken je Welle `W1 Name x/y`. Die Phasen kommen weiter aus dem Register, wenn eines da ist.
   */
  function fortschrittTeil() {
    var p = D.plan, A = Array.isArray(p.anforderungen) ? p.anforderungen : [];
    if (!A.length) return "";
    var je = (D.erfuellung && D.erfuellung.je) || {};
    var zustand = function (a) { return je[a.id] || "offen"; };
    var wellen = Array.isArray(p.wellen) ? p.wellen : [];
    var rang = Object.create(null), welleVon = Object.create(null);
    wellen.forEach(function (w, i) { rang[w.id] = i; });
    (p.schritte || []).forEach(function (s) { welleVon[s.id] = s.welle; });
    var gruppen = wellen.map(function (w) { return { w: w, a: [] }; }), ohne = { w: null, a: [] };
    A.forEach(function (a) {
      var spaet = -1;
      (Array.isArray(a.erfuellt_mit) ? a.erfuellt_mit : []).forEach(function (sid) {
        var r = rang[welleVon[sid]];
        if (r !== undefined && r > spaet) spaet = r;
      });
      (spaet < 0 ? ohne : gruppen[spaet]).a.push(a);
    });
    gruppen = gruppen.concat([ohne]).filter(function (g) { return g.a.length; });
    var erfuellt = A.filter(function (a) { return zustand(a) === "erfuellt"; }).length;
    var arbeit = A.filter(function (a) { return zustand(a) === "in-arbeit"; }).length;
    var pct = Math.round((erfuellt / A.length) * 100);
    var bar = gruppen.map(function (g) {
      return '<span class="fb-welle" style="flex:' + g.a.length + '">' + g.a.map(function (a) {
        var z = zustand(a);
        return "<i" + (z === "erfuellt" ? ' class="f"' : z === "in-arbeit" ? ' class="l"' : "") + ' title="' + esc(a.id + " " + (a.text || "")) + '"></i>';
      }).join("") + "</span>";
    }).join("");
    var marken = gruppen.map(function (g) {
      var e = g.a.filter(function (a) { return zustand(a) === "erfuellt"; }).length;
      var name = g.w ? "<b>" + esc(g.w.id) + "</b>" + (g.w.name ? " " + esc(g.w.name) : "") : "<b>ohne Welle</b>";
      return '<span class="' + (e === g.a.length ? "voll" : "") + '" style="flex:' + g.a.length + '">' + name + " · " + e + "/" + g.a.length + "</span>";
    }).join("");
    var L = registerVon(), f = L && L.fortschritt, phasen = "";
    if (f && typeof f === "object") {
      var an = f.fertig ? PHASEN.length : PHASEN.indexOf(f.phase);
      phasen = PHASEN.map(function (ph, i) { return '<span class="' + (i < an ? "vor" : i === an ? "an" : "") + '">' + ph + "</span>"; }).join("");
      if (!f.fertig && f.phase && an < 0) phasen += '<span class="an">' + esc(f.phase) + "</span>";
    }
    var rechts = erfuellt + " / " + A.length + " erfüllt · " + pct + " %" + (arbeit ? " · " + arbeit + " in Arbeit" : "");
    var cls = erfuellt === A.length ? " fertig" : arbeit ? " aktiv" : "";
    return '<section class="lp-fortschritt">' + ueberschrift("Fortschritt") + '<div class="lp-fbalken' + cls + '" data-testid="sitzung-phasen"><div class="fb-kopf">' +
      torte(erfuellt / A.length, 22) + "<b>Anforderungen</b>" + (phasen ? '<span class="fb-phasen">' + phasen + "</span>" : "") + '<span class="fb-stand">' + rechts + "</span></div>" +
      '<div class="fb-bar">' + bar + '</div><div class="fb-wellen">' + marken + "</div></div></section>";
  }

  // --- Vier Kacheln (Issue 320): Geplant, Erledigt, Laeuft jetzt, Wartet auf Sie -----------------
  function mehrzahl(n, eins, viele) {
    return n === 1 ? eins : viele;
  }
  function blickKachel(name, wert, klein, unter, cls, titel) {
    return '<div class="lp-kachel' + (cls ? " " + cls : "") + '"' + (titel ? ' title="' + esc(titel) + '"' : "") + '><span class="k">' + esc(name) + "</span> " +
      '<b class="w">' + wert + " <small>" + esc(klein) + "</small></b> " + '<span class="s">' + esc(unter) + "</span></div>";
  }
  /** Die vier Kacheln unter dem Kopf, alle aus der Datei; laufende Agenten aus dem Register. */
  function blick() {
    var p = D.plan, S = p.schritte;
    var zaehle = function (st) { return S.filter(function (s) { return s.status === st; }).length; };
    var fertig = zaehle("fertig"), verworfen = zaehle("verworfen"), offen = zaehle("offen");
    var laeuft = S.filter(function (s) { return s.status === "laeuft"; });
    var L = D.live && typeof D.live === "object" ? D.live : null;
    var agenten = L && Array.isArray(L.agenten) ? L.agenten.filter(function (a) { return a && a.status === "laeuft"; }).length : 0;
    var fragen = p.fragen.filter(function (f) { return !f.entscheidung; });
    var halt = fragen.filter(function (f) { return f.blockiert && f.blockiert.length; }).map(function (f) { return f.id + " haelt " + f.blockiert.join(", ") + " an"; });
    var pct = S.length ? Math.round((fertig / S.length) * 100) : 0;
    var wellen = p.wellen.length;
    return '<div class="lp-blick" data-testid="sitzung-blick">' +
      blickKachel("Geplant", String(S.length), mehrzahl(S.length, "Schritt", "Schritte"), wellen + " " + mehrzahl(wellen, "Welle", "Wellen") + (verworfen ? " · " + verworfen + " verworfen" : "")) +
      blickKachel("Erledigt", String(fertig), "/ " + S.length + " · " + pct + " %", offen + " offen") +
      blickKachel("Laeuft jetzt", String(laeuft.length), mehrzahl(laeuft.length, "Schritt", "Schritte") + " · " + agenten + " " + mehrzahl(agenten, "Agent", "Agenten"),
        laeuft.length ? laeuft.map(function (s) { return s.id; }).join(", ") : "nichts in Arbeit", laeuft.length || agenten ? "lauf" : "",
        laeuft.map(function (s) { return s.id + " " + s.titel; }).join("\n")) +
      blickKachel("Wartet auf Sie", String(fragen.length), mehrzahl(fragen.length, "Frage", "Fragen"),
        halt.length ? halt.join(" · ") : fragen.length ? "haelt keinen Schritt an" : "nichts offen", fragen.length ? "rot" : "",
        fragen.map(function (f) { return f.id + " " + f.frage; }).join("\n")) +
      "</div>";
  }

  function fehler() {
    if (!D.fehler || !D.fehler.length) return "";
    return '<div class="lp-fehler" data-testid="sitzung-fehler">' + D.fehler.map(function (f) {
      return "<div>" + esc(f.pfad || "(Datei)") + ": " + esc(f.grund) + "</div>";
    }).join("") + "</div>";
  }

  function ue() {
    return D.ueberblick || { jetzt: { art: "nichts" }, anforderungen: { sichtbar: [], aelter: [], erfuellt: 0, gesamt: 0 }, entscheidungen: { sichtbar: [], aelter: [] }, offen: { sichtbar: [], aelter: [] } };
  }

  /** Ein Befehl zum Kopieren: der Code und sein Knopf. */
  function befehl(text) {
    return ' <code class="befehl">' + esc(text) + '</code><button type="button" class="kopieren" data-kopiere="' + esc(text) + '" title="Befehl kopieren">kopieren</button>';
  }

  /**
   * Eigene Antwort unter den Optionen, wie "Other" in AskUserQuestion: eine Zeile, Enter oder Senden
   * schickt sie mit eigen: true; leer bleibt Senden aus. Den Rest prueft der Server (500 Zeichen).
   */
  function eigenFeld(f) {
    // A Sprengradius approval (mod live-plan-sitzung) knows only Ausfuehren and Abbrechen.
    if (/^Sprengradius:/.test(f.frage || "")) return "";
    var wert = eigenText[f.id] || "";
    return '<form class="eigen" data-eigen="' + esc(f.id) + '"><input type="text" name="wahl" maxlength="500" autocomplete="off" placeholder="Eigene Antwort…" aria-label="' + esc("Eigene Antwort zu " + f.id) + '" value="' + esc(wert) + '">' +
      '<button type="submit"' + (wert.trim() ? "" : " disabled") + ">Senden</button>" +
      (eigenFehler[f.id] ? '<span class="eigen-fehler" role="alert">' + esc(eigenFehler[f.id]) + "</span>" : "") + "</form>";
  }

  /**
   * Eine offene Frage (#285): Kopfzeile mit Frage und grund, darunter je Option eine Zeile mit beispiel --
   * alles als Text, nichts nur im title --, dann die eigene Antwort. Als Karte in Fragen an Sie mit Stern
   * vorn und der Marke `wartet auf Sie`.
   */
  function frageKarte(f, karte) {
    return '<div class="lp-frage" data-frage="' + esc(f.id) + '"><div class="kopf">' + (karte ? dokuGlyph("frage", "var(--l4)") : "") + '<span class="id">' + esc(f.id) + '</span><span class="t">' + esc(f.frage) + "</span>" +
      (karte ? dokuTag("wartet auf Sie", "gelb") : "") +
      (f.grund ? '<span class="grund">' + esc(f.grund) + "</span>" : "") +
      (f.blockiert.length ? '<span class="bl">blockiert ' + esc(f.blockiert.join(", ")) + "</span>" : "") + "</div>" +
      '<ul class="opt">' + f.optionen.map(function (o) {
        return "<li" + (o.empfohlen ? ' class="empfohlen"' : "") + '><button type="button" class="' + (o.empfohlen ? "empfohlen" : "") + '" data-frage="' + esc(f.id) + '" data-wahl="' + esc(o.label) + '">' + esc(o.label) + "</button>" +
          (o.empfohlen ? '<span class="emp">empfohlen</span>' : "") +
          (o.beispiel ? '<span class="bsp">' + esc(o.beispiel) + "</span>" : "") + "</li>";
      }).join("") + "</ul>" + eigenFeld(f) + "</div>";
  }

  /**
   * Fragen an Sie (Vorlage): entschiedene als Zeile mit der Wahl, offene als Karte mit Optionen und eigener
   * Antwort. Wie die anderen Abschnitte nur die fuenf neuesten entschiedenen; `+N aeltere` klappt den Rest auf.
   */
  function fragenAnSie() {
    var F = D.plan.fragen || [];
    if (!F.length) return "";
    var offen = F.filter(function (f) { return !f.entscheidung; }).length;
    var entschieden = F.filter(function (f) { return f.entscheidung; });
    var aelter = entschieden.slice(0, Math.max(0, entschieden.length - FRAGEN_N));
    var auf = mehrAuf("fragen");
    var knopf = aelter.length
      ? '<button type="button" class="mehr" data-mehr="fragen" aria-expanded="' + auf + '">' + (auf ? "nur die neuesten " + FRAGEN_N : "+" + aelter.length + " aeltere") + "</button>"
      : "";
    return '<section class="lp-abschnitt lp-fragen-sie" data-abschnitt="fragen" data-testid="sitzung-fragen"><h2>Fragen an Sie <span class="zaehler">' + offen + " offen</span>" + knopf + "</h2>" +
      F.map(function (f) {
        if (!f.entscheidung) return frageKarte(f, true);
        var alt = aelter.indexOf(f) >= 0;
        if (alt && !auf) return "";
        return '<div class="lp-az fr-entschieden" data-entschieden="' + esc(f.id) + '"' + (alt ? " data-aelter" : "") + ">" + dokuGlyph("fertig", "var(--l1)", 16) + '<span class="id">' + esc(f.id) + "</span>" +
          '<span class="t">' + esc(f.frage) + ' <span class="wahl">→ ' + esc(f.entscheidung) + "</span>" + (istEigen(f) ? '<span class="eigen-marke">eigene Antwort</span>' : "") + "</span>" +
          alterMarke(f.id) + dokuTag("entschieden") + "</div>";
      }).join("") + (aelter.length ? '<span class="lp-druck-mehr">+' + aelter.length + " aeltere</span>" : "") + "</section>";
  }

  // --- Jetzt-Zeile (S26): genau eine, Frage vor Lauf vor Blatt jetzt vor Thema ------------------
  /** `kompakt` (die Seite): offene Fragen nur als Verweis, denn ihre Karten stehen unter Fragen an Sie. */
  function jetzt(kompakt) {
    var j = ue().jetzt;
    var kopfText = '<span class="k">Jetzt</span>';
    if (j.art === "fragen" && kompakt) {
      return '<div class="lp-jetzt wartet" data-testid="sitzung-jetzt">' + kopfText + '<span class="t">Wartet auf Sie</span>' + j.fragen.map(function (id) {
        var f = frage(id);
        return f ? '<button type="button" data-id="' + esc(f.id) + '" title="' + esc(f.id + " " + f.frage) + '"><span class="id">' + esc(f.id) + '</span><span class="t">' + esc(f.frage) + "</span></button>" : "";
      }).join("") + "</div>";
    }
    if (j.art === "fragen") {
      return '<div class="lp-jetzt fragen" data-testid="sitzung-jetzt">' + kopfText + '<div class="lp-fragen">' + j.fragen.map(function (id) {
        var f = frage(id);
        return f ? frageKarte(f) : "";
      }).join("") + "</div></div>";
    }
    if (j.art === "laeuft") {
      return '<div class="lp-jetzt" data-testid="sitzung-jetzt">' + kopfText + j.schritte.map(function (e) {
        return '<button type="button" data-id="' + esc(e.id) + '" title="' + esc(e.id + " " + e.titel) + '"><span class="id">' + esc(e.id) + '</span><span class="t">' + esc(e.titel) + "</span>" +
          (e.agent ? '<span class="ag">' + esc(e.agent) + "</span>" : "") + (e.seit ? '<span class="seit">seit ' + zeitAngabe(e.seit) + "</span>" : "") + "</button>";
      }).join("") + "</div>";
    }
    if (j.art === "offen") {
      return '<div class="lp-jetzt" data-testid="sitzung-jetzt">' + kopfText + '<span class="t">' + esc(j.blatt.text) + "</span>" + (j.blatt.befehl ? befehl(j.blatt.befehl) : "") + "</div>";
    }
    if (j.art === "thema") return '<div class="lp-jetzt" data-testid="sitzung-jetzt">' + kopfText + '<span class="t">' + esc(j.text) + "</span></div>";
    return '<div class="lp-jetzt" data-testid="sitzung-jetzt"><span class="leer">Jetzt: nichts in Arbeit</span></div>';
  }

  // --- Drei Abschnitte (S26): je hoechstens fuenf, aeltere an Ort und Stelle aufklappbar ---------
  function mehrAuf(name) {
    return lies("live-plan.mehr." + name) === "auf";
  }
  function umschalteMehr(name) {
    var auf = !mehrAuf(name);
    merke("live-plan.mehr." + name, auf ? "auf" : "zu");
    if (wurzel && D) zeichne();
    return auf;
  }

  /**
   * Ein Abschnitt: Kopf mit Zaehler und Knopf, darunter die Zeilen; `teil` aus ueberblick. Aufgeklappte
   * aeltere Zeilen tragen `data-aelter`, damit der Druck sie auslaesst und statt des Knopfs den Text
   * `+N aeltere` zeigt (E8, S5).
   */
  function abschnitt(name, titel, zaehler, teil, zeile, extra) {
    var auf = mehrAuf(name);
    var knopf = teil.aelter.length
      ? '<button type="button" class="mehr" data-mehr="' + name + '" aria-expanded="' + auf + '">' + (auf ? "nur die neuesten " + teil.sichtbar.length : "+" + teil.aelter.length + " aeltere") + "</button>"
      : "";
    var zeilen = teil.sichtbar.map(zeile).join("") + (auf ? teil.aelter.map(function (e) { return zeile(e).replace(/^<li\b/, "<li data-aelter"); }).join("") : "");
    var druck = teil.aelter.length ? '<span class="lp-druck-mehr">+' + teil.aelter.length + " aeltere</span>" : "";
    return '<section class="lp-abschnitt lp-' + name + '" data-abschnitt="' + name + '"' + (extra || "") + "><h2>" + titel + ' <span class="zaehler">' + zaehler + "</span>" + knopf + "</h2>" +
      (zeilen ? "<ul>" + zeilen + "</ul>" : '<p class="leer">—</p>') + druck + "</section>";
  }

  /** Ein Schritt als Chip: nur die Id, der Titel im title; ein Klick oeffnet die Seitenleiste. */
  function verweisSchritt(id) {
    var s = schritt(id);
    return '<button type="button" class="vw s-' + (s ? s.status : "offen") + '" data-id="' + esc(id) + '" title="' + esc(s ? id + " " + s.titel : id) + '"><span class="id">' + esc(id) + "</span></button>";
  }

  /** Wann der Punkt zuletzt geaendert wurde (geaendert_um aus dem Verlauf des Servers); im Handout nichts. */
  function alterMarke(id) {
    var iso = zeit(id).geaendert_um;
    if (!iso || handout) return "";
    return ' <span class="alter" data-um="' + esc(iso) + '" data-kurz title="' + esc(ortszeit(iso)) + '">' + esc(alterKurz(iso)) + "</span>";
  }

  var BILD_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="5.5" cy="6.5" r="1.4" fill="currentColor"/><path d="M2.5 12.5 6.5 8.5 9 11 11 9 13.5 12.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>';

  function anforderungsEintrag(e) {
    var a = (D.plan.anforderungen || []).find(function (x) { return x.id === e.id; });
    if (!a) return "";
    var z = ZUSTAND[e.zustand] ? e.zustand : "offen";
    var zul = !handout && (D.neueste || {}).anforderung === a.id;
    var bild = !handout && z === "erfuellt" && e.beweis
      ? ' <button type="button" class="bw" data-beweis="' + esc(a.id) + '" aria-label="Beweisbild ' + esc(a.id) + '" title="Beweisbild ' + esc(a.id) + '">' + BILD_ICON + "</button>" +
        '<span class="bw-vorschau" aria-hidden="true"><img loading="lazy" alt="" src="' + esc(belegUrl(e.beweis)) + '"></span>'
      : "";
    return '<li class="af z-' + z + (zul ? " zuletzt" : "") + '" data-eintrag="' + esc(a.id) + '" title="' + esc(a.id + " " + a.text + (a.quelle ? " · Quelle: " + a.quelle : "")) + '">' +
      '<span class="id">' + esc(a.id) + '</span> <span class="zs" title="' + ZUSTAND[z][1] + '">' + ZUSTAND[z][0] + '</span> <span class="t">' + esc(a.text) + "</span>" +
      (a.erfuellt_mit.length && !handout ? ' <span class="mit">' + a.erfuellt_mit.map(verweisSchritt).join(" ") + "</span>" : "") +
      alterMarke(a.id) + bild + " " + dokuTag(ZUSTAND[z][1], z === "erfuellt" ? "blau" : "") + "</li>";
  }

  function entscheidungsEintrag(x) {
    var e = (D.plan.entscheidungen || []).find(function (y) { return y.id === x.id; });
    if (!e) return "";
    var zul = !handout && (D.neueste || {}).entscheidung === e.id;
    var text = esc(e.titel) + (e.grund ? " — " + esc(e.grund) : "");
    return '<li class="ent' + (zul ? " zuletzt" : "") + '" data-eintrag="' + esc(e.id) + '" title="' + esc(e.id + " " + e.titel + (e.grund ? " — " + e.grund : "") + (e.quelle ? " · " + e.quelle : "")) + '">' +
      '<span class="id">' + esc(e.id) + '</span> <span class="t">' + text + "</span>" +
      (e.schritte.length && !handout ? ' <span class="mit">' + e.schritte.map(verweisSchritt).join(" ") + "</span>" : "") +
      alterMarke(e.id) + (e.quelle ? " " + dokuTag(e.quelle) : "") + "</li>";
  }

  /** Ein Blatt in Offen (S29, M1): Glyph je Gate, der Text mit Vorrang, ein Befehl nur als Kopierknopf, rechts das Gate als kurze Marke (das volle Wort im title). */
  function offenEintrag(b) {
    var wort = GATE_TEXT[b.gate] || b.gate;
    var gl = GATE_GLYPH[b.gate] || GATE_GLYPH.spaeter;
    return '<li class="blatt gate-' + esc(b.gate) + (b.gate === "jetzt" ? " jetzt" : "") + '" title="' + esc(b.text) + '">' +
      dokuGlyph(gl[0], gl[1], 16) + ' <span class="t">' + esc(b.text) + "</span>" +
      (b.befehl ? '<button type="button" class="kopieren" data-kopiere="' + esc(b.befehl) + '" title="' + esc("kopieren: " + b.befehl) + '" aria-label="' + esc("Befehl kopieren: " + b.befehl) + '">⧉</button>' : "") +
      ' <span class="gate" title="' + esc(wort) + '" aria-label="' + esc(wort) + '">' + esc(GATE_MARKE[b.gate] || b.gate) + "</span></li>";
  }

  function ueberblick() {
    var u = ue();
    var an = u.anforderungen, en = u.entscheidungen, of = u.offen;
    var leer = function (t) { return !t.sichtbar.length && !t.aelter.length; };
    if (leer(an) && leer(en) && leer(of)) return "";
    return '<div class="lp-ueberblick" data-testid="sitzung-ueberblick">' +
      abschnitt("anforderungen", "Anforderungen", an.erfuellt + "/" + an.gesamt + " erfuellt", an, anforderungsEintrag) +
      abschnitt("entscheidungen", "Entscheidungen", en.sichtbar.length + en.aelter.length, en, entscheidungsEintrag) +
      abschnitt("offen", "Offen", of.sichtbar.length + of.aelter.length, of, offenEintrag) +
      "</div>";
  }

  // --- Beweisbild (A20): Vorschau beim Zeigen, Modal beim Klick ---------------------------------
  function beweisModal(id) {
    var u = ue().anforderungen;
    var e = u.sichtbar.concat(u.aelter).find(function (x) { return x.id === id; });
    var a = (D.plan.anforderungen || []).find(function (x) { return x.id === id; });
    if (!e || !a || e.zustand !== "erfuellt" || !e.beweis) return "";
    return '<div class="lp-modal" data-modal-zu><div class="lp-modal-box" role="dialog" aria-modal="true" aria-labelledby="lp-modal-titel">' +
      '<div class="lp-modal-kopf"><h2 id="lp-modal-titel">' + esc(a.id + " " + a.text) + '</h2><span class="pfad mono">' + esc(e.beweis) + "</span>" +
      '<button type="button" class="zu" data-modal-zu aria-label="Schliessen (Esc)" title="Schliessen (Esc)">×</button></div>' +
      '<img alt="Beweisbild ' + esc(a.id) + '" src="' + esc(belegUrl(e.beweis)) + '"></div></div>';
  }

  // --- Seitenleiste -------------------------------------------------------------------------
  function beleg(b) {
    // Not lazy: embedded previews (T3 Code) never load a lazy image or frame inside the drawer.
    var oeffnen = function (art) { return '<div class="k">' + art + " · " + esc(b.pfad) + ' <a href="' + esc(belegUrl(b.pfad)) + '" target="_blank" rel="noopener">öffnen</a></div>'; };
    if (b.art === "bild") return '<div class="beleg">' + oeffnen("Bild") + '<img alt="' + esc(b.pfad) + '" src="' + esc(belegUrl(b.pfad)) + '"></div>';
    if (b.art === "html") return '<div class="beleg">' + oeffnen("HTML") + '<iframe sandbox="allow-scripts" title="' + esc(b.pfad) + '" src="' + esc(belegUrl(b.pfad)) + '"></iframe></div>';
    if (b.art === "commit") return '<div class="beleg"><div class="k">Commit</div><pre>' + esc(b.sha) + "</pre></div>";
    return '<div class="beleg"><div class="k">' + esc(b.art) + (b.ort ? " · " + esc(b.ort) : "") + "</div><pre>" + esc(b.text) + "</pre></div>";
  }

  function verweise(ids) {
    if (!ids.length) return '<p class="leer">—</p>';
    return '<div class="verweise">' + ids.map(function (id) {
      var s = schritt(id), f = frage(id);
      var status = s ? s.status : f ? (f.entscheidung ? "fertig" : "offen") : "offen";
      return '<button type="button" class="ref s-' + status + '" data-id="' + esc(id) + '"><span class="id">' + esc(id) + '</span><span class="t">' + esc(s ? s.titel : f ? f.frage : "") + "</span></button>";
    }).join("") + "</div>";
  }

  function drawerInhalt(id) {
    var s = schritt(id);
    if (!s) return "";
    var b = D.plan.bahnen.find(function (x) { return x.id === s.bahn; });
    var w = D.plan.wellen.find(function (x) { return x.id === s.welle; });
    var z = zeit(id);
    var u = s.umsetzung;
    var meta = [];
    if (s.agent) meta.push("Agent " + esc(s.agent));
    if (s.art) meta.push("Art " + esc(s.art));
    if (z.gestartet_um) meta.push("gestartet " + zeitAngabe(z.gestartet_um));
    if (z.fertig_um) meta.push("fertig " + zeitAngabe(z.fertig_um));
    if (z.geaendert_um) meta.push("geaendert " + zeitAngabe(z.geaendert_um));
    var vor = s.haengt.slice();
    D.plan.fragen.forEach(function (f) { if (f.blockiert.indexOf(id) >= 0 && vor.indexOf(f.id) < 0) vor.push(f.id); });
    var nach = D.plan.schritte.filter(function (x) { return x.haengt.indexOf(id) >= 0; }).map(function (x) { return x.id; });
    return '<button type="button" class="schl" data-schliessen title="Schliessen (Esc)">×</button>' +
      '<div class="lane">' + esc((b ? b.name : s.bahn) + " · " + (w ? w.id + " " + w.name : s.welle)) + "</div>" +
      '<h2><span class="id">' + esc(s.id) + "</span>" + esc(s.titel) + '<span class="pill st-' + s.status + '">' + esc(s.status) + "</span></h2>" +
      '<div class="meta">' + meta.join(" · ") + "</div>" +
      "<h3>Haengt an</h3>" + verweise(vor) +
      "<h3>Entsperrt</h3>" + verweise(nach) +
      "<h3>Plan</h3>" + (s.plan ? "<p>" + esc(s.plan) + "</p>" : '<p class="leer">—</p>') +
      "<h3>Fertig wenn</h3>" + (s.fertig_wenn ? "<p>" + esc(s.fertig_wenn) + "</p>" : '<p class="leer">—</p>') +
      "<h3>Umsetzung</h3>" + (u && (u.wie || u.dateien.length)
        ? (u.wie ? "<p>" + esc(u.wie) + "</p>" : "") + (u.dateien.length ? "<ul>" + u.dateien.map(function (d) { return "<li>" + esc(d) + "</li>"; }).join("") + "</ul>" : "")
        : '<p class="leer">noch nicht umgesetzt</p>') +
      "<h3>Belege</h3>" + (u && u.belege.length ? u.belege.map(beleg).join("") : '<p class="leer">—</p>');
  }

  // --- Live-Block (S8, Vertrag v1.1 A): aus der Register-JSON der Claude-Sitzung, nach savvy-progress
  // oben der Verbrauch in zwei Zeilen (Issue 320), darunter der Kopf mit Fortschritt (Titel, Phase,
  // Balken, laufend / wartet / ruht / abgeschlossen) und die Agenten in drei Gruppen:
  // Laufend, Fertig (einklappbar, eingeklappt ab vier) und Geplant (Aufgaben ohne Agenten mit
  // gleicher Beschreibung). Hoechstens LIVE_N Zeilen sichtbar, der Rest hinter `+N`. Ohne Register kein Block.
  var LIVE_N = 6;
  /** A plan without a running agent counts as resting after this long. */
  var RUHE_MS = 15 * 60000;
  /** Limits reported longer ago than this are dimmed. */
  var LIMIT_ALT_MS = 10 * 60000;
  var LIVE_ZEICHEN = { laeuft: "●", fertig: "✓", fehler: "✗", geplant: "◷" };
  var LIVE_WORT = { laeuft: "laeuft", fertig: "fertig", fehler: "Fehler", geplant: "geplant" };
  var STUFEN = { light: "st-light", medium: "st-medium", careful: "st-careful", heavy: "st-heavy" };
  var LIMIT_NAMEN = { five_hour: "5h", seven_day: "7d", spend_limit: "Budget" };
  var WOCHENTAGE = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
  function zahl(n) {
    var x = Number(n);
    return isFinite(x) ? x : 0;
  }
  /** Tokens kompakt: 950, 12.3k, 123k, 1.2M. */
  function tokens(n) {
    var x = zahl(n);
    if (x >= 1e6) return (x / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (x >= 1e3) return (x / 1e3).toFixed(x < 1e5 ? 1 : 0).replace(/\.0$/, "") + "k";
    return String(Math.round(x));
  }
  /** Kosten als Schaetzung wie savvy-progress: ≈$0.42, ab zehn Dollar eine Nachkommastelle. */
  function kosten(usd) {
    if (usd === null || usd === undefined || !isFinite(Number(usd))) return "";
    var x = zahl(usd);
    return "≈$" + (x < 10 ? x.toFixed(2) : x.toFixed(1));
  }
  /** Der Modellname kurz: claude-opus-5-5 -> Opus 5.5. */
  function modellName(id) {
    var m = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(String(id || ""));
    if (!m) return String(id || "").replace(/^claude-/, "").replace(/\[.*\]$/, "") || "—";
    return m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase() + " " + m[2] + (m[3] ? "." + m[3] : "");
  }
  function isoVon(ms) {
    var x = Number(ms);
    return isFinite(x) && x > 0 ? new Date(x).toISOString() : "";
  }
  /** Die Zeit eines Laufs wie im Bestand: laufend als verstrichene Zeit mit Takt, beendet als feste Dauer. */
  function laufzeit(gestartet, beendet) {
    var start = isoVon(gestartet);
    if (!start) return "";
    if (!isoVon(beendet)) return zeitAngabe(start, "uhr lv-zeit");
    var d = verstrichen(start, zahl(beendet));
    return '<span class="uhr lv-zeit" title="' + esc(ortszeit(start) + " – " + ortszeit(isoVon(beendet))) + '">' + esc(d === "jetzt" ? "<1m" : d) + "</span>";
  }
  /** Ein Balken: Anteil 0..1, grau fuer die Kontextfuellung, `farbe` als weitere Klasse (ok, gelb, rot, st-*). */
  function balken(anteil, grau, titel, farbe) {
    var p = Math.max(0, Math.min(100, Math.round(zahl(anteil) * 100)));
    return '<span class="lv-bar' + (grau ? " grau" : "") + (farbe ? " " + farbe : "") + '"' + (titel ? ' title="' + esc(titel) + '"' : "") + '><i style="width:' + p + '%"></i></span>';
  }
  /** Die Aufgaben des Fortschritts, die noch kein Agent mit derselben Beschreibung traegt. */
  function geplant(L) {
    var f = L.fortschritt;
    if (!f || f.fertig || !Array.isArray(f.aufgaben)) return [];
    var da = {};
    (L.agenten || []).forEach(function (a) { da[String(a.beschreibung || "").trim()] = true; });
    return f.aufgaben.map(function (t, i) { return { n: i + 1, titel: String(t.titel || ""), stufe: t.stufe, nach: Array.isArray(t.nach) ? t.nach : [] }; })
      .filter(function (t) { return t.titel && !da[t.titel.trim()]; });
  }
  /** Stufe je Aufgabentitel aus dem Fortschritt; ein Agent mit gleicher Beschreibung erbt sie. */
  function stufenVon(L) {
    var s = Object.create(null);
    var f = L.fortschritt;
    if (f && Array.isArray(f.aufgaben)) f.aufgaben.forEach(function (t) { if (t && t.stufe) s[String(t.titel || "").trim()] = String(t.stufe); });
    return s;
  }
  function stufeMarke(stufe) {
    return '<span class="stufe ' + (STUFEN[stufe] || "st-andere") + '">' + esc(stufe) + "</span>";
  }
  /** Rechte Kennzahlen einer Agentenzeile; `ctx` nur, solange der Agent laeuft. */
  function agentZahlen(a, ctx) {
    return (ctx === null ? "" : "ctx " + Math.round(ctx * 100) + "% · ") + tokens(a.tokens) + " · " + kosten(a.kostenUsd) + " · " + laufzeit(a.gestartet, a.beendet);
  }
  /**
   * Eine Agentenzeile. Laufend: eine Zeile und ein duenner Balken darunter (Beschreibung · `3/4 · Notiz` ·
   * Stufe/Modell · Kennzahlen · pulsierender Punkt; Nutzerwunsch 2026-10-11). Fertig und Fehler: eine
   * Zeile, gedimmt, ohne Balken.
   */
  function agentZeile(a, stufen) {
    var status = LIVE_ZEICHEN[a.status] && a.status !== "geplant" ? a.status : "laeuft";
    var max = zahl(a.kontextMax), ctx = max ? zahl(a.kontext) / max : 0;
    var schritte = zahl(a.stepGesamt), erledigt = zahl(a.stepErledigt);
    var stufe = stufen[String(a.beschreibung || "").trim()];
    var modell = modellName(a.modell) + (a.effort ? " · " + a.effort : "");
    var kopf = '<li class="lv-zeile g-' + status + (status === "laeuft" ? "" : " kurz") + '" data-agent-zeile="' + esc(a.id) + '" title="' + esc((a.typ || "") + " · " + (a.beschreibung || "") + " · " + modell) + '">';
    var punkt = '<span class="zs" title="' + LIVE_WORT[status] + '">' + LIVE_ZEICHEN[status] + "</span>";
    var name = '<span class="t">' + esc(a.beschreibung || a.typ || "") + "</span>";
    if (status !== "laeuft") return kopf + '<div class="z1">' + punkt + name + '<span class="n">' + agentZahlen(a, null) + "</span></div></li>";
    var bar = schritte ? balken(erledigt / schritte, false, erledigt + "/" + schritte + (a.stepNotiz ? " " + a.stepNotiz : ""), STUFEN[stufe] || "")
      : balken(ctx, true, "Kontext " + Math.round(ctx * 100) + "%");
    var links = schritte ? erledigt + "/" + schritte + (a.stepNotiz ? " · " + a.stepNotiz : "") : "";
    return kopf + '<div class="z1">' + name + (links ? '<span class="st">' + esc(links) + "</span>" : "") +
      '<span class="mt">' + (stufe ? stufeMarke(stufe) : '<span class="typ">' + esc(a.typ || "") + "</span>") + ' <span class="mod">' + esc(modell) + "</span></span>" +
      '<span class="n">' + agentZahlen(a, ctx) + "</span>" + punkt + "</div>" + bar + "</li>";
  }
  function geplantZeile(t) {
    return '<li class="lv-zeile kurz g-geplant" data-geplant="' + t.n + '" title="' + esc(t.n + ". " + t.titel) + '">' +
      '<div class="z1"><span class="zs" title="geplant">' + LIVE_ZEICHEN.geplant + '</span><span class="t">' + esc(t.n + ". " + t.titel) + "</span>" +
      '<span class="mt">' + (t.stufe ? stufeMarke(t.stufe) + " " : "") + '<span class="mod">' + (t.nach.length ? "nach " + esc(t.nach.join(", ")) : "sofort") + "</span></span></div></li>";
  }

  /** Reset eines Limits: binnen 24 h als Dauer (`Reset in 2h 13m`), sonst Wochentag und Ortszeit (`Reset Mo 09:00`). */
  function resetText(ms) {
    var r = Number(ms), n = jetztMs();
    if (!isFinite(r) || r <= 0) return "";
    if (r <= n) return "Reset faellig";
    if (r - n < 24 * 3600000) return "Reset in " + verstrichen(isoVon(n), r);
    var d = new Date(r);
    return "Reset " + WOCHENTAGE[d.getDay()] + " " + zwei(d.getHours()) + ":" + zwei(d.getMinutes());
  }
  /** Die gueltigen Limits aus haupt.limits; was nicht passt, faellt still weg. */
  function limitsVon(h) {
    if (!Array.isArray(h.limits)) return [];
    return h.limits.filter(function (l) {
      return l && typeof l === "object" && typeof l.art === "string" && l.art && typeof l.prozent === "number" && isFinite(l.prozent);
    });
  }
  /** Farbe eines Anteils 0..1: ab 90 % rot, ab 70 % gelb, sonst leer. */
  function stufeVon(anteil) {
    return anteil >= 0.9 ? "rot" : anteil >= 0.7 ? "gelb" : "";
  }

  // --- Verbrauch in zwei Zeilen (Issue 320): oben im Live-Block, ueber dem Fortschritt -----------
  // Zeile Sitzung: Kosten, Tokens, Zeit, ctx mit Mini-Balken │ Modell · Zuege │ Reserve und weitere
  // Limits. Zeile 5h: Konto gekuerzt, ein breiter Balken (Fuellung = Nutzung, Schraffur bis voll,
  // Strich an der Zeitposition, Zeiten im Balken) und rechts Tempo, 7 T und Wechselziel. Die Daten
  // kommen aus D.live und GET /api/abo (ABO); ohne Abo-Daten traegt die Zeile 5h haupt.limits.
  var ABO = null;
  var AMPEL = { gruen: "ok", gelb: "gelb", rot: "rot" };
  var FUENF_H_MS = 5 * 3600000;
  var TRENN = ' <span class="vb-trenn" aria-hidden="true">│</span> ';
  function prozent(anteil) {
    return Math.round(zahl(anteil) * 100) + " %";
  }
  function anteil(x) {
    return Math.max(0, Math.min(1, zahl(x)));
  }
  /** Eine Uhrzeit fuer den title: binnen 24 h HH:MM, sonst Wochentag und HH:MM. */
  function aboUhr(iso) {
    var d = new Date(iso === null || iso === undefined ? "" : iso);
    if (isNaN(d.getTime())) return "";
    var hm = zwei(d.getHours()) + ":" + zwei(d.getMinutes());
    return Math.abs(d.getTime() - jetztMs()) < 24 * 3600000 ? hm : WOCHENTAGE[d.getDay()] + " " + hm;
  }
  /** Eine Dauer in Stunden, ohne Tage: 40m, 2h 55m, ab 10 h nur Stunden (37h). */
  function dauer(ms) {
    var m = Math.max(0, Math.round(zahl(ms) / 60000));
    if (m < 60) return m + "m";
    if (m < 600) return Math.floor(m / 60) + "h " + (m % 60) + "m";
    return Math.floor(m / 60) + "h";
  }
  /** Abstand bis iso: in 40m, in 2h 55m, in 37h. */
  function aboIn(iso) {
    var t = new Date(iso || "").getTime();
    return isNaN(t) ? "" : "in " + dauer(t - jetztMs());
  }
  /** Ein Konto gekuerzt: Anfangsbuchstaben der Namensteile, mit @ der erste Buchstabe der Domain (vorname.nachname@firma -> v.n@f). */
  function kontoKurz(name) {
    var teile = String(name || "").split("@");
    var vor = teile[0].split(/[._-]+/).filter(Boolean).map(function (t) { return t.charAt(0); }).join(".");
    return teile.length > 1 && teile[1] ? vor + "@" + teile[1].charAt(0) : vor;
  }
  function aboListe(x) {
    return Array.isArray(x) ? x.filter(function (k) { return k && typeof k === "object" && typeof k.name === "string"; }) : [];
  }
  /** Eine Zeile im title der Reserve: Gruppe, Name, 5h, 7d, wann wieder frei, Alter des Stands. */
  function reserveZeile(gruppe, k) {
    var teile = [gruppe + ": " + k.name, "5h " + prozent(k.fuenf), "7d " + prozent(k.sieben)];
    if (k.relogin) teile.push("neu anmelden");
    else if (k.freiAb) teile.push("wieder frei " + aboIn(k.freiAb));
    if (k.veraltet && k.beobachtet) teile.push("Stand vor " + verstrichen(k.beobachtet));
    return teile.join(" · ");
  }
  /** Die Reserve als Zaehler frei/knapp/voll, die Namen im title; ohne freie der naechste, der wieder frei wird. */
  function reserveText(A) {
    var r = A.reserve && typeof A.reserve === "object" ? A.reserve : {};
    var gruppen = [["frei", aboListe(r.frei)], ["knapp", aboListe(r.knapp)], ["voll", aboListe(r.voll)]];
    var namen = [];
    gruppen.forEach(function (g) { g[1].forEach(function (k) { namen.push(reserveZeile(g[0], k)); }); });
    if (!namen.length) return "";
    var zaehler = gruppen.filter(function (g) { return g[1].length; }).map(function (g) { return g[1].length + " " + g[0]; }).join(" · ");
    var n = A.naechster && typeof A.naechster === "object" && typeof A.naechster.name === "string" && typeof A.naechster.freiAb === "string" && !aboListe(r.frei).length ? A.naechster : null;
    var frei = n ? " · " + (n.vorReset ? '<span class="ab-wechsel" title="' + esc(n.name + " ist vor dem Reset des aktiven Accounts wieder nutzbar") + '">→ ' : '<span title="' + esc(n.name) + '">') +
      "frei " + esc(aboIn(n.freiAb)) + " " + esc(kontoKurz(n.name)) + "</span>" : "";
    return '<span class="ab-reserve" title="' + esc(namen.join("\n")) + '">Reserve ' + zaehler + frei + "</span>";
  }
  /** Ist der Stand der Limits aelter als LIMIT_ALT_MS, wie lange schon; sonst leer. */
  function limitsAlt(h) {
    var lz = Number(h.limitsZeit);
    return isFinite(lz) && lz > 0 && jetztMs() - lz > LIMIT_ALT_MS ? verstrichen(isoVon(lz)) : "";
  }
  /** Zeile Sitzung. */
  function sitzungZeile(L) {
    var h = L.haupt || {}, k = h.kontext || {};
    var agenten = Array.isArray(L.agenten) ? L.agenten : [];
    var ctx = k.prozent !== null && k.prozent !== undefined && isFinite(Number(k.prozent)) ? zahl(k.prozent)
      : zahl(k.max) ? (zahl(k.benutzt) / zahl(k.max)) * 100 : null;
    var agentTokens = agenten.reduce(function (s, a) { return s + zahl(a && a.tokens); }, 0);
    var hauptTokens = typeof h.tokens === "number" && isFinite(h.tokens) ? h.tokens : null;
    var summe = zahl(hauptTokens) + agentTokens;
    var tokTitel = hauptTokens === null ? "nur Agenten: " + tokens(agentTokens) + " (die Hauptsitzung meldet keine Tokens)" : "Hauptsitzung " + tokens(hauptTokens) + " · Agenten " + tokens(agentTokens);
    var teile = ['<span class="k">Sitzung</span> <b class="w">' + esc(kosten(h.kostenUsd) || "—") + "</b>",
      '<span title="' + esc(tokTitel) + '"><b class="w">' + esc(summe ? tokens(summe) : "—") + "</b> tok</span>",
      '<b class="w">' + (laufzeit(L.gestartet, L.beendet) || "—") + "</b>"];
    if (ctx !== null) {
      teile.push('<span title="' + esc("Kontext " + tokens(k.benutzt) + " von " + tokens(k.max)) + '">ctx <b class="w">' + Math.round(ctx) + " %</b></span> " + balken(ctx / 100, false, null, stufeVon(ctx / 100) || "ok"));
    }
    var html = teile.join(" ") + TRENN + '<span class="vb-modell"><b class="mod">' + esc(modellName(L.modell)) + "</b> · " + zahl(h.zuege) + " Zuege</span>";
    var reserve = ABO && typeof ABO === "object" ? reserveText(ABO) : "";
    if (reserve) html += TRENN + reserve;
    var alt = limitsAlt(h);
    var andere = limitsVon(h).filter(function (l) { return l.art !== "five_hour" && l.art !== "seven_day"; });
    if (andere.length) {
      html += TRENN + andere.map(function (l) {
        var farbe = stufeVon(l.prozent / 100);
        var titel = alt ? "Stand vor " + alt : resetText(l.reset);
        return '<span class="vb-limit' + (farbe ? " " + farbe : "") + (alt ? " alt" : "") + '"' + (titel ? ' title="' + esc(titel) + '"' : "") + ">" +
          esc(LIMIT_NAMEN[l.art] || l.art.replace(/_/g, " ")) + ' <b class="w">' + Math.round(l.prozent) + " %</b></span>";
      }).join(" ");
    }
    return '<div class="vb-sitzung">' + html + "</div>";
  }
  /**
   * Der 5h-Balken: Fuellung = Nutzung; laeuft das Fenster (reset in der Zukunft), ein 1-px-Strich an
   * der Zeitposition (Beginn = reset - 5h, Uhr der Ansicht) mit der Laufzeit, bei `voll-um` eine
   * Schraffur bis zur Stelle voll mit gestrichelter Linie, rechts `Reset in`. Uhrzeiten nur im title.
   */
  function fensterBalken(f, farbe) {
    var n = anteil(f.nutzung), p = Math.round(n * 100);
    var jetzt = jetztMs(), reset = new Date(f.reset || "").getTime();
    var laeuft = isFinite(reset) && reset > jetzt;
    var beginn = reset - FUENF_H_MS;
    var z = laeuft ? anteil((jetzt - beginn) / FUENF_H_MS) : null;
    var zp = z === null ? 0 : Math.round(z * 100);
    var voll = laeuft && f.prognose === "voll-um" ? new Date(f.vollUm || "").getTime() : NaN;
    var vp = isFinite(voll) ? Math.round(anteil((voll - beginn) / FUENF_H_MS) * 100) : null;
    var seite = function (x) { return x < 12 ? "nach" : "vor"; };
    var titel = laeuft ? "Fenster ab " + aboUhr(isoVon(beginn)) + " · " + p + " % nach " + dauer(jetzt - beginn) + " von 5h" : "kein laufendes Fenster";
    var teile = ['<div class="spur"><i class="fill" style="width:' + p + '%"></i>' + (vp === null ? "" : '<i class="prog" style="left:' + p + "%;width:" + Math.max(0, vp - p) + '%"></i>') + "</div>"];
    if (vp !== null) teile.push('<b class="voll" style="left:' + vp + '%"></b>');
    if (laeuft) {
      teile.push('<b class="strich" style="left:' + zp + '%"></b>');
      teile.push('<span class="lab ' + seite(zp) + '" style="left:' + zp + '%" title="' + esc("Fensterbeginn " + aboUhr(isoVon(beginn)) + ", jetzt " + aboUhr(isoVon(jetzt))) + '">' + esc(dauer(jetzt - beginn)) + "</span>");
      if (vp !== null) teile.push('<span class="lab ' + seite(vp) + '" style="left:' + vp + '%" title="' + esc("voll ~" + aboUhr(isoVon(voll))) + '">voll in ' + esc(dauer(voll - jetzt)) + "</span>");
      teile.push('<span class="lab r" title="' + esc("Reset " + aboUhr(isoVon(reset))) + '">Reset in ' + esc(dauer(reset - jetzt)) + "</span>");
    }
    return { html: '<div class="vb-fbar ' + farbe + '" title="' + esc(titel) + '">' + teile.join(" ") + "</div>", z: z };
  }
  /** Rechts im Fenster: Nutzung und Tempo (F = Nutzung / Zeitanteil), `zu frueh` ohne Angabe. */
  function tempoText(f, z) {
    var n = anteil(f.nutzung);
    if (f.prognose === "voll" || n >= 0.98) return ' · <b class="ab-tempo">voll ⚠</b>';
    if (z === null || z < 0.05 || f.prognose === "zu-frueh") return "";
    var faktor = n / z;
    return faktor > 1 ? ' · <b class="ab-tempo">' + faktor.toFixed(1).replace(".", ",") + "× zu schnell ⚠</b>" : " · reicht";
  }
  /** Zeile 5h aus den Abo-Daten, sonst aus haupt.limits; ohne beides leer. */
  function fensterZeile(L) {
    var h = L.haupt || {};
    var A = ABO && typeof ABO === "object" ? ABO : null;
    var a = A && A.aktiv && typeof A.aktiv === "object" && typeof A.aktiv.name === "string" ? A.aktiv : null;
    var limits = limitsVon(h);
    var l5 = limits.find(function (l) { return l.art === "five_hour"; }), l7 = limits.find(function (l) { return l.art === "seven_day"; });
    var konto = "", f = null, farbe = "ok", sieben = null, alt = "";
    if (a) {
      var af = a.fuenf || {}, as = a.sieben || {};
      f = { nutzung: af.nutzung, reset: af.reset, prognose: af.prognose, vollUm: af.vollUm };
      farbe = AMPEL[a.ampel] || "ok";
      konto = ' <span class="ab-konto ab-' + farbe + '" title="' + esc(a.name) + '"><span class="zs">●</span> ' + esc(kontoKurz(a.name)) + "</span>";
      sieben = { nutzung: as.nutzung, reset: as.reset };
      alt = A.alt && a.beobachtet ? verstrichen(a.beobachtet) : "";
    } else if (l5 || l7) {
      if (l5) {
        f = { nutzung: l5.prozent / 100, reset: isoVon(l5.reset), prognose: null, vollUm: null };
        farbe = stufeVon(l5.prozent / 100) || "ok";
      }
      if (l7) sieben = { nutzung: l7.prozent / 100, reset: isoVon(l7.reset) };
      alt = limitsAlt(h);
    } else if (A && reserveText(A)) {
      konto = ' <span class="ab-konto aus">kein aktiver Account</span>';
    } else {
      return "";
    }
    var rechts = [], fbar = "";
    if (f) {
      var b = fensterBalken(f, farbe);
      fbar = " " + b.html;
      var z = b.z;
      // Tempo only with abo data: from haupt.limits the line has no prognosis and no tempo.
      rechts.push('<b class="w">' + prozent(f.nutzung) + "</b>" + (a ? tempoText(f, z) : ""));
    }
    if (sieben) {
      var s7 = stufeVon(zahl(sieben.nutzung));
      rechts.push('<span class="vb-7t' + (s7 ? " " + s7 : "") + '"' + (sieben.reset ? ' title="' + esc(resetText(new Date(sieben.reset).getTime())) + '"' : "") +
        '><span class="k">7 T</span> <b class="w">' + prozent(sieben.nutzung) + "</b></span>");
    }
    var w = a && A.wechsel && typeof A.wechsel === "object" && typeof A.wechsel.name === "string" ? A.wechsel : null;
    if (w) rechts.push('<span class="ab-wechsel" title="' + esc(w.name) + '">→ ' + esc(kontoKurz(w.name)) + "</span>");
    var rechtsTitel = f && b.z !== null ? prozent(f.nutzung) + " verbraucht nach " + prozent(b.z) + " der Zeit" : "";
    return '<div class="vb-fenster' + (alt ? " alt" : "") + '" data-testid="sitzung-abo"' + (alt ? ' title="Stand vor ' + esc(alt) + '"' : "") + ">" +
      '<span class="vb-konto"><span class="k">5h</span>' + konto + "</span>" + fbar +
      (rechts.length ? ' <span class="vb-rechts"' + (rechtsTitel ? ' title="' + esc(rechtsTitel) + '"' : "") + ">" + rechts.join(TRENN) + "</span>" : "") + "</div>";
  }
  /** Der Verbrauch in zwei Zeilen; die Zeile 5h faellt ohne Daten weg. */
  function verbrauch(L) {
    return '<div class="lv-verbrauch" data-testid="sitzung-verbrauch">' + sitzungZeile(L) + fensterZeile(L) + "</div>";
  }

  /** Zuletzt sichtbare Arbeit am Plan: Start oder Ende des juengsten Agenten, ohne Agenten das Register. */
  function letzteArbeit(L) {
    var t = 0;
    (L.agenten || []).forEach(function (a) { t = Math.max(t, zahl(a.gestartet), zahl(a.beendet)); });
    return t || zahl(L.aktualisiert);
  }
  /**
   * Der Zustand am Fortschritt: abgeschlossen, N laufend, sonst `wartet seit 3m`, ab RUHE_MS `ruht
   * seit 50m` (gedimmt). Der Takt dreht wartet in ruht, ohne neu zu zeichnen (data-ruht-ab).
   */
  function fortschrittZustand(f, lauf, L) {
    if (f.fertig) return { cls: " fertig", html: '<span class="zustand">✓ abgeschlossen</span>' };
    if (lauf) return { cls: " aktiv", html: '<span class="zustand">' + lauf + " laufend</span>" };
    var t = letzteArbeit(L);
    if (!t) return { cls: "", html: '<span class="zustand">kein Agent aktiv</span>' };
    var ruht = jetztMs() - t > RUHE_MS;
    return { cls: ruht ? " ruht" : "", html: '<span class="zustand" data-ruht-ab="' + (t + RUHE_MS) + '"><span class="wort">' + (ruht ? "ruht seit" : "wartet seit") + "</span> " + zeitAngabe(isoVon(t)) + "</span>" };
  }

  function fertigOffen(n) {
    var v = lies("live-plan.live.fertig");
    return v === "auf" ? true : v === "zu" ? false : n <= 3;
  }
  function setzeFertigOffen(auf) {
    merke("live-plan.live.fertig", auf ? "auf" : "zu");
    if (wurzel && D) zeichne();
    return auf;
  }

  function laufendVon(agenten) {
    return agenten.filter(function (a) { return a.status === "laeuft" || !LIVE_ZEICHEN[a.status] || a.status === "geplant"; });
  }
  /** Die Agenten in den Gruppen Laufend, Fertig und Geplant samt `+N`; dazu die Zahlen je Gruppe. */
  function agentenGruppen(L) {
    var agenten = (Array.isArray(L.agenten) ? L.agenten : []).slice().reverse();
    var laufend = laufendVon(agenten);
    var fertig = agenten.filter(function (a) { return a.status === "fertig" || a.status === "fehler"; });
    var plan = geplant(L);
    var stufen = stufenVon(L);
    var offen = fertigOffen(fertig.length);
    var alle = mehrAuf("live");
    var platz = alle ? Infinity : LIVE_N, rest = 0;
    var nimm = function (zeilen) {
      var n = Math.max(0, Math.min(zeilen.length, platz));
      platz -= n;
      rest += zeilen.length - n;
      return zeilen.slice(0, n).join("");
    };
    var gruppe = function (cls, kopfHtml, zeilen) {
      return '<div class="lv-gruppe ' + cls + '">' + kopfHtml + (zeilen ? '<ul class="lv-agenten">' + zeilen + "</ul>" : "") + "</div>";
    };
    var gruppen = "";
    if (laufend.length) gruppen += gruppe("g-laeuft", '<div class="lv-gkopf">Laufend · ' + laufend.length + "</div>", nimm(laufend.map(function (a) { return agentZeile(a, stufen); })));
    if (fertig.length) {
      gruppen += gruppe("g-fertig", '<button type="button" class="lv-gkopf" data-live-fertig aria-expanded="' + offen + '">' + (offen ? "▾" : "▸") + " Fertig · " + fertig.length + "</button>",
        offen ? nimm(fertig.map(function (a) { return agentZeile(a, stufen); })) : "");
    }
    if (plan.length) gruppen += gruppe("g-geplant", '<div class="lv-gkopf">Geplant · ' + plan.length + "</div>", nimm(plan.map(geplantZeile)));
    var mehr = rest || alle && (laufend.length + (offen ? fertig.length : 0) + plan.length) > LIVE_N
      ? '<button type="button" class="mehr lv-mehr" data-mehr="live" aria-expanded="' + alle + '">' + (alle ? "nur " + LIVE_N : "+" + rest) + "</button>"
      : "";
    return { html: gruppen + mehr, alle: agenten.length, laufend: laufend.length, fertig: fertig.length, geplant: plan.length };
  }

  /** Der Live-Block der Sitzung aus D.live (Seite einer Sitzung nur im Register); leer ohne Register. */
  function live() {
    var L = registerVon();
    if (!L) return "";
    var g = agentenGruppen(L);
    var f = L.fortschritt, fz = "";
    if (f && typeof f === "object") {
      var gesamt = zahl(f.gesamt), erledigt = zahl(f.erledigt);
      var zu = fortschrittZustand(f, g.alle ? g.laufend : zahl(f.laufend), L);
      fz = '<span class="lv-fortschritt' + zu.cls + '" data-testid="sitzung-fortschritt"><span class="t">' + esc(f.titel || "") + '</span><span class="phase">' + esc(f.fertig ? "fertig" : f.phase || "") + "</span>" +
        balken(f.fertig ? 1 : gesamt ? erledigt / gesamt : 0, false, null, f.fertig ? "ok" : "") + '<span class="n">' + erledigt + "/" + gesamt + "</span>" + zu.html + "</span>";
    }
    var kopfZeile = '<div class="lv-kopf"><span class="k">Live</span>' + fz +
      '<span class="lv-sitzung">' + (L.beendet ? '<span class="aus">beendet</span>' : "") + "</span></div>";
    return '<section class="lp-live' + (g.laufend ? " lv-aktiv" : "") + '" data-testid="sitzung-live">' + verbrauch(L) + kopfZeile + g.html + "</section>";
  }

  /** Agenten (Vorlage): die Gruppen des Live-Blocks als eigener Abschnitt in Teil 1; leer ohne Agenten. */
  function agentenAbschnitt() {
    var L = registerVon();
    if (!L) return "";
    var g = agentenGruppen(L);
    if (!g.html) return "";
    var zahlen = [[g.laufend, "laufend"], [g.fertig, "fertig"], [g.geplant, "geplant"]].filter(function (z) { return z[0]; }).map(function (z) { return z[0] + " " + z[1]; }).join(" · ");
    return '<section class="lp-live lp-agentenliste' + (g.laufend ? " lv-aktiv" : "") + '" data-testid="sitzung-agenten" title="Agenten: ' + esc(zahlen + (L.beendet ? " · beendet" : "")) + '">' + g.html + "</section>";
  }

  // --- Dateien (Vertrag v1.1 B): Baum unter der Dokumentation ----------------------------------
  // Nachbau der Idee von data-goblin/claude-code-filetree (MIT, Kurt Buhler), eigener Code: alle
  // Dateien des Repos aus GET .../baum (Git-Status, +N -N), dazu was Claude gelesen oder geschrieben
  // hat (live.dateien). Fehlt der Endpunkt oder ein Feld, bleibt der Abschnitt still weg bzw. zeigt
  // nur, was da ist. Standard: nur beruehrte und geaenderte Dateien, Ordner mit solchen offen.
  var BAUM = null;
  var baumModus = lies("live-plan.dateien.modus") === "alle" ? "alle" : "beruehrt";
  var baumFilter = "";
  /** Folder path -> true (open) or false (closed), set by clicks; wins over the default. */
  var ordnerWahl = Object.create(null);
  var FRISCH_MS = 60000;
  /** Throttle for reloading the tree after SSE events. */
  var BAUM_TAKT_MS = 3000;
  var GIT_KLASSE = { M: "g-m", A: "g-a", D: "g-d", R: "g-r", "?": "g-neu", U: "g-konflikt" };
  var GIT_REIHE = ["M", "A", "?", "D", "R", "U"];

  /** Wartezeit bis zum naechsten Laden des Baums: hoechstens alle BAUM_TAKT_MS. */
  function baumWarte(zuletzt, jetzt) {
    return Math.max(0, zahl(zuletzt) + BAUM_TAKT_MS - zahl(jetzt));
  }
  /** Die Dateien aus Baum und Register, je Pfad ein Eintrag; Kaputtes faellt still weg. */
  function dateiListe() {
    var nach = Object.create(null), liste = [];
    var eintrag = function (p) {
      if (!nach[p]) { nach[p] = { p: p }; liste.push(nach[p]); }
      return nach[p];
    };
    (BAUM && Array.isArray(BAUM.dateien) ? BAUM.dateien : []).forEach(function (d) {
      if (!d || typeof d.p !== "string" || !d.p) return;
      var e = eintrag(d.p);
      if (GIT_KLASSE[d.s]) e.s = d.s;
      if (typeof d.plus === "number" && isFinite(d.plus)) e.plus = d.plus;
      if (typeof d.minus === "number" && isFinite(d.minus)) e.minus = d.minus;
    });
    var L = D && D.live;
    (L && Array.isArray(L.dateien) ? L.dateien : []).forEach(function (d) {
      if (!d || typeof d.pfad !== "string" || !d.pfad) return;
      var e = eintrag(d.pfad);
      if (typeof d.gelesen === "number" && isFinite(d.gelesen)) e.gelesen = d.gelesen;
      if (typeof d.geschrieben === "number" && isFinite(d.geschrieben)) e.geschrieben = d.geschrieben;
      e.n = zahl(d.n);
    });
    return liste;
  }
  function relevant(e) {
    return !!(e.s || e.gelesen || e.geschrieben);
  }
  function zuletztBeruehrt(e) {
    return Math.max(zahl(e.gelesen), zahl(e.geschrieben));
  }
  /**
   * Ordnerbaum aus Pfaden; ein absoluter Pfad (ausserhalb der Wurzel) steht ungeteilt oben.
   * `praefix` trennt die Ordnerwahl einer Branch-Gruppe (E3) von der des Baums.
   */
  function baumAus(liste, praefix) {
    var vor = praefix || "";
    var neu = function (name, pfad) { return { name: name, pfad: pfad, schluessel: vor + pfad, ordner: Object.create(null), dateien: [] }; };
    var oben = neu("", "");
    liste.forEach(function (e) {
      var teile = e.p.charAt(0) === "/" ? [e.p] : e.p.split("/").filter(Boolean);
      if (!teile.length) return;
      var k = oben;
      for (var i = 0; i < teile.length - 1; i++) {
        k = k.ordner[teile[i]] || (k.ordner[teile[i]] = neu(teile[i], k.pfad ? k.pfad + "/" + teile[i] : teile[i]));
      }
      k.dateien.push({ name: teile[teile.length - 1], e: e });
    });
    return oben;
  }
  /** Summen eines Ordners: Git-Zeichen und beruehrte Dateien, rekursiv. */
  function summeVon(k) {
    if (k.summe) return k.summe;
    var s = { relevant: 0 };
    GIT_REIHE.forEach(function (z) { s[z] = 0; });
    k.dateien.forEach(function (d) { if (d.e.s) s[d.e.s]++; if (relevant(d.e)) s.relevant++; });
    Object.keys(k.ordner).forEach(function (n) {
      var u = summeVon(k.ordner[n]);
      GIT_REIHE.forEach(function (z) { s[z] += u[z]; });
      s.relevant += u.relevant;
    });
    k.summe = s;
    return s;
  }
  function zaehlerText(s, alle) {
    return GIT_REIHE.filter(function (z) { return alle ? s[z] || z === "M" || z === "?" || z === "D" : s[z]; })
      .map(function (z) { return '<span class="' + GIT_KLASSE[z] + '">' + esc(z) + ":" + s[z] + "</span>"; }).join(" ");
  }
  function ordnerAuf(pfad, s) {
    if (baumFilter) return true;
    return ordnerWahl[pfad] !== undefined ? ordnerWahl[pfad] : s.relevant > 0;
  }
  function dateiZeile(d, tiefe) {
    var e = d.e, t = zuletztBeruehrt(e);
    var frisch = t && jetztMs() - t < FRISCH_MS;
    var auch = e.auch && e.auch.length ? e.auch.join(", ") : "";
    var titel = e.p + (e.s ? " · Git " + e.s : "") + (e.committet ? " · committet" + (e.branch ? " in " + e.branch : "") : "") + (auch ? " · auch in " + auch : "") +
      (e.gelesen ? " · gelesen " + ortszeit(isoVon(e.gelesen)) : "") +
      (e.geschrieben ? " · geschrieben " + ortszeit(isoVon(e.geschrieben)) : "") + (e.n ? " · " + e.n + "x" : "") + " · Klick zeigt den Diff";
    var diff = (e.plus ? '<i class="plus">+' + e.plus + "</i>" : "") + (e.minus ? '<i class="minus">-' + e.minus + "</i>" : "");
    var akt = (e.gelesen ? '<i class="pk gelesen" title="gelesen"></i>' : "") + (e.geschrieben ? '<i class="pk geschrieben" title="geschrieben"></i>' : "");
    // Only rows of a branch group (E3) carry these marks; the tree's rows stay as they were.
    var marken = (e.committet ? '<span class="bd-marke">committet</span>' : "") + (auch ? '<span class="bd-auch">auch in ' + esc(auch) + "</span>" : "");
    return '<button type="button" class="bd-datei ' + (GIT_KLASSE[e.s] || "g-sauber") + (frisch ? " frisch" : "") + '" data-pfad="' + esc(e.p) + '"' + (e.branch ? ' data-branch="' + esc(e.branch) + '"' : "") + ' title="' + esc(titel) + '" style="--t:' + tiefe + '">' +
      '<span class="nm">' + esc(d.name) + '</span><span class="df">' + diff + "</span>" + marken + '<span class="akt">' + akt + "</span>" +
      (t ? zeitAngabe(isoVon(t), "uhr bd-zeit") : '<span class="bd-zeit"></span>') + "</button>";
  }
  /** Ein Ordner samt Inhalt; Ketten aus Ordnern ohne Dateien mit genau einem Unterordner werden zu a/b/c. */
  function ordnerZeilen(k, tiefe) {
    var name = k.name, knoten = k;
    for (var namen = Object.keys(knoten.ordner); namen.length === 1 && !knoten.dateien.length; namen = Object.keys(knoten.ordner)) {
      knoten = knoten.ordner[namen[0]];
      name += "/" + knoten.name;
    }
    var s = summeVon(knoten);
    var auf = ordnerAuf(knoten.schluessel, s);
    return '<button type="button" class="bd-ordner" data-ordner="' + esc(knoten.schluessel) + '" aria-expanded="' + auf + '" title="' + esc(knoten.pfad) + '" style="--t:' + tiefe + '">' +
      '<span class="pf">' + (auf ? "▾" : "▸") + '</span><span class="nm">' + esc(name) + '/</span><span class="sm">' + zaehlerText(s, false) + "</span></button>" +
      (auf ? inhaltZeilen(knoten, tiefe + 1) : "");
  }
  function inhaltZeilen(k, tiefe) {
    var ordner = Object.keys(k.ordner).sort();
    var dateien = k.dateien.slice().sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });
    return ordner.map(function (n) { return ordnerZeilen(k.ordner[n], tiefe); }).join("") + dateien.map(function (d) { return dateiZeile(d, tiefe); }).join("");
  }
  // --- GitButler (E3): je angewendetem Branch ein Abschnitt mit seinen Dateien -----------------
  // Aus BAUM.but (nur unter gitbutler/workspace) oberhalb des bisherigen Baums, danach "nicht
  // zugeordnet". Fehlt but oder ist es kaputt, bleibt der Abschnitt Dateien wie zuvor.
  /** Group key ("b:" + branch, "o:" for unassigned) -> false once closed by a click; default open. */
  var gruppeWahl = Object.create(null);

  /** Die Dateien einer Gruppe wie in dateiListe, dazu committet, auch und der Branch fuer den Diff. */
  function gruppenEintraege(dateien, branch, aktivitaet) {
    return (Array.isArray(dateien) ? dateien : []).filter(function (d) { return d && typeof d.p === "string" && d.p; }).map(function (d) {
      var e = { p: d.p, committet: d.committet === true, uncommittet: d.uncommittet === true };
      e.auch = Array.isArray(d.auch) ? d.auch.filter(function (x) { return typeof x === "string" && x; }) : [];
      if (GIT_KLASSE[d.s]) e.s = d.s;
      if (typeof d.plus === "number" && isFinite(d.plus)) e.plus = d.plus;
      if (typeof d.minus === "number" && isFinite(d.minus)) e.minus = d.minus;
      // Committed only: the diff comes from the branch, not from the workspace.
      if (branch && e.committet && !e.uncommittet) e.branch = branch;
      var a = aktivitaet[d.p];
      if (a) ["gelesen", "geschrieben", "n"].forEach(function (k) { if (a[k]) e[k] = a[k]; });
      return e;
    });
  }
  /** Die Gruppen aus BAUM.but: je Branch eine, dann nicht zugeordnet, sofern es dort Dateien gibt. */
  function gruppenAusBut() {
    var but = BAUM && BAUM.but;
    if (!but || typeof but !== "object" || !Array.isArray(but.branches)) return [];
    var aktivitaet = Object.create(null);
    dateiListe().forEach(function (e) { aktivitaet[e.p] = e; });
    var gruppen = but.branches.filter(function (b) { return b && typeof b.name === "string" && b.name; }).map(function (b) {
      return { schluessel: "b:" + b.name, titel: b.name, eintraege: gruppenEintraege(b.dateien, b.name, aktivitaet) };
    });
    var ohne = gruppenEintraege(but.ohne, null, aktivitaet);
    if (ohne.length) gruppen.push({ schluessel: "o:", titel: "nicht zugeordnet", eintraege: ohne });
    return gruppen;
  }
  /** Kopf mit Name, Zaehlern und Warnzeichen bei Ueberschneidung; darin der Baum im Stil des Bestands. Der Filter wirkt, der Modus nicht. */
  function gruppeHtml(g) {
    var auf = gruppeWahl[g.schluessel] !== false;
    var c = 0, u = 0, andere = [];
    g.eintraege.forEach(function (e) {
      if (e.committet) c++;
      if (e.uncommittet) u++;
      e.auch.forEach(function (x) { if (andere.indexOf(x) < 0) andere.push(x); });
    });
    var zaehler = [c ? c + " committet" : "", u ? u + " uncommittet" : ""].filter(Boolean).join(" · ") || "keine Datei";
    var such = baumFilter.toLowerCase();
    var liste = such ? g.eintraege.filter(function (e) { return e.p.toLowerCase().indexOf(such) >= 0; }) : g.eintraege;
    return '<div class="bd-gruppe' + (andere.length ? " warn" : "") + '"><button type="button" class="bd-gkopf" title="' + esc(g.titel) + '" data-bd-gruppe="' + esc(g.schluessel) + '" aria-expanded="' + auf + '">' +
      '<span class="pf">' + (auf ? "▾" : "▸") + '</span><span class="nm">' + esc(g.titel) + '</span><span class="sm">' + zaehler + "</span>" +
      (andere.length ? '<span class="bd-warn" title="' + esc("Ueberschneidung: Dateien auch in einem anderen Branch (" + andere.join(", ") + ")") + '">⚠</span>' : "") + "</button>" +
      (auf && liste.length ? inhaltZeilen(baumAus(liste, g.schluessel + "//"), 1) : "") + "</div>";
  }
  function setzeGruppe(schluessel, auf) {
    gruppeWahl[schluessel] = !!auf;
    if (wurzel && D) zeichneDateien();
  }

  /** Der Inhalt des Baums nach Modus und Filter, ohne Kopf (wird beim Tippen allein ersetzt); unter GitButler die Gruppen davor. */
  function baumInhalt() {
    var gruppen = gruppenAusBut();
    return (gruppen.length ? gruppen.map(gruppeHtml).join("") + '<div class="bd-rest">Workspace</div>' : "") + restInhalt();
  }
  function restInhalt() {
    var such = baumFilter.toLowerCase();
    var liste = dateiListe().filter(function (e) {
      return (baumModus === "alle" || relevant(e)) && (!such || e.p.toLowerCase().indexOf(such) >= 0);
    });
    if (!liste.length) {
      return '<p class="leer">' + (such ? "Kein Treffer fuer " + esc(baumFilter) : baumModus === "alle" ? "Keine Dateien" : "Noch keine Datei beruehrt oder geaendert") + "</p>";
    }
    return inhaltZeilen(baumAus(liste), 0);
  }
  /** Zweig, vor/zurueck, Zaehler der Git-Zeichen; ohne Baum nur der Hinweis. */
  function baumInfo() {
    if (!BAUM) return '<span class="unbekannt">Git-Stand unbekannt</span>';
    var s = { relevant: 0 };
    GIT_REIHE.forEach(function (z) { s[z] = 0; });
    dateiListe().forEach(function (e) { if (e.s) s[e.s]++; });
    return (typeof BAUM.zweig === "string" && BAUM.zweig ? '<b class="zweig">' + esc(BAUM.zweig) + "</b>" : '<span class="unbekannt">Zweig unbekannt</span>') +
      (BAUM.upstream ? '<span class="vz" title="' + esc("gegen " + BAUM.upstream) + '">↑' + zahl(BAUM.vor) + " ↓" + zahl(BAUM.zurueck) + "</span>" : "") +
      '<span class="zaehler">' + zaehlerText(s, true) + "</span>" +
      (BAUM.gekappt ? '<span class="unbekannt">gekappt</span>' : "");
  }
  /** Der Abschnitt Dateien; leer, solange weder Baum noch live.dateien da sind. */
  function dateien() {
    var L = D && D.live;
    if (!BAUM && !(L && Array.isArray(L.dateien) && L.dateien.length)) return "";
    var modi = [["beruehrt", "beruehrt+geaendert"], ["alle", "alle"]];
    return '<section class="lp-dateien" data-testid="sitzung-dateien"><div class="bd-kopf"><h2>Dateien</h2><span class="bd-info" data-bd-info>' + baumInfo() + "</span>" +
      '<input type="search" class="bd-filter" data-bd-filter placeholder="Filter" aria-label="Dateien filtern" value="' + esc(baumFilter) + '">' +
      '<div class="seg bd-modus" role="group" aria-label="Dateien">' + modi.map(function (m) {
        return '<button type="button" class="' + (m[0] === baumModus ? "aktiv" : "") + '" data-bd-modus="' + m[0] + '" aria-pressed="' + (m[0] === baumModus) + '">' + m[1] + "</button>";
      }).join("") + "</div></div>" +
      '<div class="bd-baum" data-bd-baum>' + baumInhalt() + "</div></section>";
  }
  // --- Diff einer Datei: Klick im Baum, Modal wie das Beweisbild, Daten aus GET .../diff?p= -------
  var DIFF_ART = { diff: "Diff gegen HEAD", neu: "neu, unversioniert", datei: "unveraendert", binaer: "binaer" };
  /**
   * Zeilen eines Diffs mit Art und Nummern aus den @@-Koepfen: plus, minus, kontext, hunk, kopf
   * (vor dem ersten @@) und hinweis (`\ No newline`). Bei art `datei` ist jede Zeile kontext, gezaehlt ab 1.
   */
  function diffZeilen(text, art) {
    var zeilen = String(text || "").split("\n");
    if (zeilen[zeilen.length - 1] === "") zeilen.pop();
    var alt = 0, neu = 0, imHunk = false;
    return zeilen.map(function (t) {
      if (art === "datei") return { k: "kontext", neu: ++neu, t: t };
      var m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(t);
      if (m) { alt = Number(m[1]); neu = Number(m[2]); imHunk = true; return { k: "hunk", t: t }; }
      var c = imHunk ? t.charAt(0) : "";
      if (c === "+") return { k: "plus", neu: neu++, t: t };
      if (c === "-") return { k: "minus", alt: alt++, t: t };
      if (c === " ") return { k: "kontext", alt: alt++, neu: neu++, t: t };
      if (c === "\\") return { k: "hinweis", t: t };
      imHunk = false;
      return { k: "kopf", t: t };
    });
  }
  function diffZeileHtml(z) {
    return '<div class="dz dz-' + z.k + '"><span class="dz-nr">' + (z.alt !== undefined ? z.alt : "") + '</span><span class="dz-nr">' + (z.neu !== undefined ? z.neu : "") +
      "</span><code>" + esc(z.t) + "</code></div>";
  }
  /** Das Modal des Diffs: Kopf mit Pfad, Status und Pfad kopieren, darunter die Zeilen; Hinweis statt Inhalt bei binaer, Fehler oder Laden. */
  function diffModal(z) {
    if (!z || typeof z.p !== "string") return "";
    var b = z.daten && typeof z.daten === "object" ? z.daten : null;
    var art = z.branch ? "committet in " + z.branch : b && DIFF_ART[b.art] ? DIFF_ART[b.art] : "";
    var status = [z.s ? "Git " + z.s : "", art, b && b.gekappt ? "gekappt" : ""].filter(Boolean).join(" · ");
    var hinweis = function (t) { return '<p class="df-hinweis">' + esc(t) + "</p>"; };
    var inhalt = z.fehler ? hinweis("Fehler: " + z.fehler)
      : !b ? hinweis("laedt …")
      : b.art === "binaer" ? hinweis(b.text || "Binaerdatei, Inhalt nicht gezeigt")
      : !b.text ? hinweis(b.art !== "diff" ? "Leere Datei" : z.branch ? "Kein Unterschied" : "Kein Unterschied zu HEAD")
      : '<div class="lp-diff-text' + (b.art === "diff" ? "" : " einspaltig") + '" tabindex="0">' + diffZeilen(b.text, b.art).map(diffZeileHtml).join("") + "</div>" +
        (b.gekappt ? hinweis("gekappt: gezeigt ist nur der Anfang") : "");
    return '<div class="lp-modal" data-modal-zu><div class="lp-modal-box lp-diff" role="dialog" aria-modal="true" aria-labelledby="lp-modal-titel" data-testid="sitzung-diff">' +
      '<div class="lp-modal-kopf"><h2 id="lp-modal-titel" class="mono">' + esc(z.p) + '</h2><span class="pfad">' + esc(status) + "</span>" +
      '<button type="button" class="kopieren" data-kopiere="' + esc(z.p) + '">Pfad kopieren</button>' +
      '<button type="button" class="zu" data-modal-zu aria-label="Schliessen (Esc)" title="Schliessen (Esc)">×</button></div>' + inhalt + "</div></div>";
  }

  function setzeBaumModus(m) {
    baumModus = m === "alle" ? "alle" : "beruehrt";
    merke("live-plan.dateien.modus", baumModus);
    if (wurzel && D) zeichne();
    return baumModus;
  }
  function setzeOrdner(pfad, auf) {
    ordnerWahl[pfad] = !!auf;
    if (wurzel && D) zeichneDateien();
  }

  /** Der Kopf einer Sitzung, die nur im Register steht (S5): ohne YAML, ohne Plan. */
  function kopfNurLive() {
    var L = D.live || {};
    var titel = (L.fortschritt && L.fortschritt.titel) || D.repo + " · " + D.slug;
    return '<header class="lp-kopf"><div class="lp-oben"><a class="lp-zurueck" href="/" title="alle Sitzungen"></a><h1 data-testid="sitzung-titel">' + esc(titel) + "</h1>" + themaSchalter() + "</div>" +
      '<div class="lp-zeile lp-meta"><span class="mono">' + esc(L.cwd || D.repoPfad || "") + '</span><span class="unbekannt">nur Register, keine .live-plan/' + esc(D.slug) + ".yaml</span></div></header>";
  }

  // --- Firstmate: Worker als Karten, Captain-Inbox, Warteschlange, Projekte (GET .../firstmate) ----
  // Nur wenn die Wurzel der Sitzung ein Firstmate-Home ist (FM.home). Eine Karte je Worker wie ein Kasten
  // des Cockpits; ein Klick oeffnet die Details im Modal wie beim Diff. Ohne Pane-Inhalte (bleibt im Terminal).
  var FM = null;
  /** Id des Workers, dessen Details im Modal stehen. */
  var fmAuf = null;
  var FM_ZUSTAND = { working: "●", paused: "‖", blocked: "■", "needs-decision": "?", done: "✓", failed: "✗", dead: "†", unknown: "·" };
  var FM_WARTESCHLANGE_N = 8;
  function isoAus(sek) {
    return typeof sek === "number" && isFinite(sek) && sek > 0 ? new Date(sek * 1000).toISOString() : "";
  }
  function prKurz(url) {
    var m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(String(url || ""));
    return m ? m[1] + "#" + m[2] : String(url || "");
  }
  /** Ein Link nur auf https-Adressen; sonst der Text. */
  function fmLink(url, text) {
    return /^https:\/\//.test(String(url || "")) ? '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(text) + "</a>" : esc(text);
  }
  function fmZustand(w) {
    return FM_ZUSTAND[w && w.zustand] ? w.zustand : "unknown";
  }
  function fmWorker(id) {
    return FM && Array.isArray(FM.worker) ? FM.worker.find(function (w) { return w && w.id === id; }) : null;
  }
  function fmProjektName(p) {
    return p ? String(p).replace(/\/+$/, "").split("/").pop() : "";
  }
  function fmZweig(w) {
    var wt = w.worktree, m = w.meta || {};
    if (wt && wt.da) {
      return esc(wt.zweig || "?") + (wt.ahead === null || wt.ahead === undefined ? "" : ' <span class="vz">↑' + zahl(wt.ahead) + " ↓" + zahl(wt.behind) + "</span>") +
        (wt.geaendert ? ' <span class="g-m">±' + zahl(wt.geaendert) + "</span>" : "");
    }
    return m.branch ? esc(m.branch) + (wt ? ' <span class="unbekannt">kein Worktree</span>' : "") : "";
  }
  function fmStatusZeile(s) {
    if (!s) return '<span class="unbekannt">noch keine Statuszeile</span>';
    return (s.at ? zeitAngabe(isoAus(s.at)) + " " : '<span class="unbekannt">?</span> ') + esc(s.text);
  }
  function fmKarte(w) {
    var z = fmZustand(w), m = w.meta || {};
    var post = w.inbox && w.inbox.wartend && w.inbox.wartend.length ? '<span class="fm-post" title="ungelesene Nachrichten von Firstmate">✉ ' + w.inbox.wartend.length + "</span>" : "";
    var zeilen = [
      [fmProjektName(m.project), [m.kind, m.mode].filter(Boolean).join("/")].filter(Boolean).map(esc).join(" · "),
      esc([m.harness, m.model, m.effort].filter(Boolean).join("/")),
    ].filter(Boolean).map(function (t) { return '<div class="fm-zeile">' + t + "</div>"; }).join("");
    var pr = m.pr ? '<div class="fm-zeile">PR ' + fmLink(m.pr, prKurz(m.pr)) + "</div>" : "";
    var zweig = fmZweig(w);
    return '<div class="fm-karte fm-z-' + z + '" role="button" tabindex="0" data-fm-worker="' + esc(w.id) + '" title="Details zu ' + esc(w.id) + '">' +
      '<div class="fm-kopf"><span class="fm-zeichen">' + FM_ZUSTAND[z] + '</span><b class="mono">' + esc(w.id) + "</b>" + post + '<span class="fm-zustand">' + esc(z) + "</span></div>" +
      (w.titel ? '<div class="fm-titel">' + esc(w.titel) + "</div>" : "") + zeilen +
      '<div class="fm-status">' + fmStatusZeile(w.status && w.status.letzte) + "</div>" + pr +
      (zweig ? '<div class="fm-zeile mono">' + zweig + "</div>" : "") + "</div>";
  }
  function fmLage() {
    var n = Array.isArray(FM.notizen) ? FM.notizen.length : 0;
    var ws = Array.isArray(FM.warteschlange) ? FM.warteschlange : null;
    var notiz = n === 0 ? "keine Notiz wartet" : n === 1 ? "1 Notiz wartet" : n + " Notizen warten";
    var zeilen = (ws || []).slice(0, FM_WARTESCHLANGE_N).map(function (a) {
      return '<li><span class="mono">' + esc(a.id) + '</span><span class="fm-wartet' + (a.wartet === "bereit" ? " bereit" : "") + '">' + esc(a.wartet) + "</span>" + esc(a.titel) + "</li>";
    }).join("");
    var rest = ws && ws.length > FM_WARTESCHLANGE_N ? '<li class="unbekannt">+' + (ws.length - FM_WARTESCHLANGE_N) + " weitere (cockpit --once)</li>" : "";
    return '<div class="fm-lage"><span class="' + (n ? "fm-inbox warten" : "fm-inbox") + '" title="' + esc((FM.notizen || []).join(", ")) + '">Captain-Inbox: ' + esc(notiz) + "</span>" +
      "<span>Warteschlange: " + (ws === null ? "kein Backlog" : ws.length || "leer") + "</span></div>" + (zeilen || rest ? '<ul class="fm-warteschlange">' + zeilen + rest + "</ul>" : "");
  }
  function fmPrs(p) {
    if (!p.github) return '<span class="unbekannt" title="origin ist kein GitHub-Repo">—</span>';
    var s = p.prs;
    if (!s || s.art === "laedt") return '<span class="unbekannt">PRs laden …</span>';
    if (s.art !== "ok" || !Array.isArray(s.prs)) return '<span class="unbekannt" title="gh hat nicht geantwortet">PRs unbekannt</span>';
    if (!s.prs.length) return '<span class="unbekannt">keine offenen</span>';
    return '<b class="fm-prn">' + s.prs.length + " offen</b>" + '<ul class="fm-prs">' + s.prs.map(function (x) {
      return "<li>" + fmLink(x.url, "#" + x.nummer) + " " + esc(x.titel) + (x.entwurf ? ' <span class="unbekannt">Entwurf</span>' : "") + "</li>";
    }).join("") + "</ul>";
  }
  function fmProjektZeile(p) {
    var r = p.register;
    var name = '<b class="mono">' + esc(p.name) + "</b>" + (r && r.haltung ? ' <span class="fm-haltung">' + esc(r.haltung) + "</span>" : "") +
      (r && r.beschreibung ? '<div class="klein">' + esc(r.beschreibung) + "</div>" : r ? "" : '<div class="klein unbekannt">nicht in data/projects.md</div>');
    if (!p.git) return "<tr><td>" + name + '</td><td colspan="5" class="unbekannt">kein Git-Klon</td><td>' + esc((p.worker || []).join(", ")) + "</td><td></td></tr>";
    var zweig = esc(p.zweig || "detached") + (p.upstream ? ' <span class="vz" title="' + esc("gegen " + p.upstream) + '">↑' + zahl(p.ahead) + " ↓" + zahl(p.behind) + "</span>" : ' <span class="unbekannt">kein Upstream</span>');
    var stand = p.geaendert ? '<span class="g-m">geändert ±' + zahl(p.geaendert) + "</span>" : '<span class="fm-sauber">sauber</span>';
    var commit = p.commit ? zeitAngabe(isoAus(p.commit.zeit)) + ' <span class="mono klein">' + esc(p.commit.hash) + "</span> " + esc(p.commit.betreff) : '<span class="unbekannt">kein Commit</span>';
    var abgerufen = p.abgerufen ? zeitAngabe(isoAus(p.abgerufen)) : '<span class="unbekannt">nie</span>';
    var worker = (p.worker || []).map(function (id) { return '<span class="mono fm-wid" data-fm-worker="' + esc(id) + '" role="button" tabindex="0">' + esc(id) + "</span>"; }).join(" ");
    return "<tr><td>" + name + '</td><td class="mono">' + zweig + "</td><td>" + stand + "</td><td>" + commit + "</td><td>" + abgerufen + "</td><td>" + fmPrs(p) + "</td><td>" + worker + "</td></tr>";
  }
  /** Der Abschnitt Firstmate; leer, solange kein Home da ist. */
  function firstmateTeil() {
    if (!FM || !FM.home) return "";
    var kopf = '<h2 class="lp-h">Firstmate <span class="zaehler">';
    if (FM.fehler) return '<section class="lp-firstmate" data-testid="sitzung-firstmate">' + kopf + esc(FM.home) + '</span></h2><p class="unbekannt">' + esc(FM.fehler) + "</p></section>";
    var worker = Array.isArray(FM.worker) ? FM.worker : [];
    var projekte = Array.isArray(FM.projekte) ? FM.projekte : [];
    var zahlen = FM.backlog && typeof FM.backlog === "object" ? Object.keys(FM.backlog).map(function (k) { return k + " " + zahl(FM.backlog[k]); }).join(", ") : "kein Backlog";
    return '<section class="lp-firstmate" data-testid="sitzung-firstmate">' + kopf + worker.length + " Worker · " + esc(zahlen) + "</span></h2>" +
      '<div class="fm-meta"><span class="mono">' + esc(FM.home) + "</span>" + (FM.tmux === false ? '<span class="unbekannt">tmux nicht erreichbar</span>' : "") +
      (FM.zeit ? "<span>Stand " + zeitAngabe(isoAus(FM.zeit)) + "</span>" : "") + "</div>" + fmLage() +
      '<h3 class="fm-h">Aktive Worker</h3>' + (worker.length ? '<div class="fm-karten" data-testid="firstmate-worker">' + worker.map(fmKarte).join("") + "</div>" : '<p class="unbekannt">keine Worker (kein state/*.meta)</p>') +
      '<h3 class="fm-h">Projekte <span class="zaehler">' + projekte.length + "</span></h3>" +
      (projekte.length ? '<div class="fm-tabelle"><table class="fm-projekte" data-testid="firstmate-projekte"><thead><tr><th>Projekt</th><th>Zweig</th><th>Stand</th><th>Letzter Commit</th><th>zuletzt aktualisiert</th><th>PRs</th><th>Worker</th></tr></thead><tbody>' +
        projekte.map(fmProjektZeile).join("") + "</tbody></table></div>" : '<p class="unbekannt">keine Klone unter projects/</p>') + "</section>";
  }
  /** Die Details eines Workers im Modal: wie `cockpit --once`, ohne Pane-Zeilen. */
  function fmModal(id) {
    var w = id && fmWorker(id);
    if (!w) return "";
    var m = w.meta || {}, z = fmZustand(w), fe = w.fenster || {}, wt = w.worktree;
    var feld = function (name, wert) { return wert ? "<dt>" + esc(name) + "</dt><dd>" + wert + "</dd>" : ""; };
    var lebt = fe.lebt === null || fe.lebt === undefined ? "?" : fe.lebt ? "lebt" : "FEHLT";
    var felder =
      feld("Projekt", esc([m.project, m.kind && "kind=" + m.kind, m.mode && "mode=" + m.mode, m.yolo && "yolo=" + m.yolo].filter(Boolean).join("  "))) +
      feld("Harness", esc([m.harness, m.model && "model=" + m.model, m.effort && "effort=" + m.effort, m.backend && "backend=" + m.backend, m.remote_host && "remote=" + m.remote_host].filter(Boolean).join("  "))) +
      feld("Gestartet", w.gestartet ? zeitAngabe(isoAus(w.gestartet)) + " (" + esc(ortszeit(isoAus(w.gestartet))) + ")" : "") +
      feld("Fenster", fe.ziel ? esc(fe.ziel + "  " + lebt + (fe.befehl ? "  " + fe.befehl : "")) + (fe.aktivitaet ? " · aktiv " + zeitAngabe(isoAus(fe.aktivitaet)) : "") : "keins") +
      feld("Busy", w.busy ? esc(w.busy.zustand + (w.busy.quelle ? " (" + w.busy.quelle + ")" : "")) + (w.busy.ts ? " " + zeitAngabe(isoAus(w.busy.ts)) : "") : "") +
      feld("Inbox", w.inbox ? esc(w.inbox.wartend.length + " wartend" + (w.inbox.wartend.length ? " (" + w.inbox.wartend.join(", ") + ")" : "") + ", " + w.inbox.erledigt + " erledigt") : "") +
      feld("PR", m.pr ? fmLink(m.pr, m.pr) : "") +
      (wt ? feld("Worktree", esc(wt.pfad + (wt.da ? "" : "  (nicht da)"))) +
        (wt.da ? feld("Git", esc((wt.zweig || "?") + (m.branch && wt.zweig !== m.branch ? " (Meta: " + m.branch + ")" : "") + "  " +
          (wt.ahead === null || wt.ahead === undefined ? "kein Upstream" : wt.upstream + " +" + wt.ahead + " -" + wt.behind) + "  " + zahl(wt.geaendert) + " geändert")) + feld("Commit", esc(wt.letzterCommit || "")) : "")
        : feld("Zweig", esc(m.branch || ""))) +
      feld("Daten", w.daten && w.daten.dateien && w.daten.dateien.length ? esc(w.daten.ordner + "/ (" + w.daten.dateien.join(", ") + ")") : "");
    var zeile = function (s) {
      return '<li class="fm-v-' + esc(s.verb) + '"><span class="fm-verb">' + esc(s.verb) + (s.key ? " [" + esc(s.key) + "]" : "") + "</span>" + (s.at ? zeitAngabe(isoAus(s.at)) : '<span class="unbekannt">?</span>') + " " + esc(s.text) + "</li>";
    };
    var offen = w.status && Array.isArray(w.status.offen) ? w.status.offen : [];
    var verlauf = Array.isArray(w.verlauf) ? w.verlauf.slice().reverse() : [];
    var befehle = Array.isArray(w.befehle) ? w.befehle : [];
    return '<div class="lp-modal" data-modal-zu><div class="lp-modal-box lp-fm fm-z-' + z + '" role="dialog" aria-modal="true" aria-labelledby="lp-modal-titel" data-testid="firstmate-details">' +
      '<div class="lp-modal-kopf"><h2 id="lp-modal-titel"><span class="fm-zeichen">' + FM_ZUSTAND[z] + '</span> <span class="mono">' + esc(w.id) + "</span>" + (w.titel ? " · " + esc(w.titel) : "") + "</h2>" +
      '<span class="pfad">' + esc(z) + "</span>" +
      '<button type="button" class="zu" data-modal-zu aria-label="Schliessen (Esc)" title="Schliessen (Esc)">×</button></div>' +
      '<div class="fm-details" tabindex="0"><dl class="fm-felder">' + felder + "</dl>" +
      (offen.length ? '<h3 class="fm-h">Offene Entscheidungen und Blocker</h3><ul class="fm-verlauf">' + offen.map(zeile).join("") + "</ul>" : "") +
      '<h3 class="fm-h">Statusverlauf <span class="zaehler">' + (w.status ? zahl(w.status.zeilen) : 0) + " Zeilen</span></h3>" +
      (verlauf.length ? '<ul class="fm-verlauf">' + verlauf.map(zeile).join("") + "</ul>" : '<p class="unbekannt">noch keine Statuszeile</p>') +
      (befehle.length ? '<h3 class="fm-h">Befehle</h3><ul class="fm-befehle">' + befehle.map(function (b) {
        return '<li><span class="fm-zweck">' + esc(b.zweck) + '</span><code>' + esc(b.befehl) + '</code><button type="button" class="kopieren" data-kopiere="' + esc(b.befehl) + '">kopieren</button></li>';
      }).join("") + "</ul>" : "") +
      '<p class="klein unbekannt">Pane-Inhalte zeigt nur das Cockpit im Terminal.</p></div></div></div>';
  }

  // --- Dokumentation und Handout (#328) -----------------------------------------------------------
  // `doku:` aus der Sitzungsdatei als Teil 2 unter den Sitzungsteilen: Ablauf als SVG-Flowchart, Bausteine,
  // Aufbau der Sitzungsdatei, Regeln, Was die Seite zeigt, Befehle, Aufbau des Registers; Kopf und Ueberblick
  // nutzen doku ebenfalls. Mit ?handout=1 zeigt die Ansicht nur Kopf, Ueberblick, Anforderungen,
  // Entscheidungen und Teil 2, dunkel und 1600 px breit, und setzt danach data-fertig auf <html>;
  // `live-plan handout` wartet darauf. Alle Farben sind Variablen des Themas (live-plan.css).
  var DOKU_FARBE = { agent: "var(--l1)", helfer: "var(--l5)", daten: "var(--l3)", dienst: "var(--ok)", mensch: "var(--l4)" };
  var DOKU_ROLLE = { agent: "Agent", helfer: "Subagent", daten: "Daten", dienst: "Dienst", mensch: "Mensch" };
  var DOKU_REGEL = { immer: ["Immer", "haken", "var(--l1)"], nie: ["Nie", "flagge", "var(--rot)"], tipp: ["Gut zu wissen", "mensch", "var(--l4)"] };
  var DOKU_ARTEN = ["start", "aktion", "frage", "daten", "ende"];
  var DOKU_STATI = ["fertig", "laeuft", "wartet", "offen"];
  var DOKU_GEOM = { nw: 160, nh: 58, strip: 112, step: 176, lane: 104, pad: 12, radius: 10 };

  /** Die Glyphen des Things-Stils: Ring (To-do), Stern (braucht Sie), halber Ring, Haken im Kreis, Dokument, Kasten. */
  function dokuIcon(art, x, y, farbe) {
    var f = function (n) { return Math.round(n * 10) / 10; };
    if (art === "mensch" || art === "frage") {
      var pts = [];
      for (var j = 0; j < 10; j++) {
        var r = j % 2 === 0 ? 7.5 : 3.3, w = -Math.PI / 2 + j * Math.PI / 5;
        pts.push(f(x + r * Math.cos(w)) + "," + f(y + r * Math.sin(w)));
      }
      return '<polygon points="' + pts.join(" ") + '" fill="' + farbe + '"/>';
    }
    if (art === "helfer") {
      return '<circle cx="' + x + '" cy="' + y + '" r="6.5" fill="none" stroke="' + farbe + '" stroke-width="1.6"/><circle cx="' + x + '" cy="' + y + '" r="2.6" fill="' + farbe + '"/>';
    }
    if (art === "fertig" || art === "haken") {
      return '<circle cx="' + x + '" cy="' + y + '" r="7.5" fill="' + farbe + '"/><path d="M' + (x - 3.5) + "," + (y + 0.2) + ' l2.3,2.3 4.6,-4.8" fill="none" stroke="var(--auf)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>';
    }
    if (art === "laeuft") {
      return '<circle cx="' + x + '" cy="' + y + '" r="6.5" fill="none" stroke="' + farbe + '" stroke-width="1.6"/><path d="M' + x + "," + y + " V" + (y - 4) + " A4 4 0 0 1 " + x + "," + (y + 4) + ' Z" fill="' + farbe + '"/>';
    }
    if (art === "daten") {
      return '<path d="M' + (x - 5) + "," + (y - 7) + " H" + (x + 2) + " L" + (x + 6) + "," + (y - 3) + " V" + (y + 7) + " H" + (x - 5) + ' Z" fill="none" stroke="' + farbe + '" stroke-width="1.5" stroke-linejoin="round"/>' +
        '<path d="M' + (x + 2) + "," + (y - 7) + " V" + (y - 3) + " H" + (x + 6) + '" fill="none" stroke="' + farbe + '" stroke-width="1.2"/>';
    }
    if (art === "dienst") {
      return '<rect x="' + (x - 7) + '" y="' + (y - 6) + '" width="14" height="12" rx="2.5" fill="none" stroke="' + farbe + '" stroke-width="1.5"/><line x1="' + (x - 7) + '" y1="' + (y - 2) + '" x2="' + (x + 7) + '" y2="' + (y - 2) + '" stroke="' + farbe + '" stroke-width="1.5"/>';
    }
    if (art === "flagge") {
      return '<path d="M' + (x - 4.5) + "," + (y + 7) + " V" + (y - 6.5) + " M" + (x - 4.5) + "," + (y - 6) + " h9 l-2.2,3.2 2.2,3.3 h-9" + '" fill="' + farbe + '" stroke="' + farbe + '" stroke-width="1.6" stroke-linejoin="round"/>';
    }
    return '<circle cx="' + x + '" cy="' + y + '" r="6.5" fill="none" stroke="' + farbe + '" stroke-width="1.6"/>';
  }
  function dokuGlyph(art, farbe, gr) {
    var g = gr || 18;
    return '<svg class="dk-glyph" width="' + g + '" height="' + g + '" viewBox="0 0 18 18" aria-hidden="true">' + dokuIcon(art, 9, 9, farbe) + "</svg>";
  }
  function dokuRolle(r) {
    return DOKU_FARBE[r] ? r : "agent";
  }

  /** Bricht einen Text an Wortgrenzen auf Zeilen von hoechstens n Zeichen. */
  function dokuUmbruch(text, n) {
    var zeilen = [], zeile = "";
    String(text == null ? "" : text).split(/\s+/).filter(Boolean).forEach(function (w) {
      if (zeile && zeile.length + 1 + w.length > n) {
        zeilen.push(zeile);
        zeile = w;
      } else {
        zeile = (zeile + " " + w).trim();
      }
    });
    if (zeile) zeilen.push(zeile);
    return zeilen;
  }

  /** Hoechstens `max` Zeilen; der Rest endet als Auslassungszeichen in der letzten (der volle Text steht im Tooltip). */
  function dokuKappe(zeilen, max, n) {
    if (zeilen.length <= max) return zeilen;
    var rest = zeilen.slice(0, max);
    var letzte = rest[max - 1];
    rest[max - 1] = (letzte.length >= n ? letzte.slice(0, n - 1) : letzte) + "…";
    return rest;
  }

  /** Die Spalte je Schritt: Spruenge ueber Bahnen bleiben in der Spalte, Schritte in derselben Bahn ruecken vor. */
  function dokuSpalten(ab) {
    var bahn = {}, idx = {}, li = {}, col = {}, belegt = {}, durch = {};
    var order = ab.bahnen.map(function (b) { return b.id; });
    ab.schritte.forEach(function (k, i) { bahn[k.id] = k.bahn; idx[k.id] = i; });
    order.forEach(function (id, i) { li[id] = i; });
    var schluessel = function (b, c) { return b + "\u0000" + c; };
    var zwischen = function (s, n, c) {
      var a = Math.min(li[bahn[s]], li[bahn[n]]), z = Math.max(li[bahn[s]], li[bahn[n]]), r = [];
      for (var i = a + 1; i < z; i++) r.push(schluessel(order[i], c));
      return r;
    };
    ab.schritte.forEach(function (k) {
      var n = k.id;
      var vor = ab.kanten.filter(function (e) { return e.nach === n && idx[e.von] !== undefined && idx[e.von] < idx[n]; }).map(function (e) { return e.von; });
      var c = 0;
      vor.forEach(function (s) { c = Math.max(c, col[s] + (bahn[s] === bahn[n] ? 1 : 0)); });
      var gesperrt = function () {
        if (belegt[schluessel(bahn[n], c)] || durch[schluessel(bahn[n], c)]) return true;
        return vor.some(function (s) { return col[s] === c && zwischen(s, n, c).some(function (x) { return belegt[x]; }); });
      };
      while (gesperrt()) c++;
      col[n] = c;
      belegt[schluessel(bahn[n], c)] = true;
      vor.forEach(function (s) {
        if (col[s] === c) zwischen(s, n, c).forEach(function (x) { durch[x] = true; });
      });
    });
    return col;
  }

  /** Ein rechtwinkliger Linienzug als Pfad, Ecken mit dem Radius abgerundet. */
  function dokuPfad(pts, radius) {
    var f = function (n) { return n.toFixed(1); };
    var vz = function (v) { return v > 0 ? 1 : v < 0 ? -1 : 0; };
    var d = "M" + f(pts[0][0]) + "," + f(pts[0][1]);
    for (var i = 1; i < pts.length - 1; i++) {
      var a = pts[i - 1], b = pts[i], c = pts[i + 1];
      var r = Math.min(radius, (Math.abs(b[0] - a[0]) + Math.abs(b[1] - a[1])) / 2, (Math.abs(c[0] - b[0]) + Math.abs(c[1] - b[1])) / 2);
      d += " L" + f(b[0] - vz(b[0] - a[0]) * r) + "," + f(b[1] - vz(b[1] - a[1]) * r) + " Q" + f(b[0]) + "," + f(b[1]) + " " + f(b[0] + vz(c[0] - b[0]) * r) + "," + f(b[1] + vz(c[1] - b[1]) * r);
    }
    var l = pts[pts.length - 1];
    return d + " L" + f(l[0]) + "," + f(l[1]);
  }

  /** Titel und Detail eines Knotens als Textzeilen, mittig auf y; zu lange Zeilen werden gestaucht. */
  function dokuZeilen(k, x, y, breite, klasseT, klasseD, anker, gr) {
    var g = gr || 13;
    var teile = dokuKappe(dokuUmbruch(k.titel, 20), 2, 20).map(function (z) { return [z, g, anker === "middle" ? 700 : 600, klasseT]; })
      .concat(dokuKappe(dokuUmbruch(k.detail, 26), 1, 26).map(function (z) { return [z, g - 2, 400, klasseD]; }));
    var ty = y - teile.reduce(function (s, t) { return s + t[1] + 3; }, 0) / 2 + 1;
    return teile.map(function (t) {
      ty += t[1] + 3;
      var fit = t[0].length * t[1] * 0.56 > breite ? ' textLength="' + breite + '" lengthAdjust="spacingAndGlyphs"' : "";
      return '<text class="' + t[3] + '" x="' + x + '" y="' + (ty - 3).toFixed(1) + '" text-anchor="' + anker + '" font-size="' + t[1] + '" font-weight="' + t[2] + '"' + fit + ">" + esc(t[0]) + "</text>";
    }).join("");
  }

  /** Ein Schritt als Karte wie eine Things-Zeile: Glyph links, Titel, graues Detail; Status setzt Glyph und Rahmen. */
  function dokuKnoten(k, x, y, rolle) {
    var D_ = DOKU_GEOM, x0 = x - D_.nw / 2, y0 = y - D_.nh / 2;
    // Class names come from fixed lists, whatever the data says (logik.ts checks them too).
    var art = DOKU_ARTEN.indexOf(k.art) >= 0 ? k.art : "aktion", st = DOKU_STATI.indexOf(k.status) >= 0 ? k.status : "";
    var farbe = DOKU_FARBE[dokuRolle(art === "frage" ? "mensch" : rolle)];
    var kopf = '<g class="dk-knoten' + (st ? " " + st : "") + " dk-" + art + '" data-id="' + esc(k.id) + '" style="--c:' + farbe + '">';
    // The full text as tooltip: the wrapped lines below may cut a long title.
    kopf += "<title>" + esc(k.titel + (k.detail ? " — " + k.detail : "")) + "</title>";
    if (art === "start" || art === "ende") {
      return kopf + '<rect class="dk-kapsel" x="' + x0 + '" y="' + y0 + '" width="' + D_.nw + '" height="' + D_.nh + '" rx="' + D_.nh / 2 + '"/>' + dokuZeilen(k, x, y, D_.nw - 30, "dk-kapsel-t", "dk-kapsel-d", "middle") + "</g>";
    }
    var box = 'x="' + x0 + '" y="' + y0 + '" width="' + D_.nw + '" height="' + D_.nh + '" rx="' + D_.radius + '"';
    var glyph = art === "daten" || art === "frage" ? art : "aktion", gfarbe = farbe, hof = "";
    if (st === "fertig") { glyph = "fertig"; gfarbe = "var(--l1)"; }
    else if (st === "laeuft") glyph = "laeuft";
    else if (st === "wartet") { glyph = "frage"; gfarbe = "var(--l4)"; hof = '<rect class="dk-hof" ' + box + "/>"; }
    else if (st === "offen") gfarbe = "var(--st-offen)";
    return kopf + hof + '<rect class="dk-karte" ' + box + "/>" + dokuIcon(glyph, x0 + 18, y0 + 19, gfarbe) + dokuZeilen(k, x0 + 33, y, D_.nw - 42, "dk-t", "dk-d", "start", 13.5) + "</g>";
  }

  /** Der Ablauf als SVG-Flowchart: eine Bahn je Zeile, ein Knoten je Schritt, ein Pfad je Kante; "" ohne Schritte. */
  function ablaufSvg(ab) {
    if (!ab || !Array.isArray(ab.schritte) || !ab.schritte.length || !Array.isArray(ab.bahnen) || !ab.bahnen.length) return "";
    var kanten = (ab.kanten || []).filter(function (e) { return e.von !== e.nach; });
    ab = { titel: ab.titel, bahnen: ab.bahnen, schritte: ab.schritte, kanten: kanten };
    var D_ = DOKU_GEOM, li = {}, rolle = {}, idx = {}, knoten = {}, st = {};
    ab.bahnen.forEach(function (b, i) { li[b.id] = i; rolle[b.id] = dokuRolle(b.rolle); });
    ab.schritte.forEach(function (k, i) { idx[k.id] = i; knoten[k.id] = k; st[k.id] = k.status; });
    var fortschritt = ab.schritte.some(function (k) { return k.status; });
    var col = dokuSpalten(ab);
    var ncol = Math.max.apply(null, ab.schritte.map(function (k) { return col[k.id]; })) + 1;
    var W = D_.strip + D_.pad * 2 + ncol * D_.step, H = ab.bahnen.length * D_.lane;
    var hf = D_.nw / 2, hk = D_.nh / 2;
    var fc = function (c) { return D_.strip + D_.pad + c * D_.step + D_.step / 2; };
    var kc = function (i) { return i * D_.lane + D_.lane / 2; };
    var out = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + " " + H + '" class="dk-ablauf" style="--min:' + Math.round(W * 0.6) + 'px" role="img" aria-label="' + esc(ab.titel || "Ablauf") + '"><defs>' +
      ["n", "x"].map(function (n) {
        return '<marker id="dk-pfeil-' + n + '" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="dk-pfeil-' + n + '" d="M0,0 L10,5 L0,10 z"/></marker>';
      }).join("") + "</defs>"];
    ab.bahnen.forEach(function (b, i) {
      var y = i * D_.lane, r = rolle[b.id];
      out.push('<g class="dk-bahn' + (i % 2 ? " alt" : "") + '"><rect x="0" y="' + y + '" width="' + W + '" height="' + D_.lane + '"/>' + dokuIcon(r, 24, y + D_.lane / 2, DOKU_FARBE[r]) +
        '<text class="dk-bahnname" x="40" y="' + (y + D_.lane / 2 + 4.5) + '" font-size="13" font-weight="600">' + esc(b.name) + "</text>" +
        (i ? '<line x1="16" y1="' + y + '" x2="' + (W - 16) + '" y2="' + y + '"/>' : "") + "</g>");
    });
    var labels = [];
    ab.kanten.forEach(function (e) {
      if (!knoten[e.von] || !knoten[e.nach]) return;
      var fs = fc(col[e.von]), ks = kc(li[knoten[e.von].bahn]), ft = fc(col[e.nach]), kt = kc(li[knoten[e.nach].bahn]);
      var zurueck = idx[e.nach] < idx[e.von], pts, mid;
      if (zurueck) {
        var ko = ks + hk + 14;
        pts = [[fs, ks + hk], [fs, ko], [ft, ko], [ft, kt + hk]];
        mid = [fs - D_.step / 2, ko];
      } else if (col[e.von] === col[e.nach]) {
        var d = kt > ks ? 1 : -1;
        pts = [[fs, ks + d * hk], [ft, kt - d * hk]];
        mid = [fs, (ks + kt) / 2];
      } else if (ks === kt) {
        pts = [[fs + hf, ks], [ft - hf, kt]];
        mid = [(fs + ft) / 2, ks - hk - 11];
      } else {
        var fm = fs + D_.step / 2, dd = kt > ks ? 1 : -1;
        pts = [[fs + hf, ks], [fm, ks], [fm, kt], [ft - hf, kt]];
        mid = [fm, ks + dd * D_.lane / 2];
      }
      var blau = fortschritt ? st[e.von] === "fertig" && st[e.nach] !== "offen" : zurueck;
      out.push('<path class="dk-kante' + (blau ? " blau" : "") + (zurueck ? " zurueck" : "") + '" data-von="' + esc(e.von) + '" data-nach="' + esc(e.nach) + '" d="' + dokuPfad(pts, D_.radius) +
        '" marker-end="url(#dk-pfeil-' + (blau ? "x" : "n") + ')"/>');
      if (e.text) labels.push([mid, e.text, blau]);
    });
    ab.schritte.forEach(function (k) {
      out.push(dokuKnoten(k, fc(col[k.id]), kc(li[k.bahn]), rolle[k.bahn]));
    });
    labels.forEach(function (l) {
      var w = l[1].length * 6.4 + 16, x = l[0][0], y = l[0][1];
      out.push('<rect class="dk-pille" x="' + (x - w / 2).toFixed(1) + '" y="' + (y - 10).toFixed(1) + '" width="' + w.toFixed(1) + '" height="20" rx="10"/>' +
        '<text class="dk-pille-t' + (l[2] ? " blau" : "") + '" x="' + x.toFixed(1) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="middle" font-size="11" font-weight="600">' + esc(l[1]) + "</text>");
    });
    out.push("</svg>");
    return out.join("");
  }

  function dokuLegende(ab) {
    var s = function (inhalt) { return "<span>" + inhalt + "</span>"; };
    var linie = function (cls) { return '<svg width="26" height="14" aria-hidden="true"><path class="' + cls + '" d="M1 7H25"/></svg>'; };
    var html = ab.bahnen.map(function (b) { var r = dokuRolle(b.rolle); return s(dokuGlyph(r, DOKU_FARBE[r], 16) + esc(b.name)); }).join("");
    html += s('<svg width="26" height="14" aria-hidden="true"><rect class="dk-kapsel" width="26" height="14" rx="7"/></svg>Start / Ende') +
      s(dokuGlyph("frage", "var(--l4)", 16) + "Frage an Mensch") + s(linie("dk-leg-zurueck") + "Rücksprung");
    if (ab.schritte.some(function (k) { return k.status; })) {
      html += '<span class="dk-leg-rechts">' + dokuGlyph("fertig", "var(--l1)", 16) + "erledigt</span>" + s(dokuGlyph("laeuft", "var(--l1)", 16) + "läuft") +
        s(dokuGlyph("frage", "var(--l4)", 16) + "wartet auf Sie") + s(dokuGlyph("aktion", "var(--st-offen)", 16) + "offen") + s(linie("dk-leg-blau") + "erledigter Weg");
    }
    return '<div class="dk-legende">' + html + "</div>";
  }

  function dokuTag(text, cls) {
    return '<span class="dk-tag' + (cls ? " " + cls : "") + '">' + esc(text) + "</span>";
  }
  /** Kennung eines Doku-Punkts wie dokuId() in logik.ts: Liste und benennender Schluessel. */
  function dokuId(liste, schluessel) {
    return "doku:" + liste + ":" + schluessel;
  }
  /** Eine Zeile wie in Things: Glyph, Titel, graue Notiz, rechts das Alter (mit `id`) und ein Tag. */
  function dokuZeile(glyph, titel, notiz, rechts, id) {
    rechts = (id ? alterMarke(id) : "") + (rechts || "");
    return '<div class="dk-zeile">' + glyph + '<div class="dk-inhalt">' + titel + (notiz ? '<div class="dk-notiz">' + notiz + "</div>" : "") + "</div>" + (rechts ? '<div class="dk-rechts">' + rechts + "</div>" : "") + "</div>";
  }
  function dokuKopf(titel, zahl) {
    return "<h3>" + esc(titel) + (zahl !== undefined && zahl !== "" ? ' <span class="zaehler">' + esc(zahl) + "</span>" : "") + "</h3>";
  }

  /** Der Abschnitt Dokumentation; "" ohne doku. */
  function doku() {
    var d = D && D.plan && D.plan.doku;
    if (!d) return "";
    var ab = d.ablauf && d.ablauf.schritte && d.ablauf.schritte.length ? d.ablauf : null;
    var bausteine = (d.bausteine || []).map(function (b) {
      var r = b.rolle ? dokuRolle(b.rolle) : null;
      return dokuZeile(dokuGlyph(r || "agent", DOKU_FARBE[r || "agent"]), esc(b.name), esc(b.text || "") + (b.ort ? (b.text ? "<br>" : "") + "<code>" + esc(b.ort) + "</code>" : ""), r ? dokuTag(DOKU_ROLLE[r]) : "", dokuId("bausteine", b.name));
    }).join("");
    var befehle = (d.befehle || []).map(function (b) {
      return dokuZeile(dokuGlyph("agent", "var(--l3)"), '<code class="dk-cmd">' + esc(b.befehl) + "</code>", esc(b.text || ""), "", dokuId("befehle", b.befehl));
    }).join("");
    var regeln = (d.regeln || []).map(function (r) {
      var a = DOKU_REGEL[r.art] || DOKU_REGEL.tipp;
      return dokuZeile(dokuGlyph(a[1], a[2]), esc(r.text), "", dokuTag(a[0], r.art === "immer" ? "blau" : ""), dokuId("regeln", r.text));
    }).join("");
    var felder = function (liste, farbe, art) {
      return liste.map(function (x) { return dokuZeile(dokuGlyph("daten", farbe), '<code class="dk-cmd">' + esc(x.schluessel) + "</code>", esc(x.inhalt || ""), "", dokuId(art, x.schluessel)); }).join("");
    };
    var datei = d.datei && d.datei.felder.length ? dokuKopf(d.datei.titel || "Aufbau der Sitzungsdatei", d.datei.felder.length) + felder(d.datei.felder, "var(--l4)", "datei") : "";
    var sicht = d.ansicht;
    var ansicht = sicht && (sicht.zonen.length || sicht.druck) ? dokuKopf(sicht.titel || "Was die Seite zeigt", sicht.zonen.length) + sicht.zonen.map(function (z, i) {
      return '<div class="dk-zone"><span class="nr">' + (i + 1) + '</span><span class="dk-zname">' + esc(z.name) + "</span><span>" + esc(z.text || "") + "</span>" + alterMarke(dokuId("ansicht", z.name)) + "</div>";
    }).join("") + (sicht.druck ? '<div class="dk-zone">' + dokuGlyph("daten", "var(--l4)") + '<span class="dk-zname">Druck</span><span>' + esc(sicht.druck) + "</span></div>" : "") : "";
    var R = d.register;
    var register = R && (R.text || R.ort || R.felder.length) ? dokuKopf(R.titel || "Aufbau des Registers", R.felder.length || "") +
      (R.text ? '<p class="dk-text">' + esc(R.text) + "</p>" : "") + (R.ort ? '<p class="dk-ort"><code>' + esc(R.ort) + "</code></p>" : "") + felder(R.felder, "var(--l3)", "register") : "";
    if (!bausteine && !ab && !befehle && !regeln && !datei && !ansicht && !register) return "";
    // Two columns as in the template: building blocks, file and rules left; page, commands and register right.
    var links = (bausteine ? dokuKopf("Bausteine", d.bausteine.length) + bausteine : "") + datei + (regeln ? dokuKopf("Regeln", d.regeln.length) + regeln : "");
    var rechts = ansicht + (befehle ? dokuKopf("Befehle", d.befehle.length) + befehle : "") + register;
    return '<section class="lp-doku" data-testid="sitzung-doku">' + teilKopf(2, "Dokumentation", [d.stand ? "Stand " + d.stand : "", d.version || ""].filter(Boolean).join(" · ")) +
      (ab ? dokuKopf("Ablauf", ab.schritte.length + " Schritte · " + ab.bahnen.length + " Bahnen") + (ab.titel ? '<p class="dk-ablauf-titel">' + esc(ab.titel) + "</p>" : "") +
        '<div class="dk-diagramm">' + ablaufSvg(ab) + "</div>" + dokuLegende(ab) : "") +
      (links || rechts ? '<div class="dk-spalten"><div>' + links + "</div><div>" + rechts + "</div></div>" : "") + "</section>";
  }

  /** Der Fuss: Quelle und Stand aus doku, rechts die Sitzungsdatei. */
  function fuss() {
    var d = (D.plan && D.plan.doku) || {};
    var links = [d.quelle ? "Quelle " + d.quelle : "", d.stand ? "Stand " + d.stand : ""].filter(Boolean).join(" · ");
    return '<footer class="lp-fuss" data-testid="sitzung-fuss"><span>' + esc(links) + '</span><span class="mono">' + esc(".live-plan/" + D.slug + ".yaml") + "</span></footer>";
  }

  // --- Handout-Modus: wie die Seite, aber ohne Sitzungsdetails: Kopf, Ueberblick, Anforderungen, Entscheidungen, Dokumentation
  function kopfHandout() {
    var p = D.plan;
    return '<header class="lp-kopf"><div class="lp-oben">' + torte(anteilFertig(p)) + '<h1 data-testid="sitzung-titel">' + esc(p.titel || D.slug) + "</h1></div>" + kopfText(p, true) + "</header>";
  }
  /** Anforderungen und Entscheidungen ungekuerzt, ohne Knoepfe. */
  function listenHandout() {
    var u = ue(), an = u.anforderungen, en = u.entscheidungen;
    var alle = function (t) { return { sichtbar: t.sichtbar.concat(t.aelter), aelter: [] }; };
    if (!an.sichtbar.length && !an.aelter.length && !en.sichtbar.length && !en.aelter.length) return "";
    return '<div class="lp-ueberblick lp-handout-listen" data-testid="sitzung-ueberblick">' +
      abschnitt("anforderungen", "Anforderungen", an.erfuellt + "/" + an.gesamt + " erfüllt", alle(an), anforderungsEintrag) +
      abschnitt("entscheidungen", "Entscheidungen", en.sichtbar.length + en.aelter.length, alle(en), entscheidungsEintrag) + "</div>";
  }
  function handoutSeite() {
    var listen = listenHandout();
    return '<div class="lp-inhalt lp-handout">' + kopfHandout() + ueberblickKarten() + (listen ? teilEins(true) + listen : "") + doku() + fuss() + "</div>";
  }
  /**
   * Der Inhalt der Seite einer Sitzung, samt Modal; im Handout-Modus das Handout. Reihenfolge der Vorlage:
   * Kopf, Ueberblick, Teil 1 (Verbrauch, Fortschritt, Kacheln, Jetzt, dann zwei Spalten), Teil 2, Dateien, Fuss.
   */
  function seite(modalHtml) {
    if (handout) return handoutSeite();
    return '<div class="lp-inhalt"' + (modalHtml ? " inert" : "") + ">" + kopf() + fehler() + ueberblickKarten() + teilEins() +
      verbrauchTeil() + agentenAbschnitt() + fortschrittTeil() + blick() + jetzt(true) +
      '<div class="lp-teil1">' + fragenAnSie() + ueberblick() + "</div>" + firstmateTeil() + doku() + dateien() + fuss() +
      '<aside id="lp-drawer" class="lp-drawer' + (sel ? " open" : "") + '" data-testid="sitzung-drawer">' + (sel ? drawerInhalt(sel) : "") + "</aside></div>" +
      (modalHtml || "");
  }

  G.LivePlanAnsicht = {
    ablaufSvg: ablaufSvg,
    doku: doku,
    seite: seite,
    ueberblickKarten: ueberblickKarten,
    fortschrittTeil: fortschrittTeil,
    agentenAbschnitt: agentenAbschnitt,
    fragenAnSie: fragenAnSie,
    fuss: fuss,
    istHandout: function () { return handout; },
    live: live,
    kopfNurLive: kopfNurLive,
    dateien: dateien,
    baumInhalt: baumInhalt,
    diffZeilen: diffZeilen,
    diffModal: diffModal,
    firstmateTeil: firstmateTeil,
    fmModal: fmModal,
    setzeFirstmate: function (f) { FM = f && typeof f === "object" ? f : null; },
    setzeBaum: function (b) { BAUM = b && typeof b === "object" && Array.isArray(b.dateien) ? b : null; },
    setzeBaumModus: setzeBaumModus,
    setzeBaumFilter: function (t) { baumFilter = String(t || ""); },
    setzeOrdner: setzeOrdner,
    setzeGruppe: setzeGruppe,
    baumWarte: baumWarte,
    setzeFertigOffen: setzeFertigOffen,
    blick: blick,
    verbrauch: function () { return D && D.live && typeof D.live === "object" ? verbrauch(D.live) : ""; },
    kontoKurz: kontoKurz,
    setzeAbo: function (a) { ABO = a && typeof a === "object" ? a : null; },
    resetText: resetText,
    tokens: tokens,
    kosten: kosten,
    modellName: modellName,
    setze: function (d) { D = d; },
    setzeJetzt: function (ms) { jetztFest = ms; },
    verstrichen: verstrichen,
    alterKurz: alterKurz,
    ortszeit: ortszeit,
    daten: function () { return D; },
    schritt: function (id) { return schritt(id); },
    kopf: kopf,
    jetzt: jetzt,
    thema: thema,
    themaSchalter: themaSchalter,
    setzeThema: setzeThema,
    drawerInhalt: drawerInhalt,
    ueberblick: ueberblick,
    umschalteMehr: umschalteMehr,
    beweisModal: beweisModal,
  };

  if (!wurzel) return;

  // --- Aufbau -------------------------------------------------------------------------------
  /**
   * Zeichnet die Sitzung neu. Ein Modal, dessen Bild nach einer Dateiaenderung wegfaellt, geht mit
   * zu (S29, M2), sonst schluckte es jeden Klick. Solange es offen ist, ist der Rest `inert` (S3).
   */
  function zeichne() {
    var dz = dateiZustand();
    var ez = eigenZustand();
    zeichneSeite();
    stelleDateienHer(dz);
    stelleEigenHer(ez);
  }
  /** Fokus und Auswahl im Feld einer eigenen Antwort; den Text traegt eigenText. */
  function eigenZustand() {
    var a = doc.activeElement;
    var form = a && a.matches && a.matches("form.eigen input") && a.closest("form.eigen");
    return form ? { id: form.dataset.eigen, von: a.selectionStart, bis: a.selectionEnd } : null;
  }
  function stelleEigenHer(z) {
    if (!z) return;
    var feld = wurzel.querySelector('form.eigen[data-eigen="' + (G.CSS && G.CSS.escape ? G.CSS.escape(z.id) : z.id) + '"] input');
    if (!feld) return;
    feld.focus();
    try { feld.setSelectionRange(z.von, z.bis); } catch (e) { /* no selection API */ }
  }
  /** Fokus und Auswahl im Filterfeld und die Scrollposition des Baums, damit ein Neuzeichnen beim Tippen nichts verliert. */
  function dateiZustand() {
    var feld = wurzel.querySelector("[data-bd-filter]"), baum = wurzel.querySelector("[data-bd-baum]");
    var fokus = !!feld && doc.activeElement === feld;
    return { fokus: fokus, von: fokus ? feld.selectionStart : 0, bis: fokus ? feld.selectionEnd : 0, scroll: baum ? baum.scrollTop : 0 };
  }
  function stelleDateienHer(z) {
    var feld = wurzel.querySelector("[data-bd-filter]"), baum = wurzel.querySelector("[data-bd-baum]");
    if (baum) baum.scrollTop = z.scroll;
    if (feld && z.fokus) {
      feld.focus();
      try { feld.setSelectionRange(z.von, z.bis); } catch (e) { /* type=search without selection API */ }
    }
  }
  /** Nur der Baum und seine Kopfzahlen neu; fehlt der Abschnitt oder faellt er weg, die ganze Seite. */
  function zeichneDateien() {
    var abschnitt = wurzel.querySelector(".lp-dateien");
    var html = dateien();
    if (!abschnitt || !html) { if (abschnitt || html) zeichne(); return; }
    var baum = abschnitt.querySelector("[data-bd-baum]"), info = abschnitt.querySelector("[data-bd-info]");
    var scroll = baum ? baum.scrollTop : 0;
    if (info) info.innerHTML = baumInfo();
    if (baum) { baum.innerHTML = baumInhalt(); baum.scrollTop = scroll; }
  }
  function zeichneSeite() {
    // The open modal keeps its scroll position and focus across a redraw (every SSE event and Firstmate poll redraws).
    var stand = modalStand();
    if (!D.plan) {
      // Nur im Register (S5): Kopf, Live-Block und Dateien, sonst nichts.
      doc.title = ((D.live && D.live.fortschritt && D.live.fortschritt.titel) || D.slug) + " · live-plan";
      var nurModal = diffModal(diffAuf) || fmModal(fmAuf);
      if (!nurModal) fmAuf = null;
      wurzel.innerHTML = '<div class="lp-inhalt"' + (nurModal ? " inert" : "") + ">" + kopfNurLive() + live() + firstmateTeil() + dateien() + "</div>" + nurModal;
      nachModal(stand);
      return;
    }
    var drawer = doc.getElementById("lp-drawer");
    var scroll = drawer ? drawer.scrollTop : 0;
    var modalHtml = modal ? beweisModal(modal) : "";
    if (!modalHtml) modal = null;
    if (!modalHtml) modalHtml = diffModal(diffAuf);
    if (!modalHtml) modalHtml = fmModal(fmAuf);
    if (!modalHtml) fmAuf = null;
    doc.title = (D.plan.titel || D.slug) + " · live-plan";
    wurzel.innerHTML = seite(modalHtml);
    var d = doc.getElementById("lp-drawer");
    if (d) d.scrollTop = scroll;
    nachModal(stand);
  }

  /** Scrollposition und Fokus des offenen Modals vor dem Neuzeichnen. */
  function modalStand() {
    var rolle = wurzel.querySelector(".lp-modal .lp-diff-text, .lp-modal .fm-details");
    return { scroll: rolle ? [rolle.scrollTop, rolle.scrollLeft] : null, fokus: modalZiele().indexOf(doc.activeElement) >= 0 ? modalSchluessel(doc.activeElement) : null };
  }
  /** Woran ein Ziel im Modal nach dem Neuzeichnen wiedererkannt wird: Art, Befehl, Link und Klasse, nicht die Stelle. */
  function modalSchluessel(el) {
    return [el.tagName, el.getAttribute("data-kopiere"), el.getAttribute("href"), el.getAttribute("class")].join("\n");
  }
  /** Das neue innerHTML nimmt dem Modal den Fokus (er fiele auf BODY); er geht zurueck, wo er war, sonst auf Schliessen. Die Scrollposition bleibt. */
  function nachModal(stand) {
    if (!(modal || diffAuf || fmAuf)) return;
    var ziel = (stand.fokus !== null && modalZiele().find(function (el) { return modalSchluessel(el) === stand.fokus; })) || wurzel.querySelector(".lp-modal button[data-modal-zu]");
    if (ziel) ziel.focus();
    var rolle = stand.scroll && wurzel.querySelector(".lp-modal .lp-diff-text, .lp-modal .fm-details");
    if (rolle) { rolle.scrollTop = stand.scroll[0]; rolle.scrollLeft = stand.scroll[1]; }
  }

  /**
   * Den Diff einer Datei aus dem Baum oeffnen: erst `laedt`, dann Daten oder Fehler; eine spaetere Wahl
   * gewinnt. Mit `branch` (E3, nur committet) kommt der Diff aus diesem but-Branch.
   */
  function oeffneDiff(p, branch) {
    var gruppe = branch && gruppenAusBut().find(function (g) { return g.schluessel === "b:" + branch; });
    var e = (gruppe ? gruppe.eintraege : dateiListe()).find(function (x) { return x.p === p; });
    var auf = diffAuf = { p: p, s: e && e.s, branch: branch || null };
    zeichne();
    var fertig = function (teil) {
      if (diffAuf !== auf) return;
      diffAuf = { p: p, s: auf.s, branch: auf.branch, daten: teil.daten, fehler: teil.fehler };
      auf = diffAuf;
      zeichne();
    };
    fetch(API + "/diff?p=" + encodeURIComponent(p) + (branch ? "&branch=" + encodeURIComponent(branch) : ""), { cache: "no-store" }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (b) {
        if (!r.ok) throw new Error((b && b.fehler) || "HTTP " + r.status);
        return b;
      });
    }).then(function (b) { fertig({ daten: b }); }, function (err) { fertig({ fehler: err.message }); });
  }
  /** Schliessen per Esc, Hintergrund oder Knopf; der Fokus kehrt zur Zeile im Baum zurueck. */
  function schliesseDiff() {
    var p = diffAuf && diffAuf.p;
    diffAuf = null;
    zeichne();
    var zeile = p && wurzel.querySelector('.bd-datei[data-pfad="' + (G.CSS && G.CSS.escape ? G.CSS.escape(p) : p) + '"]');
    if (zeile) zeile.focus();
  }

  /** Die Details eines Workers oeffnen; Schliessen gibt den Fokus an seine Karte zurueck. */
  function oeffneFm(id) {
    if (!fmWorker(id)) return;
    fmAuf = id;
    zeichne();
  }
  function schliesseFm() {
    var id = fmAuf;
    fmAuf = null;
    zeichne();
    var karte = id && wurzel.querySelector('.fm-karte[data-fm-worker="' + (G.CSS && G.CSS.escape ? G.CSS.escape(id) : id) + '"]');
    if (karte) karte.focus();
  }

  /** Das Modal des Beweisbilds oeffnen; den Fokus auf Schliessen setzt zeichne(). */
  function oeffneModal(id) {
    modal = id;
    zeichne();
  }
  /** Schliessen per Esc, Hintergrund oder Knopf; der Fokus kehrt zum Icon zurueck. */
  function schliesseModal() {
    var id = modal;
    modal = null;
    zeichne();
    var icon = id && wurzel.querySelector('[data-beweis="' + (G.CSS && G.CSS.escape ? G.CSS.escape(id) : id) + '"]');
    if (icon) icon.focus();
  }

  function waehle(id) {
    sel = id;
    zeichne();
  }

  function zeigeFrage(id) {
    var el = wurzel.querySelector('.lp-frage[data-frage="' + (G.CSS && G.CSS.escape ? G.CSS.escape(id) : id) + '"]');
    if (el) el.scrollIntoView({ behavior: medien("(prefers-reduced-motion: reduce)") ? "auto" : "smooth", block: "center" });
  }

  /** Kopiert den Befehl; der Ursprungstext liegt einmal in data-ursprung, damit ein Doppelklick ihn nicht als "kopiert" merkt. */
  function kopiere(knopf) {
    if (knopf.dataset.ursprung === undefined) knopf.dataset.ursprung = knopf.textContent;
    var vorher = knopf.dataset.ursprung;
    zwischenablage(knopf.dataset.kopiere, knopf,
      function () { knopf.textContent = "kopiert"; setTimeout(function () { knopf.textContent = vorher; }, 1500); },
      function () { knopf.textContent = "markiert"; });
  }
  function zwischenablage(text, knopf, fertig, fehlt) {
    // Ohne Zwischenablage-API (http im LAN): ueber ein verstecktes Textfeld, denn in Offen steht kein Code daneben (M1).
    var auswahl = function () {
      var feld = doc.createElement("textarea");
      feld.value = text;
      feld.setAttribute("readonly", "");
      feld.style.position = "fixed";
      feld.style.opacity = "0";
      doc.body.appendChild(feld);
      feld.select();
      try {
        if (doc.execCommand("copy")) fertig();
        else fehlt();
      } catch (e) {
        fehlt();
      }
      feld.remove();
      knopf.focus();
    };
    if (G.navigator && G.navigator.clipboard && G.isSecureContext) G.navigator.clipboard.writeText(text).then(fertig, auswahl);
    else auswahl();
  }

  wurzel.addEventListener("click", function (e) {
    var th = e.target.closest(".lp-thema button[data-thema]");
    if (th) { setzeThema(th.dataset.thema); return; }
    if (!D) return;
    var opt = e.target.closest(".lp-frage .opt button[data-frage]");
    if (opt) {
      opt.disabled = true;
      fetch(API + "/entscheidung", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ frage: opt.dataset.frage, wahl: opt.dataset.wahl }) })
        .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return laden(); })
        .catch(function (err) { opt.disabled = false; opt.title = "Fehler: " + err.message; });
      return;
    }
    if (modal || diffAuf || fmAuf) {
      if (e.target.matches("[data-modal-zu]") || e.target.closest("button[data-modal-zu]")) { if (modal) schliesseModal(); else if (diffAuf) schliesseDiff(); else schliesseFm(); return; }
      var mk = (diffAuf || fmAuf) && e.target.closest("[data-kopiere]");
      if (mk) kopiere(mk);
      return;
    }
    var bw = e.target.closest("[data-beweis]");
    if (bw) { oeffneModal(bw.dataset.beweis); return; }
    if (e.target.closest(".lp-firstmate a[href]")) return;
    var fw = e.target.closest("[data-fm-worker]");
    if (fw) { oeffneFm(fw.dataset.fmWorker); return; }
    var mehr = e.target.closest("[data-mehr]");
    if (mehr) { umschalteMehr(mehr.dataset.mehr); return; }
    var lf = e.target.closest("[data-live-fertig]");
    if (lf) { setzeFertigOffen(lf.getAttribute("aria-expanded") !== "true"); return; }
    var bm = e.target.closest("[data-bd-modus]");
    if (bm) { setzeBaumModus(bm.dataset.bdModus); return; }
    var bg = e.target.closest("[data-bd-gruppe]");
    if (bg) { setzeGruppe(bg.dataset.bdGruppe, bg.getAttribute("aria-expanded") !== "true"); return; }
    var bo = e.target.closest("[data-ordner]");
    if (bo) { setzeOrdner(bo.dataset.ordner, bo.getAttribute("aria-expanded") !== "true"); return; }
    var bp = e.target.closest("[data-pfad]");
    if (bp) { oeffneDiff(bp.dataset.pfad, bp.dataset.branch); return; }
    if (e.target.closest("[data-ziel]")) { zielAuf = !zielAuf; zeichne(); return; }
    var kp = e.target.closest("[data-kopiere]");
    if (kp) { kopiere(kp); return; }
    if (e.target.closest("[data-schliessen]")) { sel = null; zeichne(); return; }
    var kn = e.target.closest("[data-id]");
    if (!kn) return;
    var id = kn.dataset.id;
    if (schritt(id)) waehle(id);
    else if (frage(id)) { if (sel) { sel = null; zeichne(); } zeigeFrage(id); }
  });

  wurzel.addEventListener("input", function (e) {
    if (!e.target.matches) return;
    if (e.target.matches("form.eigen input")) {
      var form = e.target.closest("form.eigen");
      eigenText[form.dataset.eigen] = e.target.value;
      var knopf = form.querySelector("button");
      if (knopf) knopf.disabled = !e.target.value.trim();
      return;
    }
    if (!e.target.matches("[data-bd-filter]")) return;
    baumFilter = e.target.value;
    zeichneDateien();
  });

  // Eigene Antwort: Enter im Feld oder Senden; der Server prueft Laenge und Zeichen (422 mit Grund).
  wurzel.addEventListener("submit", function (e) {
    var form = e.target.closest && e.target.closest("form.eigen");
    if (!form) return;
    e.preventDefault();
    var id = form.dataset.eigen;
    var feld = form.querySelector("input");
    var knopf = form.querySelector("button");
    var text = feld ? feld.value.trim() : "";
    if (!text || !D) return;
    if (knopf) knopf.disabled = true;
    delete eigenFehler[id];
    fetch(API + "/entscheidung", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ frage: id, wahl: text, eigen: true }) })
      .then(function (r) {
        if (r.ok) return null;
        return r.json().catch(function () { return {}; }).then(function (b) { throw new Error((b && b.fehler) || "HTTP " + r.status); });
      })
      .then(function () { delete eigenText[id]; return laden(); })
      .catch(function (err) { eigenFehler[id] = "Fehler: " + err.message; zeichne(); });
  });

  /** Was im Modal den Fokus nehmen kann, in Dokumentreihenfolge. */
  function modalZiele() {
    return Array.prototype.slice.call(wurzel.querySelectorAll(".lp-modal button, .lp-modal [href], .lp-modal [tabindex]:not([tabindex=\"-1\"])"));
  }

  doc.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if (modal) { schliesseModal(); return; }
      if (diffAuf) { schliesseDiff(); return; }
      if (fmAuf) { schliesseFm(); return; }
      if (sel) { sel = null; zeichne(); }
      return;
    }
    // Eine Worker-Karte oeffnet ihre Details auch mit Enter und Leertaste.
    var karte = (e.key === "Enter" || e.key === " ") && !modal && !diffAuf && !fmAuf && e.target.closest && !e.target.closest("a[href]") && e.target.closest("[data-fm-worker]");
    if (karte) { e.preventDefault(); oeffneFm(karte.dataset.fmWorker); return; }
    // Fokusfalle (S29, S3): Tab und Shift-Tab bleiben im Modal.
    if ((modal || diffAuf || fmAuf) && e.key === "Tab") {
      var ziele = modalZiele();
      e.preventDefault();
      if (!ziele.length) return;
      var i = ziele.indexOf(doc.activeElement);
      var n = e.shiftKey ? (i <= 0 ? ziele.length - 1 : i - 1) : (i < 0 || i >= ziele.length - 1 ? 0 : i + 1);
      ziele[n].focus();
      return;
    }
  });

  function laden() {
    return fetch(API, { cache: "no-store" }).then(function (r) {
      if (r.status === 404) { nichtGefunden(); return null; }
      return r.json();
    }).then(function (daten) {
      if (daten && (daten.plan || daten.live)) {
        D = daten;
        zeichne();
        // The handout command waits for this mark before it takes the picture.
        if (handout) doc.documentElement.dataset.fertig = "1";
      }
    }).catch(function () { /* die naechste Aenderung versucht es wieder */ });
  }

  // Der Baum kommt aus GET .../baum; 404 (Endpunkt fehlt) oder eine kaputte Antwort lassen den
  // Abschnitt still weg. Neu geladen bei jedem Ereignis, hoechstens alle BAUM_TAKT_MS.
  var baumZuletzt = 0, baumUhr = null;
  function ladeBaum() {
    baumZuletzt = Date.now();
    return fetch(API + "/baum", { cache: "no-store" }).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (b) {
      var neu = b && typeof b === "object" && Array.isArray(b.dateien) ? b : null;
      if (!neu && !BAUM) return;
      BAUM = neu;
      if (D) zeichneDateien();
    }).catch(function () { /* das naechste Ereignis versucht es wieder */ });
  }
  function baumBald() {
    if (baumUhr) return;
    baumUhr = setTimeout(function () { baumUhr = null; ladeBaum(); }, baumWarte(baumZuletzt, Date.now()));
  }

  // Die Abo-Daten aus GET /api/abo: beim Laden und dann alle ABO_TAKT_MS, nicht bei jedem Ereignis.
  // Ohne Daten oder bei einem Fehler fehlen Reserve und Zeile 5h; der Verbrauch steht nur im Live-Block.
  var ABO_TAKT_MS = 60000;
  function ladeAbo() {
    return fetch("/api/abo", { cache: "no-store" }).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (b) {
      var neu = b && typeof b === "object" && b.abo && typeof b.abo === "object" ? b.abo : null;
      if (!neu && !ABO) return;
      ABO = neu;
      if (D && D.live && typeof D.live === "object") zeichneAbo();
    }).catch(function () { /* der naechste Takt versucht es wieder */ });
  }
  /** Nur den Verbrauch neu; fehlt er, die ganze Seite. */
  function zeichneAbo() {
    var el = wurzel.querySelector('[data-testid="sitzung-verbrauch"]');
    var html = verbrauch(D.live);
    if (el && html) el.outerHTML = html;
    else if (el || html) zeichne();
  }

  // Firstmate aus GET .../firstmate: beim Laden und dann alle FM_TAKT_MS. Ist die Wurzel kein Home
  // (home: null) oder fehlt der Endpunkt, faellt der Abschnitt still weg und es wird nicht mehr gefragt.
  var FM_TAKT_MS = 15000, fmUhr = null;
  function ladeFirstmate() {
    return fetch(API + "/firstmate", { cache: "no-store" }).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (b) {
      var neu = b && typeof b === "object" && b.home ? b : null;
      if (!neu && fmUhr) { clearInterval(fmUhr); fmUhr = null; }
      if (!neu && !FM) return;
      FM = neu;
      if (D) zeichneFirstmate();
    }).catch(function () { /* der naechste Takt versucht es wieder */ });
  }
  /** Nur den Abschnitt neu; mit offenem Modal oder wenn er erscheint oder wegfaellt, die ganze Seite. */
  function zeichneFirstmate() {
    var el = wurzel.querySelector('[data-testid="sitzung-firstmate"]');
    var html = firstmateTeil();
    var fokus = doc.activeElement && doc.activeElement.closest && el && el.contains(doc.activeElement) ? doc.activeElement.closest("[data-fm-worker]") : null;
    if (el && html && !modal && !diffAuf && !fmAuf) el.outerHTML = html;
    else if (el || html) zeichne();
    var wieder = fokus && wurzel.querySelector('.fm-karte[data-fm-worker="' + (G.CSS && G.CSS.escape ? G.CSS.escape(fokus.dataset.fmWorker) : fokus.dataset.fmWorker) + '"]');
    if (wieder) wieder.focus();
  }

  function nichtGefunden() {
    doc.title = "nicht gefunden · live-plan";
    wurzel.innerHTML = '<header class="lp-kopf"><div class="lp-oben"><a class="lp-zurueck" href="/">alle Sitzungen</a>' + themaSchalter() + "</div><h1>Sitzung nicht gefunden</h1>" +
      '<p class="lp-ziel mono">' + esc((REPO || "") + "/.live-plan/" + (SLUG || "") + ".yaml") + "</p></header>";
  }

  // --- Liste aller Sitzungen ------------------------------------------------------------------
  function liste() {
    return fetch("/api/liste", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (daten) {
      var zeilen = daten.sitzungen.map(function (e) {
        var href = "/" + encodeURIComponent(e.repo) + "/" + encodeURIComponent(e.slug);
        // S5: eine Sitzung aus dem Register traegt die Marke live (beendet grau), der volle Repo-Pfad steht im title.
        var marke = e.live ? ' <span class="lv-marke' + (e.beendet ? " aus" : "") + '">' + (e.beendet ? "beendet" : "live") + "</span>" : "";
        return '<tr><td title="' + esc(e.pfad || "") + '"><b>' + esc(e.repo) + '</b></td><td class="mono"><a href="' + esc(href) + '">' + esc(e.slug) + "</a>" + marke + "</td><td>" + esc(e.titel) +
          '</td><td class="mono klein">' + zeitAngabe(e.geaendert) + "</td></tr>";
      }).join("");
      doc.title = "Sitzungen · live-plan";
      wurzel.innerHTML = '<header class="lp-kopf"><div class="lp-oben"><h1>Sitzungen</h1>' + themaSchalter() + "</div>" +
        '<p class="lp-ziel">Lebende Dokumente aus <span class="mono">REPO/.live-plan/SLUG.yaml</span> unter <span class="mono">' + esc(daten.wurzel) + "</span> und laufende Claude-Sitzungen aus dem Register</p></header>" +
        '<table class="lp-liste" data-testid="tabelle-sitzungen"><thead><tr><th>repo</th><th>sitzung</th><th>titel</th><th>geaendert</th></tr></thead><tbody>' +
        (zeilen || '<tr><td colspan="4" class="leer">Keine Sitzung. <span class="mono">live-plan neu SLUG</span> legt eine an.</td></tr>') + "</tbody></table>";
    }).catch(function () { /* der naechste Takt versucht es wieder */ });
  }

  function lausche() {
    if (!G.EventSource) return;
    var quelle = new EventSource(API + "/ereignisse");
    quelle.addEventListener("geaendert", function () { laden(); baumBald(); });
    quelle.onerror = function () {
      quelle.close();
      setTimeout(lausche, 3000);
    };
  }

  /** Alle 30 Sekunden jede Zeitangabe mit data-um neu schreiben, ohne neu zu zeichnen (A21). */
  function takt() {
    Array.prototype.forEach.call(wurzel.querySelectorAll("[data-um]"), function (el) {
      el.textContent = "kurz" in el.dataset ? alterKurz(el.dataset.um) : verstrichen(el.dataset.um);
    });
    // A plan waiting longer than RUHE_MS turns into "ruht seit" without a redraw.
    Array.prototype.forEach.call(wurzel.querySelectorAll("[data-ruht-ab]"), function (el) {
      if (jetztMs() < Number(el.dataset.ruhtAb)) return;
      var wort = el.querySelector(".wort");
      if (wort) wort.textContent = "ruht seit";
      var f = el.closest(".lv-fortschritt, .lp-fbalken");
      if (f) f.classList.add("ruht");
    });
  }
  setInterval(takt, 30000);

  if (!API) {
    liste();
    setInterval(liste, 15000);
    return;
  }
  laden();
  if (handout) return;
  ladeBaum();
  lausche();
  ladeAbo();
  setInterval(ladeAbo, ABO_TAKT_MS);
  fmUhr = setInterval(ladeFirstmate, FM_TAKT_MS);
  ladeFirstmate();
})();
