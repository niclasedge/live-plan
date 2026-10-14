// live-plan (#257): die Ansicht, ohne Bibliothek. "/" zeigt die Liste aus /api/liste, je Sitzung mit ihrer neuesten
// Ansage (GET /api/ansagen, neue per SSE /api/ereignisse, vorgelesen mit speechSynthesis; Vorlesen und Stimme im
// Menue, GET und POST /api/einstellungen), "/REPO/SLUG" eine Sitzung aus /api/REPO/SLUG mit oben der Leiste Ansagen
// (die letzten fuenf aller Sitzungen), neu gelesen bei jeder
// Dateiaenderung (SSE /ereignisse). Ein Klick auf eine Option schickt POST .../entscheidung, ebenso eine eigene
// Antwort (Freitext, mit eigen: true); alles andere aendert nur der Agent.
//
// Aufbau nach der Vorlage im Things-Stil: Kopf mit Icon, Kurztext und Tags, Ueberblick in drei Karten,
// Teil 1 Sitzung und Fortschritt (Verbrauch, Fortschritt mit Phasen, vier Kacheln aus Issue 320, genau eine
// Jetzt-Zeile, dann in zwei Spalten Agenten, Fragen an Sie, Offen, Anforderungen, Entscheidungen; die
// Abschnitte aus ueberblick in logik.ts), in einem Firstmate-Home der Abschnitt Firstmate (Flotte als Linie je Repo,
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
  // --- Rechner (GET /api/host): die Last des Servers, knapp ueber dem Verbrauch ------------------------
  var HOST = null, HOST_TAKT_MS = 10000, hostAuf = false;
  function mb(x) {
    var n = zahl(x);
    return n >= 1024 ? (n / 1024).toFixed(1) + " GB" : Math.round(n) + " MB";
  }
  function hostProzent(x) {
    return Math.round(zahl(x)) + "%";
  }
  /** "7.6 / 15.7 GB" bei zwei GB-Werten, sonst jeder Wert mit eigener Einheit ("21 MB / 3.9 GB"). */
  function mbPaar(a, b) {
    if (zahl(a) < 1024 || zahl(b) < 1024) return mb(a) + " / " + mb(b);
    var g = function (x) { return (zahl(x) / 1024).toFixed(1).replace(/\.0$/, ""); };
    return g(a) + " / " + g(b) + " GB";
  }
  /** Eine Reihe des Rechners: Name, Balken (gelb ab 60 %, rot ab 80 %), Wert. */
  function hostBalken(name, prozent, wert, tip) {
    var p = Math.max(0, Math.min(100, zahl(prozent)));
    var farbe = p >= 80 ? "rot" : p >= 60 ? "gelb" : "";
    return '<div class="hw-reihe' + (farbe ? " " + farbe : "") + '" title="' + esc(tip) + '"><span class="k">' + esc(name) + "</span>" + balken(p / 100, false, "", farbe) + '<span class="w">' + esc(wert) + "</span></div>";
  }
  function hostProzesse(titel, liste) {
    var zeilen = (Array.isArray(liste) ? liste : []).map(function (p) {
      return "<tr><td>" + hostProzent(p.cpu) + "</td><td>" + mb(p.rssMb) + "</td><td>" + (zahl(p.swapMb) >= 1 ? mb(p.swapMb) : "–") + "</td><td>" + zahl(p.pid) + "</td><td>" + esc(p.laufzeit) +
        '</td><td class="cwd">' + esc(p.cwd) + '</td><td class="befehl" title="' + esc(p.befehl) + '">' + esc(p.befehl) + "</td></tr>";
    }).join("");
    return '<table class="hw-prozesse"><caption>' + esc(titel) + "</caption><thead><tr><th>CPU</th><th>RAM</th><th>Swap</th><th>PID</th><th>Zeit</th><th>cwd</th><th>Befehl</th></tr></thead><tbody>" + zeilen + "</tbody></table>";
  }
  var VERLAUF_BUCKETS = 60, VERLAUF_BUCKET_S = 60;
  /**
   * Die Proben (vor = Sekunden vor der Antwort) in Minuten-Eimer, je Eimer das Maximum, damit kurze Spitzen
   * sichtbar bleiben. Rueckgabe: aelteste zuerst, hoechstens 60, nur ab dem aeltesten Eimer mit Daten
   * (weniger Verlauf heisst: weniger Balken, rechts bündig); Luecken sind null.
   */
  function verlaufEimer(vor, werte) {
    if (!Array.isArray(vor) || !Array.isArray(werte)) return [];
    var eimer = [], aelteste = -1, n = Math.min(vor.length, werte.length);
    for (var i = 0; i < n; i++) {
      var k = Math.floor(zahl(vor[i]) / VERLAUF_BUCKET_S);
      if (k < 0 || k >= VERLAUF_BUCKETS || !isFinite(Number(werte[i]))) continue;
      var w = Math.max(0, Math.min(100, Number(werte[i])));
      if (eimer[k] === undefined || w > eimer[k]) eimer[k] = w;
      if (k > aelteste) aelteste = k;
    }
    var aus = [];
    for (var j = aelteste; j >= 0; j--) aus.push(eimer[j] === undefined ? null : eimer[j]);
    return aus;
  }
  function uhrzeit(ms) {
    var d = new Date(ms);
    return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
  }
  /** Eine Verlaufszeile: Name, Balkenreihe der letzten 60 Minuten (gelb ab 60 %, rot ab 80 %), aktueller Wert. */
  function verlaufZeile(name, eimer, jetzt, aktuell) {
    var balkenHtml = eimer.map(function (w, i) {
      var k = eimer.length - 1 - i;
      if (w === null) return '<i class="leer"></i>';
      var farbe = w >= 80 ? "rot" : w >= 60 ? "gelb" : "";
      var bis = zahl(jetzt) - k * VERLAUF_BUCKET_S * 1000;
      var tip = uhrzeit(bis - VERLAUF_BUCKET_S * 1000) + "–" + uhrzeit(bis) + " · max " + Math.round(w) + " %";
      return '<i' + (farbe ? ' class="' + farbe + '"' : "") + ' style="height:' + Math.max(w, 2).toFixed(1) + '%" title="' + esc(tip) + '"></i>';
    }).join("");
    var p = Math.max(0, Math.min(100, zahl(aktuell)));
    var f = p >= 80 ? "rot" : p >= 60 ? "gelb" : "";
    return '<div class="hw-reihe hw-verlauf' + (f ? " " + f : "") + '"><span class="k">' + esc(name) + '</span><span class="hw-spur" data-testid="host-verlauf-' + esc(name.toLowerCase()) + '">' + balkenHtml +
      '</span><span class="w">' + hostProzent(p) + "</span></div>";
  }
  /** Die zwei Verlaufszeilen (CPU, RAM) aus H.verlauf; ohne Proben leer, dann bleibt der Block wie zuvor. */
  function verlaufTeil(H, ram) {
    var V = H.verlauf;
    if (!V || typeof V !== "object") return "";
    var c = verlaufEimer(V.vor, V.cpu), r = verlaufEimer(V.vor, V.ram);
    if (!c.length && !r.length) return "";
    return '<div class="hw-balken hw-verlaeufe" data-testid="host-verlauf">' + verlaufZeile("CPU", c, H.um, H.cpu) + verlaufZeile("RAM", r, H.um, ram) + "</div>";
  }
  /** Der Block Rechner; ohne verfuegbare Daten leer, dann gibt es auch keinen Takt. */
  function hostTeil(auf) {
    var H = HOST;
    if (!H || H.verfuegbar !== true || !H.speicher) return "";
    var sp = H.speicher, last = Array.isArray(H.last) ? H.last : [0, 0, 0];
    var tipLast = "Last " + last.map(function (x) { return zahl(x).toFixed(2); }).join(" ");
    var tipSwap = "Swap " + mb(sp.swapBenutztMb) + " / " + mb(sp.swapGesamtMb);
    var reihen = [
      hostBalken("CPU", zahl(H.cpu), hostProzent(H.cpu).replace("%", " %"), tipLast),
      hostBalken("RAM", sp.gesamtMb > 0 ? zahl(sp.benutztMb) / zahl(sp.gesamtMb) * 100 : 0, mbPaar(sp.benutztMb, sp.gesamtMb), tipSwap + " · frei " + mb(sp.verfuegbarMb))
    ];
    (Array.isArray(H.platten) ? H.platten : []).forEach(function (d) {
      reihen.push(hostBalken(d.pfad === "/" ? "Platte" : d.pfad, zahl(d.prozent), mbPaar(d.benutztMb, d.gesamtMb), d.pfad));
    });
    var ramProzent = sp.gesamtMb > 0 ? zahl(sp.benutztMb) / zahl(sp.gesamtMb) * 100 : 0;
    var balkenBlock = '<div class="hw-balken">' + reihen.join("") + "</div>" + verlaufTeil(H, ramProzent);
    var details = '<details class="hw-details"' + (auf ? " open" : "") + "><summary>Top-Prozesse</summary>" + hostProzesse("nach CPU", H.topCpu) + hostProzesse("nach RAM", H.topRam) + "</details>";
    return '<section class="lp-host" data-testid="sitzung-host">' + ueberschrift("Rechner") + '<div class="lv-verbrauch lv-host">' + balkenBlock + details + "</div></section>";
  }
  /**
   * Ruft lade alle ms auf, solange das Dokument sichtbar ist. Beim Sichtbarwerden sofort einmal, beim
   * Verbergen Schluss. `zeit` ersetzt setInterval und clearInterval in Tests.
   */
  function sichtbarTakt(d, ms, lade, zeit) {
    var z = zeit || { setze: G.setInterval.bind(G), loesche: G.clearInterval.bind(G) };
    var id = null, tot = false;
    function sichtbar() { return d.visibilityState === "visible"; }
    function start() {
      if (tot || id !== null || !sichtbar()) return;
      lade();
      id = z.setze(lade, ms);
    }
    function stopp() {
      if (id !== null) z.loesche(id);
      id = null;
    }
    function wechsel() { if (sichtbar()) start(); else stopp(); }
    function ende() {
      tot = true;
      stopp();
      d.removeEventListener("visibilitychange", wechsel);
    }
    d.addEventListener("visibilitychange", wechsel);
    return { start: start, stopp: stopp, ende: ende, laeuft: function () { return id !== null; } };
  }
  var hostTaktObj = null;
  function ladeHost() {
    return fetch("/api/host", { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error("host " + r.status);
      return r.json();
    }).then(function (b) {
      var neu = b && typeof b === "object" && b.verfuegbar === true ? b : null;
      // Linux-only: meldet der Server ausdruecklich "nicht verfuegbar", verschwindet der Block und der Takt endet.
      if (!neu && b && b.verfuegbar === false && hostTaktObj) { hostTaktObj.ende(); hostTaktObj = null; }
      if (!neu && !HOST) return;
      HOST = neu;
      if (D || !API) zeichneHost();
    }).catch(function () { /* der naechste Takt versucht es wieder */ });
  }
  /** Nur den Block neu; er bleibt aufgeklappt, wenn er es war. Erscheint oder verschwindet er, die ganze Seite. */
  function zeichneHost() {
    var el = wurzel.querySelector('[data-testid="sitzung-host"]');
    var html = hostTeil(hostAuf);
    if (!API) {
      // Liste aller Sitzungen: der Block sitzt unter dem Kopf, ohne dass die Liste neu geladen wird.
      if (el && html) el.outerHTML = html;
      else if (el) el.remove();
      else if (html) { var kopf = wurzel.querySelector(".lp-kopf"); if (kopf) kopf.insertAdjacentHTML("afterend", html); }
      return;
    }
    if (el && html) { if (!modal && !diffAuf && !fmAuf) el.outerHTML = html; }
    else if (el || html) zeichne();
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
  var DIFF_ART = { diff: "Diff gegen HEAD", neu: "neu, unversioniert", datei: "unveraendert", binaer: "binaer", bild: "Bild" };
  /** Ob der Pfad nach der Endung ein Bild ist, das GET .../bild?p= ausliefert. */
  function istBild(p) { return /\.(png|jpe?g|gif|webp|svg)$/i.test(String(p || "")); }
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
      : b.art === "bild" ? '<div class="lp-bild" tabindex="0"><img src="' + esc(b.url) + '" alt="' + esc(z.p) + '"></div>'
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
  var FM_ZUSTAND = { working: "●", "ohne-meldung": "●", paused: "‖", blocked: "■", "needs-decision": "?", done: "✓", failed: "✗", dead: "†", unknown: "·" };
  // Der Zustand in Worten, wie die Karte ihn nennt; "ohne-meldung": das Fenster lebt, eine Statuszeile fehlt noch.
  var FM_KARTE = { working: "arbeitet", "ohne-meldung": "arbeitet, noch keine Meldung", paused: "pausiert", blocked: "blockiert", "needs-decision": "wartet auf Entscheidung", done: "fertig", failed: "fehlgeschlagen", dead: "Fenster fehlt", unknown: "unbekannt" };
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
  /** Der Zustand, wie die Karte ihn zeigt: zustandKarte aus firstmate.ts, sonst der Zustand. */
  function fmKarte(w) {
    var k = w && w.zustandKarte;
    return FM_KARTE[k] ? k : fmZustand(w);
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
    if (!p.git) return "<tr><td>" + name + '</td><td colspan="5" class="unbekannt">kein Git-Klon</td><td>' + esc((p.worker || []).join(", ")) + "</td></tr>";
    var zweig = esc(p.zweig || "detached") + (p.upstream ? ' <span class="vz" title="' + esc("gegen " + p.upstream) + '">↑' + zahl(p.ahead) + " ↓" + zahl(p.behind) + "</span>" : ' <span class="unbekannt">kein Upstream</span>');
    var stand = p.geaendert ? '<span class="g-m">geändert ±' + zahl(p.geaendert) + "</span>" : '<span class="fm-sauber">sauber</span>';
    var commit = p.commit ? zeitAngabe(isoAus(p.commit.zeit)) + ' <span class="mono klein">' + esc(p.commit.hash) + "</span> " + esc(p.commit.betreff) : '<span class="unbekannt">kein Commit</span>';
    var abgerufen = p.abgerufen ? zeitAngabe(isoAus(p.abgerufen)) : '<span class="unbekannt">nie</span>';
    var worker = (p.worker || []).map(function (id) { return '<span class="mono fm-wid" data-fm-worker="' + esc(id) + '" role="button" tabindex="0">' + esc(id) + "</span>"; }).join(" ");
    return "<tr><td>" + name + '</td><td class="mono">' + zweig + "</td><td>" + stand + "</td><td>" + commit + "</td><td>" + abgerufen + "</td><td>" + fmPrs(p) + "</td><td>" + worker + "</td></tr>";
  }
  // --- Markdown ohne rohes HTML (fuer Anweisungen und Berichte der Flotte) ----------------------
  // Nur die benoetigte Teilmenge: Ueberschriften, Listen, Code, Tabellen, Zitate, Hervorhebung, Links.
  // Jeder Text geht durch esc(); es gibt keinen Durchlass fuer HTML, Links nur auf https-Adressen.
  var MD_LI = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  var MD_TRENNER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
  var MD_INLINE = /`([^`\n]+)`|\[([^\]\n]+)\]\((https:\/\/[^\s)]+)\)|\*\*([^*\n]+?)\*\*|(^|[^\w*])\*([^\s*][^*\n]*?)\*(?![\w*])|(^|[^\w])_([^\s_][^_\n]*?)_(?!\w)|(https:\/\/[^\s<>"'`)\]]+)/g;
  function mdInline(s) {
    var re = new RegExp(MD_INLINE.source, "g"), out = "", letzte = 0, m;
    s = String(s);
    while ((m = re.exec(s))) {
      out += esc(s.slice(letzte, m.index));
      letzte = re.lastIndex;
      if (m[1] !== undefined) out += "<code>" + esc(m[1]) + "</code>";
      else if (m[2] !== undefined) out += '<a href="' + esc(m[3]) + '" target="_blank" rel="noopener noreferrer">' + esc(m[2]) + "</a>";
      else if (m[4] !== undefined) out += "<strong>" + mdInline(m[4]) + "</strong>";
      else if (m[6] !== undefined) out += esc(m[5]) + "<em>" + mdInline(m[6]) + "</em>";
      else if (m[8] !== undefined) out += esc(m[7]) + "<em>" + mdInline(m[8]) + "</em>";
      else {
        var url = m[9], rest = /[.,;:!?]+$/.exec(url);
        if (rest) { url = url.slice(0, -rest[0].length); letzte = re.lastIndex = m.index + url.length; }
        out += '<a href="' + esc(url) + '" target="_blank" rel="noopener noreferrer">' + esc(url) + "</a>";
      }
    }
    return out + esc(s.slice(letzte));
  }
  function mdZellen(zeile) {
    var z = zeile.trim().replace(/\\\|/g, "\u0000");
    if (z.charAt(0) === "|") z = z.slice(1);
    if (z.charAt(z.length - 1) === "|") z = z.slice(0, -1);
    return z.split("|").map(function (c) { return c.replace(/\u0000/g, "|").trim(); });
  }
  /** Eine Liste ab Zeile i, Unterlisten nach Einrueckung; gibt [html, naechste Zeile] zurueck. */
  function mdListe(zeilen, i) {
    var n = zeilen.length, erste = MD_LI.exec(zeilen[i]), basis = erste[1].length, geordnet = /\d/.test(erste[2]);
    var punkte = [], cur = null;
    while (i < n) {
      var l = zeilen[i], mm = MD_LI.exec(l);
      if (!mm) {
        if (/^\s*$/.test(l)) {
          var j = i + 1;
          while (j < n && /^\s*$/.test(zeilen[j])) j++;
          var nx = j < n ? MD_LI.exec(zeilen[j]) : null;
          if (nx && nx[1].length >= basis) { i = j; continue; }
          break;
        }
        if (/^\s+\S/.test(l) && cur) { cur.text += " " + l.trim(); i++; continue; }
        break;
      }
      var ein = mm[1].length;
      if (ein < basis) break;
      if (ein > basis) { var r = mdListe(zeilen, i); cur.sub += r[0]; i = r[1]; continue; }
      if (/\d/.test(mm[2]) !== geordnet) break;
      cur = { text: mm[3], sub: "" };
      punkte.push(cur);
      i++;
    }
    var tag = geordnet ? "ol" : "ul";
    return ["<" + tag + ">" + punkte.map(function (p) { return "<li>" + mdInline(p.text) + p.sub + "</li>"; }).join("") + "</" + tag + ">", i];
  }
  function mdHtml(text) {
    if (text === null || text === undefined) return "";
    var zeilen = String(text).replace(/\r\n?/g, "\n").split("\n"), n = zeilen.length, i = 0, out = [];
    var blockStart = function (k) {
      var l = zeilen[k];
      return /^\s*(```|~~~)/.test(l) || /^#{1,6}\s/.test(l) || MD_LI.test(l) || /^\s*>/.test(l) || (l.indexOf("|") >= 0 && k + 1 < n && MD_TRENNER.test(zeilen[k + 1]) && zeilen[k + 1].indexOf("-") >= 0);
    };
    while (i < n) {
      var l = zeilen[i], m;
      if (/^\s*$/.test(l)) { i++; continue; }
      if ((m = /^\s*(```|~~~)/.exec(l))) {
        var code = [];
        i++;
        while (i < n && zeilen[i].replace(/^\s+/, "").indexOf(m[1]) !== 0) code.push(zeilen[i++]);
        i++;
        out.push("<pre><code>" + esc(code.join("\n") + "\n") + "</code></pre>");
        continue;
      }
      if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l))) { out.push("<h" + m[1].length + ">" + mdInline(m[2]) + "</h" + m[1].length + ">"); i++; continue; }
      if (l.indexOf("|") >= 0 && i + 1 < n && MD_TRENNER.test(zeilen[i + 1]) && zeilen[i + 1].indexOf("-") >= 0) {
        var kopf = mdZellen(l), koerper = [];
        i += 2;
        while (i < n && zeilen[i].indexOf("|") >= 0 && !/^\s*$/.test(zeilen[i])) koerper.push(mdZellen(zeilen[i++]));
        out.push("<table><thead><tr>" + kopf.map(function (c) { return "<th>" + mdInline(c) + "</th>"; }).join("") + "</tr></thead><tbody>" +
          koerper.map(function (z) { return "<tr>" + z.map(function (c) { return "<td>" + mdInline(c) + "</td>"; }).join("") + "</tr>"; }).join("") + "</tbody></table>");
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push("<hr>"); i++; continue; }
      if (/^\s*>/.test(l)) {
        var zitat = [];
        while (i < n && /^\s*>/.test(zeilen[i])) zitat.push(zeilen[i++].replace(/^\s*> ?/, ""));
        out.push("<blockquote>" + mdHtml(zitat.join("\n")) + "</blockquote>");
        continue;
      }
      if (MD_LI.test(l)) { var r = mdListe(zeilen, i); out.push(r[0]); i = r[1]; continue; }
      var absatz = [];
      while (i < n && !/^\s*$/.test(zeilen[i]) && (absatz.length === 0 || !blockStart(i))) absatz.push(zeilen[i++].trim());
      out.push("<p>" + mdInline(absatz.join(" ")) + "</p>");
    }
    return out.join("");
  }

  // --- Flotte: eine Linie je Repo, aufklappbar zu einer Zeile je Aufgabe, Klick fuer alle Details ----
  // Die Daten stammen aus FM.flotte (firstmate.ts): Lage und Breite aller Balken in Prozent des
  // gemeinsamen Zeitfensters, dazu die Marke fuer jetzt. Der Hover zeigt jede Aufgabe unter dem Zeiger,
  // ein Klick auf den Kopf klappt das Repo auf, ein Klick auf eine Aufgabe oeffnet das Modal; dessen
  // Anweisungen, Bericht, Zeitleiste und Dateien holt GET .../firstmate/aufgabe/ID erst dann.
  var flOffen = {};
  var flDetail = {};
  var flDetailOffen = {};
  var FL_ZUSTAND_KLASSE = { lauf: "working", stopp: "paused", fertig: "done" };
  function flZeit(sek) {
    var d = new Date(zahl(sek) * 1000);
    return zwei(d.getHours()) + ":" + zwei(d.getMinutes());
  }
  function flDauer(min) {
    var m = Math.max(0, Math.round(zahl(min)));
    return m >= 60 ? Math.floor(m / 60) + " h " + (m % 60 ? zwei(m % 60) + " min" : "").trim() : m + " min";
  }
  function flKosten(a) {
    return a.kosten === null || a.kosten === undefined ? "—" : zahl(a.kosten).toFixed(2) + " $";
  }
  function flBis(a) {
    return a.ende ? flZeit(a.ende) : a.zustandText;
  }
  function flTip(a) {
    return a.id + (a.titel ? " · " + a.titel : "") + " · " + flZeit(a.start) + "–" + flBis(a) + " (" + flDauer(a.minuten) + ")";
  }
  function flAufgabe(id) {
    var repos = FM && FM.flotte && Array.isArray(FM.flotte.repos) ? FM.flotte.repos : [];
    for (var i = 0; i < repos.length; i++) {
      var a = (repos[i].aufgaben || []).find(function (x) { return x && x.id === id; });
      if (a) return a;
    }
    return null;
  }
  function flBalken(a) {
    var art = a.kind === "scout" ? "scout" : "ship";
    var h = '<i class="fl-seg fl-' + art + " fl-" + esc(a.zustand) + '" style="left:' + zahl(a.von) + "%;width:" + zahl(a.breit) + '%" data-fl-id="' + esc(a.id) + '" data-fl-von="' + zahl(a.von) + '" data-fl-breit="' + zahl(a.breit) + '" data-fl-tip="' + esc(flTip(a)) + '"></i>';
    var s = a.schaetzung;
    if (s) h += '<i class="fl-seg fl-plan" style="left:' + zahl(s.von) + "%;width:" + zahl(s.breit) + '%" data-fl-von="' + zahl(s.von) + '" data-fl-breit="' + zahl(s.breit) + '" data-fl-tip="' + esc("Schätzung " + a.id + ": noch ~" + s.minuten + " min (Median " + s.median + " min)") + '"></i>';
    return h;
  }
  function flZeile(a) {
    var pr = a.pr ? fmLink(a.pr, "#" + String(a.pr).split("/").pop()) : a.ausgang === "reported" ? "Bericht" : "—";
    var rest = a.schaetzung ? " · noch ~" + a.schaetzung.minuten + " min" : "";
    return '<div class="fl-zeile fm-z-' + FL_ZUSTAND_KLASSE[a.zustand] + '" role="button" tabindex="0" data-fl-task="' + esc(a.id) + '" title="Details zu ' + esc(a.id) + '">' +
      '<div class="fl-lbl"><b>' + esc(a.id) + "</b><span>" + esc(a.titel || "") + "</span></div>" +
      '<div class="fl-bahn">' + flBalken(a) + "</div>" +
      '<div class="fl-meta">' + esc(flZeit(a.start) + "–" + flBis(a) + " · " + flDauer(a.minuten)) + " · " + pr + esc(" · " + flKosten(a) + rest) + "</div></div>";
  }
  function flAchse(f) {
    var marken = (f.achse || []).map(function (m) { return '<span style="left:' + zahl(m.prozent) + '%">' + esc(flZeit(m.t)) + "</span>"; }).join("");
    return '<div class="fl-achse">' + marken + '<em class="fl-jetzt" style="left:' + zahl(f.jetztProzent) + '%"></em></div>';
  }
  function flRepo(r, f) {
    var offen = !!flOffen[r.repo], laeuft = (r.laeuft || []).join(", ");
    var kpi = r.aufgaben.length + (r.aufgaben.length === 1 ? " Aufgabe" : " Aufgaben") + " · " + zahl(r.gemergt) + " gemergt · läuft: " + (laeuft || "nichts") + (r.median !== null && r.median !== undefined ? " · Median " + r.median + " min" : "");
    // Ohne laufende Aufgabe ist der Repo-Abschnitt gedämpft, bleibt aber aufklappbar und lesbar
    var ruht = !laeuft;
    return '<section class="fl-repo' + (offen ? " offen" : "") + (ruht ? " fl-ruht" : "") + '" data-testid="flotte-repo">' +
      '<div class="fl-kopf" role="button" tabindex="0" aria-expanded="' + offen + '" data-fl-repo="' + esc(r.repo) + '"><span class="fl-pfeil">▸</span><b>' + esc(r.repo) + '</b><span class="fl-kpi">' + esc(kpi) + "</span></div>" +
      '<div class="fl-strahl"><div class="fl-linie" data-fl-linie>' + r.aufgaben.map(flBalken).join("") + '<em class="fl-jetzt" style="left:' + zahl(f.jetztProzent) + '%"></em></div></div>' +
      '<div class="fl-auf">' + flAchse(f) + r.aufgaben.map(flZeile).join("") + "</div></section>";
  }
  /** Der Block Flotte heute: Legende, Achse und ein Repo je Linie. */
  function flotteTeil() {
    var f = FM && FM.flotte;
    if (!f || !Array.isArray(f.repos)) return '<p class="unbekannt">keine Flottendaten</p>';
    if (!f.repos.length) return '<p class="unbekannt">keine Aufgaben heute</p>';
    return '<div class="fl-leg"><i class="fl-seg fl-ship"></i>Umsetzung<i class="fl-seg fl-scout"></i>Scout/Review<i class="fl-seg fl-lauf"></i>läuft<i class="fl-seg fl-plan"></i>Schätzung<i class="fl-seg fl-stopp"></i>angehalten<i class="fl-jetzt-leg"></i>jetzt</div>' +
      '<div class="fl-gachse">' + flAchse(f) + '</div><div class="fl-repos" data-testid="firstmate-flotte">' + f.repos.map(function (r) { return flRepo(r, f); }).join("") + "</div>";
  }
  /** Die Aufgaben unter dem Zeiger einer Linie: alle Balken, die x (Prozent der Linienbreite) tragen. */
  function flTreffer(linie, clientX) {
    var r = linie.getBoundingClientRect();
    if (!(r.width > 0)) return [];
    var x = (clientX - r.left) / r.width * 100;
    return Array.prototype.filter.call(linie.querySelectorAll("[data-fl-tip]"), function (el) {
      var l = parseFloat(el.getAttribute("data-fl-von")), w = parseFloat(el.getAttribute("data-fl-breit"));
      return x >= l - 0.4 && x <= l + w + 0.4;
    });
  }
  var flTipEl = null;
  function flTipAus() {
    if (flTipEl) flTipEl.style.display = "none";
  }
  function flTipZeige(treffer, e) {
    if (!flTipEl) {
      flTipEl = doc.createElement("div");
      flTipEl.className = "fl-tip";
      flTipEl.setAttribute("role", "tooltip");
      doc.body.appendChild(flTipEl);
    }
    var mitId = treffer.filter(function (el) { return el.hasAttribute("data-fl-id"); }).length;
    flTipEl.innerHTML = treffer.map(function (el) { return "<div>" + esc(el.getAttribute("data-fl-tip")) + "</div>"; }).join("") +
      (mitId ? '<div class="h">' + (mitId > 1 ? "Klick: aufklappen und markieren" : "Klick: Details") + "</div>" : "");
    flTipEl.style.display = "block";
    flTipEl.style.left = Math.max(4, Math.min(e.clientX + 12, G.innerWidth - flTipEl.offsetWidth - 8)) + "px";
    flTipEl.style.top = e.clientY + 14 + "px";
  }
  function flHover(e) {
    var li = e.target && e.target.closest ? e.target.closest("[data-fl-linie]") : null;
    if (!li || fmAuf) { flTipAus(); return; }
    var t = flTreffer(li, e.clientX);
    Array.prototype.forEach.call(li.querySelectorAll("[data-fl-id]"), function (el) { el.classList.toggle("hl", t.indexOf(el) >= 0); });
    if (!t.length) { flTipAus(); return; }
    flTipZeige(t, e);
  }
  function flHoverEnde(e) {
    if (e.target && e.target.closest && e.target.closest("[data-fl-linie]") && !(e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest("[data-fl-linie]") === e.target.closest("[data-fl-linie]"))) {
      flTipAus();
      Array.prototype.forEach.call(e.target.closest("[data-fl-linie]").querySelectorAll(".hl"), function (el) { el.classList.remove("hl"); });
    }
  }
  /** Repo auf- oder zuklappen, ohne die Seite neu zu zeichnen; der Zustand bleibt in flOffen. */
  function flUmschalten(kopf, offen) {
    var s = kopf.closest(".fl-repo");
    if (!s) return;
    var neu = offen === undefined ? !s.classList.contains("offen") : offen;
    s.classList.toggle("offen", neu);
    kopf.setAttribute("aria-expanded", String(neu));
    flOffen[kopf.dataset.flRepo] = neu;
    if (!neu) Array.prototype.forEach.call(s.querySelectorAll(".fl-zeile.hl"), function (el) { el.classList.remove("hl"); });
  }
  function flKlickLinie(li, e) {
    var ids = flTreffer(li, e.clientX).map(function (el) { return el.getAttribute("data-fl-id"); }).filter(Boolean);
    flTipAus();
    if (ids.length === 1) { oeffneAufgabe(ids[0]); return; }
    if (!ids.length) return;
    var s = li.closest(".fl-repo");
    flUmschalten(s.querySelector("[data-fl-repo]"), true);
    Array.prototype.forEach.call(s.querySelectorAll(".fl-zeile"), function (el) { el.classList.toggle("hl", ids.indexOf(el.dataset.flTask) >= 0); });
  }

  /** Die Details einer Aufgabe oeffnen und, falls noetig, Brief, Bericht, Zeitleiste und Dateien nachladen. */
  function oeffneAufgabe(id) {
    if (!flAufgabe(id)) return;
    fmAuf = "t:" + id;
    flTipAus();
    var d = flDetail[id];
    if (!d || d.art === "fehler") {
      flDetail[id] = { art: "laedt" };
      fetch(API + "/firstmate/aufgabe/" + encodeURIComponent(id), { cache: "no-store" })
        .then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (b) {
            if (!r.ok) throw new Error((b && b.fehler) || "HTTP " + r.status);
            return b;
          });
        })
        .then(function (b) { flDetail[id] = { art: "ok", daten: b }; }, function (err) { flDetail[id] = { art: "fehler", fehler: err.message }; })
        .then(function () { if (fmAuf === "t:" + id) zeichne(); });
    }
    zeichne();
  }
  function flTeil(id, schluessel, titel, inhalt, standardOffen) {
    var k = id + "/" + schluessel, auf = flDetailOffen[k] === undefined ? !!standardOffen : flDetailOffen[k];
    return '<div class="fl-teil"><details data-fl-det="' + esc(k) + '"' + (auf ? " open" : "") + "><summary>" + titel + '</summary><div class="md">' + inhalt + "</div></details></div>";
  }
  function flAufgabeModal(id) {
    var a = flAufgabe(id);
    if (!a) return "";
    var det = flDetail[id] || { art: "laedt" }, d = det.art === "ok" ? det.daten : null;
    var w = fmWorker(id), z = FL_ZUSTAND_KLASSE[a.zustand];
    var laedt = '<p class="unbekannt">lädt …</p>', fehler = '<p class="unbekannt">' + esc(det.fehler || "") + "</p>";
    var stand = function (inhalt) { return det.art === "ok" ? inhalt : det.art === "fehler" ? fehler : laedt; };
    var feld = function (name, wert, breit) { return '<div' + (breit ? ' class="breit"' : "") + '><span class="lab">' + esc(name) + "</span><b>" + wert + "</b></div>"; };
    var fakten = '<div class="fl-fakten">' +
      feld("Zeit", esc(flZeit(a.start) + "–" + flBis(a))) + feld("Dauer", esc(flDauer(a.minuten))) +
      feld("Kosten · Züge", esc(flKosten(a) + " · " + (a.zuege === null || a.zuege === undefined ? "—" : a.zuege))) + feld("Ergebnis", a.pr ? fmLink(a.pr, "#" + String(a.pr).split("/").pop()) : "—") +
      feld("Modell", esc(a.modell || "—")) + feld("Effort", esc(a.effort || "—")) + feld("Quelle", '<span class="mono">' + esc("data/" + id + "/brief.md") + "</span>", true) + "</div>";
    var intent = stand(d && d.intent ? mdHtml(d.intent) : '<p class="unbekannt">Kein Abschnitt „Captain\'s intent“ (ältere Anweisung).</p>');
    var spec = d && d.spec ? flTeil(id, "spec", "Bauvorgaben von Firstmate (Firstmate spec)", mdHtml(d.spec), false) : "";
    var voll = d && d.brief ? flTeil(id, "voll", "Volle Anweisungen · " + esc("data/" + id + "/brief.md"), mdHtml(d.brief) + (d.briefGekuerzt ? '<p class="unbekannt">… gekürzt, die volle Datei liegt in ' + esc("data/" + id + "/brief.md") + "</p>" : ""), false) : "";
    var bericht = d && d.bericht ? flTeil(id, "bericht", "Bericht · " + esc("data/" + id + "/report.md"), mdHtml(d.bericht) + (d.berichtGekuerzt ? '<p class="unbekannt">… gekürzt, der volle Bericht liegt in ' + esc("data/" + id + "/report.md") + "</p>" : ""), true) : "";
    var zeitleiste = !d ? stand("") : Array.isArray(d.zeitleiste) && d.zeitleiste.length
      ? '<table class="fl-zl">' + d.zeitleiste.slice().reverse().map(function (s) {
        return '<tr class="fm-v-' + esc(s.verb) + '"><td>' + (s.at ? esc(flZeit(s.at)) : "?") + '</td><td><span class="fl-marke">' + esc(s.verb + (s.key ? " [" + s.key + "]" : "")) + "</span></td><td>" + esc(s.text) + "</td></tr>";
      }).join("") + "</table>"
      : Array.isArray(d.zeitleiste) ? '<p class="unbekannt">noch keine Statuszeile</p>' : '<p class="unbekannt">Zeitleiste beim Abräumen gelöscht</p>';
    var dateien = d ? (d.dateien && d.dateien.length ? '<div class="mono fl-dateien">' + d.dateien.map(esc).join(" · ") + "</div>" : "—") : stand("");
    var offen = w && w.status && Array.isArray(w.status.offen) ? w.status.offen : [];
    return '<div class="lp-modal" data-modal-zu><div class="lp-modal-box lp-fm lp-fl fm-z-' + z + '" role="dialog" aria-modal="true" aria-labelledby="lp-modal-titel" data-testid="flotte-details">' +
      '<div class="lp-modal-kopf"><h2 id="lp-modal-titel"><span class="mono">' + esc(a.id) + "</span></h2>" +
      '<span class="fl-marke fl-m-' + esc(a.zustand) + '">' + esc(a.zustandText) + '</span><span class="fl-marke">' + esc(a.repo + " · " + (a.kind === "scout" ? "Scout" : a.kind === "ship" ? "Umsetzung" : a.kind)) + "</span>" +
      '<button type="button" class="zu" data-modal-zu aria-label="Schliessen (Esc)" title="Schliessen (Esc)">×</button></div>' +
      '<div class="fm-details" tabindex="0">' + (a.titel ? '<p class="fl-titel">' + esc(a.titel) + "</p>" : "") + fakten +
      '<h3 class="fm-h">Anforderung (Captain\'s intent)</h3><div class="md">' + intent + "</div>" + spec + voll + bericht +
      (offen.length ? '<h3 class="fm-h">Offene Entscheidungen und Blocker</h3><ul class="fm-verlauf">' + offen.map(function (s) {
        return '<li class="fm-v-' + esc(s.verb) + '"><span class="fm-verb">' + esc(s.verb + (s.key ? " [" + s.key + "]" : "")) + "</span>" + esc(s.text) + "</li>";
      }).join("") + "</ul>" : "") +
      '<h3 class="fm-h">Zeitleiste</h3>' + zeitleiste + '<h3 class="fm-h">' + esc("Dateien in data/" + id + "/") + "</h3>" + dateien +
      (w && Array.isArray(w.befehle) && w.befehle.length ? '<h3 class="fm-h">Befehle</h3>' + fmBefehle(w.befehle) : "") + "</div></div></div>";
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
      '<h3 class="fm-h">Flotte heute <span class="zaehler">' + (FM.flotte && Array.isArray(FM.flotte.repos) ? FM.flotte.repos.reduce(function (n, r) { return n + r.aufgaben.length; }, 0) : 0) + " Aufgaben</span></h3>" + flotteTeil() +
      '<h3 class="fm-h">Projekte <span class="zaehler">' + projekte.length + "</span></h3>" +
      (projekte.length ? '<div class="fm-tabelle"><table class="fm-projekte" data-testid="firstmate-projekte"><thead><tr><th>Projekt</th><th>Zweig</th><th>Stand</th><th>Letzter Commit</th><th>zuletzt aktualisiert</th><th>PRs</th><th>Worker</th></tr></thead><tbody>' +
        projekte.map(fmProjektZeile).join("") + "</tbody></table></div>" : '<p class="unbekannt">keine Klone unter projects/</p>') + "</section>";
  }
  function fmBefehle(befehle) {
    return '<ul class="fm-befehle">' + befehle.map(function (b) {
      return '<li><span class="fm-zweck">' + esc(b.zweck) + '</span><code>' + esc(b.befehl) + '</code><button type="button" class="kopieren" data-kopiere="' + esc(b.befehl) + '">kopieren</button></li>';
    }).join("") + "</ul>";
  }
  /** Laufzeit der Karte: vom Start bis jetzt; bei fertig oder gescheitert bis zur letzten Meldung. */
  function fmLaufzeit(w) {
    if (!w.gestartet) return "";
    var letzte = w.status && w.status.letzte;
    var ende = (w.zustand === "done" || w.zustand === "failed") && letzte && letzte.at ? letzte.at : zahl(FM.zeit) || Math.floor(Date.now() / 1000);
    return flDauer((ende - w.gestartet) / 60);
  }
  /** Eine Gruppe der Meta als Zeilen aus Schluessel und Wert; pr ist ein Link, sonst Text. */
  function fmMetaZeilen(eintraege) {
    return eintraege.map(function (e) {
      return "<dt>" + esc(e.schluessel) + "</dt><dd>" + (e.schluessel === "pr" ? fmLink(e.wert, e.wert) : esc(e.wert)) + "</dd>";
    }).join("");
  }
  /** Die Karte eines Workers im Modal: Kopf, Meta in Gruppen, Statusverlauf, Steuerung, Befehle; ohne Pane-Zeilen. "t:ID" ist eine Aufgabe der Flotte. */
  function fmModal(id) {
    if (typeof id === "string" && id.indexOf("t:") === 0) return flAufgabeModal(id.slice(2));
    var w = id && fmWorker(id);
    if (!w) return "";
    var m = w.meta || {}, zk = fmKarte(w), fe = w.fenster || {}, wt = w.worktree, dt = w.daten || {};
    var gruppe = function (name) {
      var g = (Array.isArray(w.metaGruppen) ? w.metaGruppen : []).find(function (x) { return x && x.name === name; });
      return g && Array.isArray(g.eintraege) ? g.eintraege : [];
    };
    var zeile = function (name, wert) { return wert ? "<dt>" + esc(name) + "</dt><dd>" + wert + "</dd>" : ""; };
    var ohne = function (t) { return t ? esc(t) : "—"; };
    var art = m.kind === "scout" ? "Scout" : m.kind === "ship" ? "Umsetzung" : m.kind;
    var kopf = '<dl class="fm-felder fm-kopf">' + zeile("Repo", ohne(m.project && fmProjektName(m.project))) + zeile("Art", ohne(art)) +
      zeile("Modell", ohne([m.model, m.effort].filter(Boolean).join(" · "))) + zeile("Laufzeit", ohne(fmLaufzeit(w))) + "</dl>";

    var ortZeilen = fmMetaZeilen(gruppe("Ort")) +
      zeile("Fenster", fe.ziel ? esc(fe.ziel + "  " + (fe.lebt === null || fe.lebt === undefined ? "?" : fe.lebt ? "lebt" : "FEHLT")) + (fe.aktivitaet ? " · aktiv " + zeitAngabe(isoAus(fe.aktivitaet)) : "") : "keins") +
      (wt && wt.da ? zeile("Stand", fmZweig(w) + (wt.letzterCommit ? " · " + esc(wt.letzterCommit) : "")) : wt ? zeile("Stand", '<span class="unbekannt">Worktree nicht da</span>') : "") +
      (dt.dateien && dt.dateien.length ? zeile("Daten", esc(dt.ordner + " (" + dt.dateien.join(", ") + ")")) : "");
    var laufZeilen = fmMetaZeilen(gruppe("Lauf")) +
      zeile("Busy", w.busy ? esc(w.busy.zustand + (w.busy.quelle ? " (" + w.busy.quelle + ")" : "")) + (w.busy.ts ? " " + zeitAngabe(isoAus(w.busy.ts)) : "") : "");
    var alle = gruppe("alle"), alleSchluessel = "w:" + w.id + "/alle";
    var block = function (name, zeilenHtml) { return zeilenHtml ? '<div class="fm-untertitel">' + name + '</div><dl class="fm-felder">' + zeilenHtml + "</dl>" : ""; };
    var meta = block("Ort", ortZeilen) + block("Lauf", laufZeilen) + block("Liefern", fmMetaZeilen(gruppe("Liefern"))) +
      (alle.length ? '<details class="fm-alle" data-fl-det="' + esc(alleSchluessel) + '"' + (flDetailOffen[alleSchluessel] ? " open" : "") + "><summary>alle · " + alle.length + '</summary><dl class="fm-felder">' + fmMetaZeilen(alle) + "</dl></details>" : "");

    var offen = w.status && Array.isArray(w.status.offen) ? w.status.offen : [];
    var verlauf = Array.isArray(w.verlauf) ? w.verlauf.slice().reverse() : [];
    var zeileVerlauf = function (s) {
      var versatz = s.at && w.gestartet ? "+" + flDauer((s.at - w.gestartet) / 60) : s.at ? flZeit(s.at) : "?";
      return '<li class="fm-v-' + esc(s.verb) + '"><span class="fm-zeit"' + (s.at ? ' title="' + esc(ortszeit(isoAus(s.at))) + '"' : "") + ">" + esc(versatz) + '</span><span class="fl-marke fm-tag fm-v-' + esc(s.verb) + '">' + esc(s.verb + (s.key ? " [" + s.key + "]" : "")) + "</span>" + esc(s.text) + "</li>";
    };
    // Offene Zeilen, die im Verlauf fehlen (aelter als die letzten VERLAUF_N), stehen vorab; sonst zaehlt der Verlauf
    var ausserhalb = offen.filter(function (o) { return !(w.verlauf || []).some(function (v) { return v.roh === o.roh; }); });
    var verlaufInhalt = (ausserhalb.length ? '<div class="fm-untertitel">Offene Entscheidungen und Blocker</div><ul class="fm-verlauf">' + ausserhalb.map(zeileVerlauf).join("") + "</ul>" : "") +
      (verlauf.length ? '<ul class="fm-verlauf">' + verlauf.map(zeileVerlauf).join("") + "</ul>" : '<p class="unbekannt">Noch keine Meldung: Worker melden nur Phasenwechsel, die Statusdatei entsteht mit der ersten Meldung.</p>');

    var post = w.inbox || { wartend: [], erledigt: 0 }, wartend = Array.isArray(post.wartend) ? post.wartend : [];
    var steuerung = '<h3 class="fm-h">Steuerung</h3><dl class="fm-felder">' + zeile("wartend", wartend.length + (wartend.length ? " · " + esc(wartend.join(", ")) : "")) + zeile("erledigt", String(zahl(post.erledigt))) + "</dl>";
    var befehle = Array.isArray(w.befehle) ? w.befehle : [];

    return '<div class="lp-modal" data-modal-zu><div class="lp-modal-box lp-fm fm-z-' + zk + '" role="dialog" aria-modal="true" aria-labelledby="lp-modal-titel" data-testid="firstmate-details">' +
      '<div class="lp-modal-kopf"><h2 id="lp-modal-titel"><span class="fm-zeichen">' + FM_ZUSTAND[zk] + '</span> <span class="mono">' + esc(w.id) + "</span>" + (w.titel ? " · " + esc(w.titel) : "") + "</h2>" +
      '<span class="pfad">' + esc(FM_KARTE[zk]) + "</span>" +
      '<button type="button" class="zu" data-modal-zu aria-label="Schliessen (Esc)" title="Schliessen (Esc)">×</button></div>' +
      '<div class="fm-details" tabindex="0">' + kopf +
      '<h3 class="fm-h">Meta</h3>' + (meta || '<p class="unbekannt">keine Meta</p>') +
      '<h3 class="fm-h">Statusverlauf <span class="zaehler">' + zahl(w.status && w.status.zeilen) + " Zeilen</span></h3>" + verlaufInhalt +
      steuerung + (befehle.length ? '<h3 class="fm-h">Befehle</h3>' + fmBefehle(befehle) : "") +
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
    return '<footer class="lp-fuss" data-testid="sitzung-fuss"><span>' + esc(links) + '</span><button type="button" class="mono lp-fuss-datei" data-pfad="' + esc(".live-plan/" + D.slug + ".yaml") + '" title="Plan-Datei der Sitzung zeigen">' + esc(".live-plan/" + D.slug + ".yaml") + "</button></footer>";
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
    return '<div class="lp-inhalt"' + (modalHtml ? " inert" : "") + ">" + kopf() + ansageLeiste(leisteZustand()) + fehler() + ueberblickKarten() + teilEins() +
      hostTeil(hostAuf) + verbrauchTeil() + agentenAbschnitt() + fortschrittTeil() + blick() + jetzt(true) +
      '<div class="lp-teil1">' + fragenAnSie() + ueberblick() + "</div>" + firstmateTeil() + doku() + dateien() + fuss() +
      '<aside id="lp-drawer" class="lp-drawer' + (sel ? " open" : "") + '" data-testid="sitzung-drawer">' + (sel ? drawerInhalt(sel) : "") + "</aside></div>" +
      (modalHtml || "");
  }

  // --- Ansagen (Uebersicht): kurze Zusammenfassungen aller Sitzungen aus GET /api/ansagen, vorgelesen ---------
  /** Der Sprechtext einer Ansage: erst das Repo, aus dem sie kommt, dann der Text. */
  function ansageSprechtext(a) {
    var repo = a && a.repo ? String(a.repo) : "", text = a && a.text ? String(a.text) : "";
    return repo ? repo + ": " + text : text;
  }
  /** Die Uhrzeit einer Ansage, an einem anderen Tag mit Datum. */
  function ansageUhr(ms, jetzt) {
    var d = new Date(ms), n = new Date(jetzt === undefined ? jetztMs() : jetzt);
    if (isNaN(d.getTime())) return "";
    var tag = d.toDateString() === n.toDateString() ? "" : zwei(d.getDate()) + "." + zwei(d.getMonth() + 1) + ". ";
    return tag + zwei(d.getHours()) + ":" + zwei(d.getMinutes());
  }
  /** Je Sitzung (Repo und Id) ihre neueste Ansage; `liste` kommt neueste zuerst. */
  function letzteAnsagen(liste) {
    var je = {};
    (Array.isArray(liste) ? liste : []).forEach(function (a) {
      var k = a && a.id ? a.repo + "\u0000" + a.id : null;
      if (k && !je[k]) je[k] = a;
    });
    return je;
  }
  /** Die Zelle Ansage einer Sitzung: ▶ spielt ihre neueste Ansage, daneben ihre Uhrzeit; ohne Ansage leer. */
  function ansageZelle(a) {
    if (!a) return '<td class="lp-ansage"></td>';
    var uhr = ansageUhr(a.zeit);
    return '<td class="lp-ansage"><button type="button" class="an-spiel" data-ansage="' + esc(a.zeit) + '" title="' + esc(a.text) + '" aria-label="' +
      esc("Letzte Ansage vorlesen: " + a.repo + " " + uhr) + '">▶</button> <span class="an-uhr mono" title="' + esc(ortszeit(isoVon(a.zeit))) + '">' + esc(uhr) + "</span></td>";
  }
  /** Die Namen der Stimmen ohne Doppel, deutsche zuerst, je { name, lang }. */
  function stimmenListe(stimmen) {
    var de = function (s) { return /^de\b/i.test(s.lang) ? 0 : 1; }, da = {};
    return (Array.isArray(stimmen) ? stimmen : []).filter(function (s) { return s && s.name && !da[s.name] && (da[s.name] = true); })
      .map(function (s) { return { name: String(s.name), lang: String(s.lang || "") }; })
      .sort(function (a, b) { return de(a) - de(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); });
  }
  /** Die Stimme zum gespeicherten Namen; fehlt sie im Browser, die erste deutsche, sonst null (Vorgabe des Browsers). */
  function stimmeWahl(stimmen, name) {
    var S = Array.isArray(stimmen) ? stimmen.filter(Boolean) : [];
    return (name && S.find(function (s) { return s.name === name; })) || S.find(function (s) { return /^de\b/i.test(String(s.lang || "")); }) || null;
  }
  /** Spricht stumm eine leere Aeusserung; im Klick selbst gibt das auch Safari die Sprachausgabe fuer spaeter frei. */
  function tonFreischalten(sprache, Aeusserung) {
    if (!sprache || !Aeusserung) return;
    var u = new Aeusserung("");
    u.volume = 0;
    sprache.speak(u);
  }
  /**
   * Das Einstellungsmenue im Kopf der Uebersicht: ⚙ klappt es auf, darin Vorlesen an/aus, die Stimme und die
   * letzte Ansage nochmal. `z`: { kann, vorlesen, frei, stimmen, stimme, auf, letzte, fehler }; `kann` false, wenn
   * der Browser nicht spricht, `frei` erst nach einem Klick auf die Seite.
   */
  function einstellungenMenue(z) {
    z = z || {};
    var zu = z.kann ? "" : " disabled";
    var hinweis = !z.vorlesen ? "" : !z.kann ? "Dieser Browser kann nicht vorlesen." : !z.frei ? "Ein Klick auf die Seite schaltet den Ton frei." : "";
    var html = '<div class="lp-einst" data-testid="einstellungen">' +
      '<button type="button" class="lp-einst-knopf' + (z.vorlesen ? " an" : "") + '" data-einst-auf aria-expanded="' + (z.auf ? "true" : "false") + '" title="Einstellungen: Vorlesen und Stimme">⚙' + (z.vorlesen ? " 🔊" : "") + "</button>" +
      (hinweis ? '<span class="an-hinweis">' + esc(hinweis) + "</span>" : "");
    if (!z.auf) return html + "</div>";
    var namen = stimmenListe(z.stimmen);
    var fehlt = z.stimme && !namen.some(function (s) { return s.name === z.stimme; });
    var optionen = '<option value=""' + (z.stimme && !fehlt ? "" : " selected") + ">Standard (Deutsch)</option>" + namen.map(function (s) {
      return '<option value="' + esc(s.name) + '"' + (s.name === z.stimme ? " selected" : "") + ">" + esc(s.name + (s.lang ? " · " + s.lang : "")) + "</option>";
    }).join("");
    return html + '<div class="lp-einst-panel" role="group" aria-label="Sprachausgabe">' +
      '<button type="button" class="an-auto' + (z.vorlesen ? " an" : "") + '" data-ansage-auto aria-pressed="' + (z.vorlesen ? "true" : "false") + '" title="Neue Ansagen aller Sitzungen automatisch vorlesen">🔊 Vorlesen: ' + (z.vorlesen ? "an" : "aus") + "</button>" +
      '<label class="an-stimme">Stimme <select data-ansage-stimme' + zu + ">" + optionen + "</select></label>" +
      (fehlt ? '<span class="an-notiz">' + esc("„" + z.stimme + "“ fehlt in diesem Browser, es gilt die deutsche Vorgabe.") + "</span>" : "") +
      '<button type="button" data-ansage-letzte' + (z.letzte && z.kann ? "" : " disabled") + ">▶ Letzte Ansage nochmal</button>" +
      (z.fehler ? '<span class="an-fehler">' + esc(z.fehler) + "</span>" : "") + "</div></div>";
  }
  /** Wie viele Ansagen die Leiste zeigt und nach wie vielen Zeichen ihr Text mit Ellipse endet (der volle Text steht im title). */
  var LEISTE_N = 5, LEISTE_ZEICHEN = 90;
  /** Der Text einer Ansage gekuerzt nach Zeichen, nicht nach Code-Einheiten, damit kein Emoji auseinanderbricht. */
  function kurzText(t) {
    var z = Array.from(String(t || ""));
    return z.length > LEISTE_ZEICHEN ? z.slice(0, LEISTE_ZEICHEN - 1).join("") + "…" : z.join("");
  }
  /**
   * Die Zeilen der Leiste: die neuesten LEISTE_N Ansagen aus allen Sitzungen (`z.ansagen`, neueste zuerst). Die Zeile der
   * eigenen Sitzung (`z.eigenesRepo` und `z.eigeneId`, dieselbe Zuordnung wie letzteAnsagen) bekommt die Klasse an-eigen.
   */
  function ansageZeilen(z) {
    var liste = (Array.isArray(z.ansagen) ? z.ansagen : []).slice(0, LEISTE_N);
    if (!liste.length) return '<p class="an-leer">Noch keine Ansage.</p>';
    return "<ol>" + liste.map(function (a) {
      var eigen = !!z.eigeneId && a.id === z.eigeneId && a.repo === z.eigenesRepo;
      var uhr = ansageUhr(a.zeit);
      return '<li class="an-zeile' + (eigen ? " an-eigen" : "") + '"><button type="button" class="an-spiel" data-ansage="' + esc(a.zeit) + '" aria-label="' +
        esc("Ansage vorlesen: " + a.repo + " " + uhr) + '">▶</button><span class="an-uhr mono">' + esc(uhr) + '</span><b class="an-repo">' + esc(a.repo) +
        '</b><span class="an-text" title="' + esc(a.text) + '">' + esc(kurzText(a.text)) + "</span></li>";
    }).join("") + "</ol>";
  }
  /**
   * Die Leiste Ansagen oben auf einer Sitzungsseite: Kopf mit dem ⚙-Menue (einstellungenMenue), darunter die Zeilen.
   * `z`: { ansagen, eigenesRepo, eigeneId, menue }, menue wie einstellungenZustand().
   */
  function ansageLeiste(z) {
    return '<section class="an-leiste" data-testid="ansagen-leiste"><div class="an-leiste-kopf"><h2>Ansagen</h2>' + einstellungenMenue(z.menue) + "</div>" +
      '<div class="an-leiste-liste" data-ansage-liste>' + ansageZeilen(z) + "</div></section>";
  }

  G.LivePlanAnsicht = {
    ansageSprechtext: ansageSprechtext,
    ansageZelle: ansageZelle,
    ansageLeiste: ansageLeiste,
    letzteAnsagen: letzteAnsagen,
    einstellungenMenue: einstellungenMenue,
    stimmenListe: stimmenListe,
    stimmeWahl: stimmeWahl,
    tonFreischalten: tonFreischalten,
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
    flotteTeil: flotteTeil,
    flAufgabeModal: flAufgabeModal,
    mdHtml: mdHtml,
    setzeAufgabeDetail: function (id, d) { flDetail[id] = { art: "ok", daten: d }; },
    setzeFirstmate: function (f) { FM = f && typeof f === "object" ? f : null; },
    setzeBaum: function (b) { BAUM = b && typeof b === "object" && Array.isArray(b.dateien) ? b : null; },
    setzeBaumModus: setzeBaumModus,
    setzeBaumFilter: function (t) { baumFilter = String(t || ""); },
    setzeOrdner: setzeOrdner,
    setzeGruppe: setzeGruppe,
    baumWarte: baumWarte,
    setzeFertigOffen: setzeFertigOffen,
    blick: blick,
    hostTeil: hostTeil,
    verlaufEimer: verlaufEimer,
    sichtbarTakt: sichtbarTakt,
    setzeHost: function (h) { HOST = h && typeof h === "object" ? h : null; },
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
    fragenZelle: fragenZelle,
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
    var leiste = wurzel.querySelector(".an-leiste");
    zeichneSeite();
    stelleLeisteHer(leiste);
    stelleDateienHer(dz);
    stelleEigenHer(ez);
  }
  /** Die Leiste Ansagen bleibt beim Neuzeichnen des Plans derselbe Knoten (offene Stimmenwahl, Fokus); das neue innerHTML setzt sie wieder ein. */
  function stelleLeisteHer(alt) {
    var neu = wurzel.querySelector(".an-leiste");
    if (alt && neu) neu.replaceWith(alt);
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
      wurzel.innerHTML = '<div class="lp-inhalt"' + (nurModal ? " inert" : "") + ">" + kopfNurLive() + ansageLeiste(leisteZustand()) + live() + firstmateTeil() + dateien() + "</div>" + nurModal;
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
      if (diffAuf !== auf) { if (teil.daten && teil.daten.url) G.URL.revokeObjectURL(teil.daten.url); return; }
      diffAuf = { p: p, s: auf.s, branch: auf.branch, daten: teil.daten, fehler: teil.fehler };
      auf = diffAuf;
      zeichne();
    };
    var bild = istBild(p);
    fetch(API + (bild ? "/bild" : "/diff") + "?p=" + encodeURIComponent(p) + (branch ? "&branch=" + encodeURIComponent(branch) : ""), { cache: "no-store" }).then(function (r) {
      // An image comes as raw bytes; shown from a blob URL, so a refusal reads as an error like for the diff.
      if (bild && r.ok) return r.blob().then(function (blob) { return { p: p, art: "bild", text: "", gekappt: false, url: G.URL.createObjectURL(blob) }; });
      return r.json().catch(function () { return {}; }).then(function (b) {
        if (!r.ok) throw new Error((b && b.fehler) || "HTTP " + r.status);
        return b;
      });
    }).then(function (b) { fertig({ daten: b }); }, function (err) { fertig({ fehler: err.message }); });
  }
  /** Schliessen per Esc, Hintergrund oder Knopf; der Fokus kehrt zur Zeile im Baum zurueck. */
  function schliesseDiff() {
    var p = diffAuf && diffAuf.p;
    if (diffAuf && diffAuf.daten && diffAuf.daten.url) G.URL.revokeObjectURL(diffAuf.daten.url);
    diffAuf = null;
    zeichne();
    var zeile = p && wurzel.querySelector('[data-pfad="' + (G.CSS && G.CSS.escape ? G.CSS.escape(p) : p) + '"]');
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
    var task = id && id.indexOf("t:") === 0;
    var wert = task ? id.slice(2) : id;
    var karte = id && wurzel.querySelector((task ? "[data-fl-task" : ".fm-wid[data-fm-worker") + '="' + (G.CSS && G.CSS.escape ? G.CSS.escape(wert) : wert) + '"]');
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
    if (ansageKlick(e)) return;
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
    var fli = e.target.closest("[data-fl-linie]");
    if (fli) { flKlickLinie(fli, e); return; }
    var flk = e.target.closest("[data-fl-repo]");
    if (flk) { flUmschalten(flk); return; }
    var flt = e.target.closest("[data-fl-task]");
    if (flt) { oeffneAufgabe(flt.dataset.flTask); return; }
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

  // Hover ueber einer Linie der Flotte: Tooltip mit jeder Aufgabe unter dem Zeiger.
  wurzel.addEventListener("mousemove", flHover);
  wurzel.addEventListener("mouseout", flHoverEnde);
  // Der Zustand der <details> im Aufgaben-Modal ueberlebt das Neuzeichnen (toggle blubbert nicht auf).
  wurzel.addEventListener("toggle", function (e) {
    var k = e.target && e.target.getAttribute && e.target.getAttribute("data-fl-det");
    if (k) flDetailOffen[k] = e.target.open;
  }, true);

  doc.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if (modal) { schliesseModal(); return; }
      if (diffAuf) { schliesseDiff(); return; }
      if (fmAuf) { schliesseFm(); return; }
      if (sel) { sel = null; zeichne(); }
      return;
    }
    // Eine Worker-Karte oeffnet ihre Details auch mit Enter und Leertaste.
    var karte = (e.key === "Enter" || e.key === " ") && !modal && !diffAuf && !fmAuf && e.target.closest && !e.target.closest("a[href]") && e.target.closest("[data-fm-worker], [data-fl-task], [data-fl-repo]");
    if (karte) {
      e.preventDefault();
      if (karte.dataset.flRepo !== undefined) flUmschalten(karte);
      else if (karte.dataset.flTask !== undefined) oeffneAufgabe(karte.dataset.flTask);
      else oeffneFm(karte.dataset.fmWorker);
      return;
    }
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

  /**
   * Die Zelle offener Fragen in der Liste: die Zahl als roter Verweis auf die Sitzung, bei null ein
   * leiser Strich; ohne Zahl (kaputte Datei, nur Register) bleibt sie leer.
   */
  function fragenZelle(zahl, href) {
    if (typeof zahl !== "number") return '<td class="lp-fragenzahl"></td>';
    if (zahl === 0) return '<td class="lp-fragenzahl klein">–</td>';
    return '<td class="lp-fragenzahl"><a class="offen" href="' + esc(href) + '" title="' + zahl + " " + (zahl === 1 ? "offene Frage" : "offene Fragen") + '">' + zahl + " offen</a></td>";
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
    var fokus = doc.activeElement && doc.activeElement.closest && el && el.contains(doc.activeElement) ? doc.activeElement.closest("[data-fm-worker], [data-fl-task], [data-fl-repo]") : null;
    var attr = fokus && ["data-fm-worker", "data-fl-task", "data-fl-repo"].find(function (x) { return fokus.hasAttribute(x); });
    var sel = fokus && "[" + attr + '="' + (G.CSS && G.CSS.escape ? G.CSS.escape(fokus.getAttribute(attr)) : fokus.getAttribute(attr)) + '"]';
    var nr = fokus ? Array.prototype.indexOf.call(el.querySelectorAll(sel), fokus) : -1;
    if (el && html && !modal && !diffAuf && !fmAuf) el.outerHTML = html;
    else if (el || html) zeichne();
    var wieder = fokus && wurzel.querySelectorAll(sel)[Math.max(nr, 0)];
    if (wieder) wieder.focus({ preventScroll: true });
  }

  function nichtGefunden() {
    doc.title = "nicht gefunden · live-plan";
    wurzel.innerHTML = '<header class="lp-kopf"><div class="lp-oben"><a class="lp-zurueck" href="/">alle Sitzungen</a>' + themaSchalter() + "</div><h1>Sitzung nicht gefunden</h1>" +
      '<p class="lp-ziel mono">' + esc((REPO || "") + "/.live-plan/" + (SLUG || "") + ".yaml") + "</p></header>";
  }

  // --- Ansagen auf Uebersicht und Sitzung -----------------------------------------------------
  // Neue Ansagen und geaenderte Einstellungen meldet GET /api/ereignisse. Vorgelesen wird eine neue Ansage nur, solange
  // Vorlesen an ist und die Seite einen Klick oder eine Taste hatte, denn erst danach lassen Browser sie sprechen.
  // Vorlesen und Stimme stehen zentral in einstellungen.yaml (GET und POST /api/einstellungen). Auf einer Sitzungsseite
  // zeigt die Leiste oben die neuesten Ansagen aller Sitzungen; die Uebersicht zeigt sie in ihrer Liste.
  var ANSAGEN = [], ansagenBekannt = null, ansageFrei = false;
  var EINST = { vorlesen: false, stimme: null }, einstAuf = false, einstFehler = "";
  var SPRACHE = G.speechSynthesis && G.SpeechSynthesisUtterance ? G.speechSynthesis : null;
  function einstellungenZustand() {
    return { kann: !!SPRACHE, vorlesen: EINST.vorlesen, frei: ansageFrei, stimmen: SPRACHE ? SPRACHE.getVoices() : [], stimme: EINST.stimme, auf: einstAuf, letzte: ANSAGEN.length > 0, fehler: einstFehler };
  }
  function zeichneEinstellungen() {
    var el = wurzel.querySelector(".lp-einst");
    if (el) el.outerHTML = einstellungenMenue(einstellungenZustand());
  }
  /** Was die Leiste auf einer Sitzungsseite braucht: alle Ansagen, die Sitzung der Seite (REPO, SLUG) und das Menue. */
  function leisteZustand() {
    return { ansagen: ANSAGEN, eigenesRepo: REPO, eigeneId: SLUG, menue: einstellungenZustand() };
  }
  /** Nur die Zeilen der Leiste neu, das Menue bleibt. Ohne Leiste (noch kein Plan gezeichnet) geschieht nichts; das naechste Zeichnen bringt sie mit. */
  function zeichneLeiste() {
    var el = wurzel.querySelector("[data-ansage-liste]");
    if (el) el.innerHTML = ansageZeilen(leisteZustand());
  }
  /** Spricht eine Ansage; `sofort` bricht ab, was gerade laeuft, sonst reiht der Browser sie hinten an. */
  function sprich(a, sofort) {
    if (!SPRACHE || !a) return;
    if (sofort) SPRACHE.cancel();
    var u = new G.SpeechSynthesisUtterance(ansageSprechtext(a));
    var stimme = stimmeWahl(SPRACHE.getVoices(), EINST.stimme);
    if (stimme) { u.voice = stimme; u.lang = stimme.lang; } else u.lang = "de-DE";
    SPRACHE.speak(u);
  }
  /** Laedt die Ansagen; was seit dem letzten Laden dazukam, liest sie bei Vorlesen an der Reihe nach vor. */
  function ladeAnsagen() {
    return fetch("/api/ansagen", { cache: "no-store" }).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (b) {
      if (!b || !Array.isArray(b.ansagen)) return;
      var liste = b.ansagen.filter(function (a) { return a && typeof a.zeit === "number" && typeof a.text === "string"; });
      var bekannt = ansagenBekannt;
      var neu = bekannt === null ? [] : liste.filter(function (a) { return a.zeit > bekannt; }).reverse();
      ansagenBekannt = liste.reduce(function (m, a) { return Math.max(m, a.zeit); }, bekannt || 0);
      var ersteDa = !ANSAGEN.length && liste.length;
      ANSAGEN = liste;
      if (API) zeichneLeiste(); else zeichneListe();
      // "Letzte nochmal" geht erst mit einer Ansage; sonst bleibt das Menue, wie es ist (offene Stimmenwahl).
      if (ersteDa) zeichneEinstellungen();
      if (EINST.vorlesen && ansageFrei) neu.forEach(function (a) { sprich(a, false); });
    }).catch(function () { /* das naechste Ereignis versucht es wieder */ });
  }
  function ladeEinstellungen() {
    return fetch("/api/einstellungen", { cache: "no-store" }).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (b) {
      if (!b || typeof b.vorlesen !== "boolean") return;
      var neu = { vorlesen: b.vorlesen, stimme: typeof b.stimme === "string" ? b.stimme : null };
      if (neu.vorlesen === EINST.vorlesen && neu.stimme === EINST.stimme) return;
      EINST = neu;
      zeichneEinstellungen();
    }).catch(function () { /* das naechste Ereignis versucht es wieder */ });
  }
  /** Schreibt eine Aenderung nach einstellungen.yaml; bis zur Antwort gilt sie schon, ein Fehler nimmt sie zurueck. */
  function speichereEinstellungen(aenderung) {
    var vorher = EINST;
    EINST = { vorlesen: "vorlesen" in aenderung ? aenderung.vorlesen : EINST.vorlesen, stimme: "stimme" in aenderung ? aenderung.stimme : EINST.stimme };
    einstFehler = "";
    zeichneEinstellungen();
    return fetch("/api/einstellungen", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(aenderung) }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (b) {
        if (!r.ok) throw new Error((b && b.fehler) || "HTTP " + r.status);
        EINST = { vorlesen: b.vorlesen === true, stimme: typeof b.stimme === "string" ? b.stimme : null };
      });
    }).catch(function (err) {
      EINST = vorher;
      einstFehler = "Nicht gespeichert: " + err.message;
    }).then(zeichneEinstellungen);
  }
  function lauscheAnsagen() {
    if (!G.EventSource) return;
    var quelle = new EventSource("/api/ereignisse");
    quelle.addEventListener("geaendert", function () { ladeAnsagen(); ladeEinstellungen(); });
    quelle.onerror = function () {
      quelle.close();
      setTimeout(function () { ladeAnsagen(); ladeEinstellungen(); lauscheAnsagen(); }, 3000);
    };
  }
  /** Ein Klick auf Einstellungen oder einen Abspielknopf; true, wenn er ihnen galt. */
  function ansageKlick(e) {
    var t = e.target.closest && e.target.closest("[data-einst-auf], [data-ansage-auto], [data-ansage-letzte], [data-ansage]");
    if (!t) return false;
    if (t.hasAttribute("data-einst-auf")) {
      einstAuf = !einstAuf;
      zeichneEinstellungen();
      var wieder = wurzel.querySelector("[data-einst-auf]");
      if (wieder) wieder.focus();
    } else if (t.hasAttribute("data-ansage-auto")) {
      var an = !EINST.vorlesen;
      if (an) tonFreischalten(SPRACHE, G.SpeechSynthesisUtterance);
      else if (SPRACHE) SPRACHE.cancel();
      speichereEinstellungen({ vorlesen: an });
    } else if (t.hasAttribute("data-ansage-letzte")) sprich(ANSAGEN[0], true);
    else {
      var zeit = Number(t.getAttribute("data-ansage"));
      sprich(ANSAGEN.find(function (a) { return a.zeit === zeit; }), true);
    }
    return true;
  }
  /** Der erste Klick oder Tastendruck der Seite gibt die Sprachausgabe stumm frei; der Hinweis geht danach weg. */
  function ansageFreigeben() {
    if (ansageFrei) return;
    tonFreischalten(SPRACHE, G.SpeechSynthesisUtterance);
    ansageFrei = true;
    // Erst nach dem Klick neu zeichnen, sonst ersetzte das Neuzeichnen den Knopf, bevor der Klick ihn erreicht.
    if (wurzel.querySelector(".lp-einst .an-hinweis")) setTimeout(zeichneEinstellungen, 0);
  }
  /** Laden, lauschen und die Freigabe der Sprachausgabe, gleich auf der Uebersicht und auf jeder Sitzungsseite. */
  function startAnsagen() {
    ladeAnsagen();
    ladeEinstellungen();
    lauscheAnsagen();
    doc.addEventListener("click", ansageFreigeben, true);
    doc.addEventListener("keydown", ansageFreigeben, true);
    doc.addEventListener("keydown", function (e) {
      if (e.key !== "Escape" || !einstAuf) return;
      einstAuf = false;
      zeichneEinstellungen();
    });
    wurzel.addEventListener("change", function (e) {
      if (e.target.matches && e.target.matches("[data-ansage-stimme]")) speichereEinstellungen({ stimme: e.target.value || null });
    });
    // Die Stimmen kommen in Chrome erst nach dem Laden.
    if (SPRACHE && SPRACHE.addEventListener) SPRACHE.addEventListener("voiceschanged", zeichneEinstellungen);
  }

  // --- Liste aller Sitzungen ------------------------------------------------------------------
  var LISTE = null;
  function liste() {
    return fetch("/api/liste", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (daten) {
      LISTE = daten;
      zeichneListe();
    }).catch(function () { /* der naechste Takt versucht es wieder */ });
  }
  function zeichneListe() {
    var daten = LISTE;
    if (!daten) return;
    var letzte = letzteAnsagen(ANSAGEN);
    var zeilen = daten.sitzungen.map(function (e) {
      var href = "/" + encodeURIComponent(e.repo) + "/" + encodeURIComponent(e.slug);
      // S5: eine Sitzung aus dem Register traegt die Marke live (beendet grau), der volle Repo-Pfad steht im title.
      var marke = e.live ? ' <span class="lv-marke' + (e.beendet ? " aus" : "") + '">' + (e.beendet ? "beendet" : "live") + "</span>" : "";
      return '<tr><td title="' + esc(e.pfad || "") + '"><b>' + esc(e.repo) + '</b></td><td class="mono"><a href="' + esc(href) + '">' + esc(e.slug) + "</a>" + marke + "</td><td>" + esc(e.titel) +
        "</td>" + fragenZelle(e.offeneFragen, href) + ansageZelle(letzte[e.repo + "\u0000" + e.slug]) + '<td class="mono klein">' + zeitAngabe(e.geaendert) + "</td></tr>";
    }).join("");
    doc.title = "Sitzungen · live-plan";
    // Das Menue bleibt beim Neuzeichnen der Liste derselbe Knoten (offene Stimmenwahl, Fokus).
    var menue = wurzel.querySelector(".lp-einst");
    wurzel.innerHTML = '<header class="lp-kopf"><div class="lp-oben"><h1>Sitzungen</h1>' + (menue ? "<div data-einst-platz></div>" : einstellungenMenue(einstellungenZustand())) + themaSchalter() + "</div>" +
      '<p class="lp-ziel">Lebende Dokumente aus <span class="mono">REPO/.live-plan/SLUG.yaml</span> unter <span class="mono">' + esc(daten.wurzel) + "</span> und laufende Claude-Sitzungen aus dem Register</p></header>" + hostTeil(hostAuf) +
      '<table class="lp-liste" data-testid="tabelle-sitzungen"><thead><tr><th>repo</th><th>sitzung</th><th>titel</th><th>fragen</th><th>ansage</th><th>geaendert</th></tr></thead><tbody>' +
      (zeilen || '<tr><td colspan="6" class="leer">Keine Sitzung. <span class="mono">live-plan neu SLUG</span> legt eine an.</td></tr>') + "</tbody></table>";
    var platz = wurzel.querySelector("[data-einst-platz]");
    if (platz) platz.replaceWith(menue);
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

  // toggle steigt nicht auf, wird aber in der Erfassung gesehen.
  wurzel.addEventListener("toggle", function (e) { if (e.target.classList && e.target.classList.contains("hw-details")) hostAuf = e.target.open; }, true);
  if (!API) {
    liste();
    setInterval(liste, 15000);
    startAnsagen();
    hostTaktObj = sichtbarTakt(doc, HOST_TAKT_MS, ladeHost);
    hostTaktObj.start();
    return;
  }
  laden();
  // Das Handout (?handout=1) bleibt ohne Ansagen: es zeigt nur den Inhalt, und die Leiste gehoert nicht ins Bild.
  if (handout) return;
  startAnsagen();
  ladeBaum();
  lausche();
  ladeAbo();
  setInterval(ladeAbo, ABO_TAKT_MS);
  fmUhr = setInterval(ladeFirstmate, FM_TAKT_MS);
  ladeFirstmate();
  hostTaktObj = sichtbarTakt(doc, HOST_TAKT_MS, ladeHost);
  hostTaktObj.start();
})();
