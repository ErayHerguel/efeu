# flou

Lokale Notizen und Datenbanken für macOS (Apple Silicon und Intel) und Windows: schnell, tastaturfreundlich, offline.
Kein Konto, kein Cloud-Server, keine Telemetrie. Alle Daten liegen auf deinem Computer – auch wenn du mit anderen zusammenarbeitest.

## Funktionen

- **Seiten** in beliebiger Verschachtelung, Drag-and-drop in der Seitenleiste (Seiten lassen sich auch in Datenbanken ziehen), Papierkorb mit Wiederherstellen
- **Block-Editor**: jeder Block per Greifer verschiebbar (auch in Spalten, Toggles und Callouts); Absatz, Überschriften, Listen, To-dos, Toggle, Zitat, Callout, Code mit Syntax-Highlighting, Trenner, Tabellen, 2/3 Spalten, Bilder mit Unterschrift, Dateianhänge (Audio/Video spielen direkt), Unterseiten, eingebettete Datenbanken
- **Boards** wie in FigJam (`⌥⌘B` oder `/board`): unendliche Fläche mit Sticky Notes, Formen, Pfeilen, Freihand, Bildern; eingebettet in Seiten mit Vorschau; Export als PNG/SVG und `.excalidraw` (basiert auf Excalidraw, MIT)
- **Zusammenarbeiten** (Seitenleiste „Teilen“): Personen per Link zu einzelnen Seiten, Boards oder Datenbanken einladen, mit Lese- oder Schreibrecht. Gemeinsames Bearbeiten live mit Cursorn, im Browser oder in der eigenen flou-App. Dein Computer ist der Server (siehe unten)
- **flou auf dem iPhone** (Einstellungen → Meine Geräte → „iPhone verbinden“): QR-Code scannen, zum Home-Bildschirm hinzufügen, fertig. Der ganze Workspace live, ohne App Store, solange flou auf dem Computer läuft
- **Einstellungen** (`⌘,`): Design, KI, Teilen, Geräte, Daten und Backups, Updates
- **KI mit eigenem Schlüssel** (Einstellungen → KI, Claude von Anthropic), alles nur auf Abruf:
  - **KI-Leiste** (`⌘J` oder Knopf „KI“ oben): Anweisung eintippen, optional PDF oder Seite anhängen. Claude bearbeitet die **Seite** Block für Block (Bilder, Datenbanken, Boards und Kommentare bleiben geschützt), das **Board** (Post-its ändern, umfärben, löschen, passend in Gruppen ergänzen, neue Matrix/Cluster/Abläufe) oder die **Datenbank** (Einträge aus PDF oder Text anlegen, Spalten füllen und vereinheitlichen). Vorher eine Vorschau „geändert / neu / gelöscht“ mit Übernehmen, Verwerfen oder Verfeinern; mit `⌘Z` rückgängig. PDF → neue Notiz per Schalter „Neue Seite“
  - **Text markieren → „KI“**: verbessern, kürzen, ausführlicher, einfacher, Ton, übersetzen, erklären oder eigene Anweisung, mit Vorschau
  - `/zusammenfassen`, `/aufgaben`, `/weiterschreiben`; Board als Seite zusammenfassen; markierte Post-its clustern; Titel und Icon vorschlagen (Seitenmenü)
  - **Frag flou** (`⇧⌘J`): Antworten aus deinen Seiten mit Seitenlinks; **Recherche** mit Websuche als Seite mit Quellen
  - **Kosten im Blick**: vor jeder Aktion die Schätzung für Opus, Sonnet und Haiku, danach die echten Kosten; Übersicht heute/Monat nach Funktion und Modell; optionales Monatsbudget. Der Schlüssel liegt im Schlüsselbund, nie in der Datenbank; ohne Schlüssel bleibt flou offline
- **Schnellnotiz von überall** (`⌃⌥N`, auch wenn flou im Hintergrund ist): kleines Fenster, `⌘↩` legt die Notiz in den „Eingang“ (erste Zeile = Titel)
- **Heute** (`⇧⌘D`): Tagesnotiz mit Datum unter „Tagesnotizen“; mit eigener Vorlage „Tagesnotiz“ anpassbar
- **Vorlagen** (`⌘K` → „Neu aus Vorlage“ oder `/vorlage`): Meeting-Notizen, Projekt, Wochenplan, Tagesnotiz, Aufgaben- und Lese-Datenbank; jede Seite unter „Vorlagen“ ist eine Vorlage, „Als Vorlage speichern“ im Seitenmenü
- **Duplizieren** (Seitenmenü oder Seitenleiste): Kopie samt Unterseiten, Datenbank-Einträgen und Boards
- **Menüleisten-Symbol**: Schnellnotiz und Öffnen von dort; schließt du das Fenster, während geteilt wird, läuft flou im Hintergrund weiter
- **Kommentare** an Textstellen (`⇧⌘M`) und **Versionsverlauf** je Seite (eine Version je 10 Minuten, die letzten 50)
- **Slash-Menü** (`/`) mit Fuzzy-Suche, **Markdown-Shortcuts** beim Tippen, schwebende Formatierungsleiste
- **Seitenlinks** mit `[[` und Backlinks am Seitenende
- **Datenbanken** mit Text, Zahl, Auswahl, Mehrfachauswahl, Datum, Checkbox, URL, Relation, Rollup und Formel. Ansichten: Tabelle, Kanban-Board, Kalender, Galerie, Liste; Filter (UND/ODER), Sortierung und Spaltenbreiten pro Ansicht; Werte sind durchsuchbar
- **Befehlspalette** (`⌘K`) und **Volltextsuche** (SQLite FTS5)
- **Vorlesung mitschreiben** (Mikrofon-Knopf oben, `/vorlesung` oder `⌘K`): flou hört mit, erkennt die Sprache lokal mit Whisper (Open Source, einmaliger Download, danach offline) und schreibt alle paar Minuten Stichpunkte in die Seite; am Ende eine Zusammenfassung mit Begriffen, Klausurrelevantem, Aufgaben und offenen Fragen, optional abgeglichen mit den Folien (PDF). Läuft im Hintergrund weiter, auch bei geschlossenem Fenster (Menüleiste „● Mitschrift“). Der Ton wird nie gespeichert. Live-Notizen mit Claude Haiku kosten etwa 1 Cent pro Stunde; ohne KI wächst die Mitschrift selbst in der Seite
- **Titelbilder** aus Unsplash (Suche in Millionen freien Fotos, mit eigenem kostenlosem Zugangsschlüssel; das Foto wird lokal gespeichert, der Fotograf am Bild genannt), Farbverläufen oder eigenen Bildern
- **Icons**: alle Emojis mit deutscher Suche, Kategorien, Hautfarbe und „Zuletzt benutzt“
- **Startseite** und **Favoriten**, Seitenbaum per Tastatur (`⇧⌘L`, dann Pfeiltasten, Enter, F2)
- **Teilen**: Drucken bzw. „Als PDF sichern“ (`⌘P`), Seite als Markdown kopieren (`⇧⌘C`)
- **Markdown-Export und -Import** (einzelne Seiten, ganzer Workspace, Ordner)
- **Umzug aus Notion** (`⌘K` → „Aus Notion importieren“): Export „Markdown & CSV“ entpacken, Ordner wählen; Seiten, Bilder und Datenbanken samt Einträgen und Feldtypen kommen mit
- **Erinnerungen**: Datums-Properties mit „Am Tag erinnern“ (im Menü der Property) melden sich am fälligen Tag ab 9 Uhr in flou, das Dock-Symbol hüpft; unter Windows zusätzlich als Mitteilung. (System-Mitteilungen auf dem Mac erlaubt Apple nur kostenpflichtig signierten Apps.)
- **Automatisches Backup**: täglich, die letzten 7 bleiben erhalten
- Helles, dunkles und System-Theme; Autosave ohne Speichern-Knopf

## Voraussetzungen

- macOS 13 oder neuer auf Apple Silicon
- Xcode Command Line Tools: `xcode-select --install`
- Rust (stable) über [rustup](https://rustup.rs) mit dem Ziel `aarch64-apple-darwin`
- Node.js 20 oder neuer und npm

Die npm-Skripte ergänzen `~/.cargo/bin` automatisch im `PATH`. Rust muss also nicht global im Terminal eingerichtet sein.

## Entwicklung

```bash
npm install
npm run tauri dev
```

Das startet Vite auf Port 1420 und die App mit Hot Reload.

Tests und Prüfungen:

```bash
npm test             # Vitest: Logik, Datenbank (echtes SQLite), Editor, Performance
npm run cargo-test   # Rust-Tests (Export-Pfade, Import, Backup-Rotation)
npm run build        # TypeScript-Prüfung und Frontend-Build
npm run cargo-check  # Rust-Prüfung
npm run licenses     # Lizenzen aller ausgelieferten Pakete prüfen
```

## Bauen

```bash
npm run build:mac
```

Das ist `npm run tauri build` für `aarch64-apple-darwin` (schnell, für den eigenen Mac). Die veröffentlichten Releases baut GitHub als Universal-App für Apple Silicon und Intel (`npm run build:mac:universal`, braucht zusätzlich das Rust-Ziel `x86_64-apple-darwin`). Ergebnis:

- App: `src-tauri/target.noindex/aarch64-apple-darwin/release/bundle/macos/flou.app`
- DMG: `src-tauri/target.noindex/aarch64-apple-darwin/release/bundle/dmg/flou_1.0.0_aarch64.dmg`

Die App ist ad-hoc signiert, nicht mit einer Apple-Developer-ID. Beim DMG-Bau ordnet macOS das Fenster über den Finder an; beim ersten Mal kann dafür eine Rückfrage zur Finder-Steuerung erscheinen.

Smoke-Test des fertigen Builds (Bundle-ID, Architektur, Signatur, Start, Migrationen, Volltextsuche, Kaltstartzeit; läuft mit einem temporären Datenordner):

```bash
npm run smoke
```

## Windows

- Installer: `flou-setup.exe` (NSIS, ohne Administratorrechte, Eintrag im Startmenü, Deinstallation über die Windows-Einstellungen).
- Gebaut wird er automatisch vom Release-Workflow auf einem Windows-Runner, oder lokal auf einem Windows-PC mit `npm run build:win` (Ergebnis unter `src-tauri/target.noindex/release/bundle/nsis/`).
- Daten liegen unter `%APPDATA%\app.flou.desktop`. Kürzel nutzen Strg statt ⌘.
- Ohne kostenpflichtiges Code-Signing zeigt Windows beim ersten Start „Der Computer wurde durch Windows geschützt“ → „Weitere Informationen“ → „Trotzdem ausführen“.

## Installieren

```bash
npm run install-mac
```

Kopiert `flou.app` nach `/Applications` und entfernt das Quarantäne-Flag (`xattr -cr`). Danach startet die App per Doppelklick ohne Gatekeeper-Warnung. Läuft flou gerade, bricht das Skript ab, damit nichts verloren geht.

Alternativ das DMG öffnen und flou in den Programme-Ordner ziehen. Weil die App nicht notariell beglaubigt ist, braucht es dann einmalig Rechtsklick → Öffnen, oder:

```bash
xattr -cr /Applications/flou.app
```

## Veröffentlichen (GitHub)

- `website/`: Webseite mit Download und Installationsanleitung, wird per GitHub Pages veröffentlicht (`.github/workflows/pages.yml`).
- `.github/workflows/release.yml`: baut bei jedem Tag `v*` die App auf einem Mac- und einem Windows-Runner und veröffentlicht `flou.dmg`, `flou-setup.exe`, die versionierten Dateien und `install.sh` als GitHub-Release.
- Installation für Nutzer ohne Gatekeeper-Warnung: `curl -fsSL https://github.com/<user>/<repo>/releases/latest/download/install.sh | bash`

Neue Version:

```bash
npm run version:set -- 1.0.1
git commit -am "Version 1.0.1" && git tag v1.0.1 && git push && git push --tags
```

## Updates

- Beim Start prüft flou im Hintergrund auf eine neue Version und zeigt pro Version einmal einen Hinweis mit „Aktualisieren“ (lädt, installiert, startet neu) oder „Später“. Manuell: „Nach Updates suchen …“.
- Update-Pakete sind mit einem eigenen Schlüssel signiert (Tauri-Updater). Der private Schlüssel liegt lokal unter `~/.tauri/flou.key` und als GitHub-Secret `TAURI_SIGNING_PRIVATE_KEY`. **Diesen Schlüssel sichern:** Ohne ihn können installierte Versionen keine Updates mehr annehmen.
- Der öffentliche Schlüssel steht in `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`).

## Datenordner

```
~/Library/Application Support/app.flou.desktop/
├── flou.db          SQLite-Datenbank (WAL-Modus): Seiten, Inhalte, Datenbanken, Einstellungen
├── flou.db-wal/-shm Schreibprotokoll von SQLite, gehört zur Datenbank
├── assets/          Bilder und Anhänge, benannt nach ihrem Inhalts-Hash
├── backups/         tägliche Backups, je ein Ordner pro Tag (höchstens 7)
└── bin/             cloudflared, sobald du zum ersten Mal teilst
```

In der App: Menü „Hilfe → Datenordner im Finder zeigen“.

Alle Schreibvorgänge laufen in Transaktionen. Schlägt ein Speichern fehl, bleiben die Änderungen in der Warteschlange und werden erneut versucht. Beim Beenden wird gewartet, bis alles geschrieben ist.

## Backup und Restore

**Automatisch:** Kurz nach dem Start und danach stündlich prüft flou, ob es für heute schon ein Backup gibt. Falls nicht, entsteht `backups/JJJJ-MM-TT/` mit einer konsistenten Kopie der Datenbank (`VACUUM INTO`) und den Bildern. Es bleiben immer die 7 neuesten Backups erhalten.

**Manuell:** Befehlspalette (`⌘K`) → „Backup jetzt erstellen“ oder Menü „Hilfe → Backup jetzt erstellen“.

**Wiederherstellen:**

1. flou beenden (`⌘Q`).
2. Den aktuellen Stand sichern:
   ```bash
   cd ~/Library/Application\ Support/app.flou.desktop
   mkdir -p ~/Desktop/flou-vorher && cp -R flou.db* assets ~/Desktop/flou-vorher/
   ```
3. Das gewünschte Backup zurückkopieren (Datum anpassen):
   ```bash
   cd ~/Library/Application\ Support/app.flou.desktop
   rm -f flou.db-wal flou.db-shm
   cp backups/2026-10-06/flou.db flou.db
   cp -R backups/2026-10-06/assets/. assets/
   ```
4. flou starten.

Zusätzlich bietet der Markdown-Export (`⇧⌘E` für eine Seite, „Workspace als Markdown exportieren …“ für alles) eine lesbare Kopie unabhängig von flou.

## Tastenkürzel (Auswahl)

| Aktion | Kürzel |
| --- | --- |
| Befehlspalette | `⌘K` |
| Volltextsuche | `⇧⌘F` |
| Neue Seite / Unterseite / Datenbank | `⌘N` / `⇧⌘N` / `⌥⌘N` |
| Seitenleiste | `⌘\` |
| Seite umbenennen | `⇧⌘R` |
| In den Papierkorb | `⇧⌘⌫` |
| Zurück / Vorwärts | `⌘[` / `⌘]` |
| Block verschieben | `⇧⌘↑` / `⇧⌘↓` |
| Link setzen | `⇧⌘K` |
| Seite exportieren | `⇧⌘E` |
| Drucken / PDF | `⌘P` |
| Als Markdown kopieren | `⇧⌘C` |
| Startseite | `⇧⌘O` |
| Favorit an/aus | `⌥⌘S` |
| Kommentar | `⇧⌘M` |
| Alle Kürzel | `⌘/` |

## Umbenennen

Der Name steht an drei Stellen:

- `src/app.config.ts` (`APP_NAME`, Datenbankname)
- `src-tauri/tauri.conf.json` (`productName`, `identifier`, Fenstertitel)
- `src-tauri/src/paths.rs` (Datenbankdatei)

Das Logo entsteht aus `scripts/make-icon.mjs`; `npm run icons` erzeugt alle Icon-Größen neu.

## Projektstruktur

```
src/                 React-Frontend
  db/                Datenzugriff: Treiber, Repositories, Speicher-Warteschlange, Suche
  store/             Zustand-Stores (Seiten, Datenbanken, Oberfläche)
  editor/            TipTap-Editor, eigene Blöcke, Slash-Menü, Greifer
  features/          Seitenleiste, Seitenansicht, Datenbanken, Boards, Palette, Export/Import
  features/collab/   Zusammenarbeit: Rechte, Protokoll, Gastgeber-Hub (host/), Gast-Oberfläche (guest/)
  lib/               Baumlogik, Fuzzy-Suche, Markdown
src-tauri/           Rust-Shell
  migrations/        SQL-Migrationen
  src/               Transaktionen, Bilder, Backups, Export/Import, Freigabe-Server und Tunnel (share/)
scripts/             Icon, Installation, Smoke-Test, Lizenzprüfung
brand/               Logo (SVG)
```

## Zusammenarbeiten

1. Seitenleiste unten „Teilen“ (oder `⌘K` → „Teilen und Zusammenarbeiten“) → **Teilen starten**.
2. Person einladen (Name eingeben). Auf einer Seite oben rechts **Teilen** wählen und der Person „Kann lesen“ oder „Kann bearbeiten“ geben. Unterseiten und Datenbank-Einträge erben das Recht; „Kein Zugriff“ nimmt einen Teilbaum wieder aus.
3. **Link kopieren** und schicken. Die Person öffnet ihn im Browser oder in flou über `⌘K` → „Geteilten Workspace öffnen“.

So funktioniert es:

- flou startet einen kleinen Server nur auf diesem Computer (127.0.0.1) und macht ihn über einen **Cloudflare Quick Tunnel** erreichbar (`https://….trycloudflare.com`): kostenlos, ohne Konto, verschlüsselt. Das Programm dafür (`cloudflared`, Apache-2.0) lädt flou beim ersten Teilen einmalig von GitHub, prüft die SHA-256-Prüfsumme und legt es im Datenordner unter `bin/` ab.
- Alle Daten bleiben in deiner Datenbank. Gäste sehen nur, was freigegeben ist; jede Änderung wird bei dir gegen die Rechte geprüft.
- Seiten werden mit Yjs (CRDT) gemeinsam bearbeitet, Boards Element für Element abgeglichen, Datenbanken über deine App geändert. Gespeichert wird wie gewohnt in deiner Datenbank, inklusive Versionsverlauf.
- Die Adresse ist bei jedem Start eine neue (Eigenschaft der Quick Tunnels). Solange flou geöffnet ist und das Teilen läuft, können Eingeladene mitarbeiten. Neue Links bekommst du im Teilen-Dialog.
- Einladungslinks enthalten einen geheimen Schlüssel (256 Bit) hinter `#join=`; er wird nicht an Server übertragen, nur gegen ein Sitzungs-Cookie getauscht. „Entfernen“ macht den Link ungültig und trennt die Person sofort.

## flou auf dem iPhone

1. `⌘,` → **Meine Geräte** → **iPhone verbinden**. flou startet das Teilen und zeigt einen QR-Code.
2. Mit der iPhone-Kamera scannen, in Safari **Teilen → „Zum Home-Bildschirm“**.
3. Fertig: Das Symbol öffnet deinen kompletten Workspace (alle Seiten, Boards, Datenbanken), live abgeglichen mit dem Computer. Eigene Geräte dürfen alles, auch Seiten auf oberster Ebene anlegen.

So funktioniert es: Das iPhone nutzt flou im Browser, eine App aus dem App Store ist nicht nötig (die gäbe es nur mit kostenpflichtigem Apple-Entwicklerkonto). Weil sich die Tunnel-Adresse bei jedem Start ändert, öffnet das Symbol zuerst eine kleine Startseite auf der flou-Website (`/app/`). Sie fragt beim kostenlosen Dienst [ntfy.sh](https://ntfy.sh) unter einem geheimen Kanalnamen die aktuelle Adresse ab, prüft, ob der Computer erreichbar ist, und leitet weiter. Bei ntfy.sh liegt nur die Adresse, nie der Zugangsschlüssel; Kanal und Schlüssel stehen im Fragment (`#…`) des Links, das Browser nicht an Server senden. Geräte lassen sich unter „Meine Geräte“ jederzeit entfernen.

Damit das iPhone immer verbunden ist: unter **Teilen** „Beim Start von flou automatisch teilen“ und „Computer wach halten, solange geteilt wird“ einschalten. Ohne laufenden Computer (oder mit zugeklapptem Laptop) zeigt das iPhone „Computer nicht erreichbar“ und verbindet sich von selbst, sobald er wieder da ist.

## Formeln

Formel-Properties rechnen pro Eintrag, z. B. `prop("Preis") * prop("Menge")` oder `if(prop("Status") == "Erledigt", "✓", "")`. Verfügbar: `+ - * / % ^`, Vergleiche, `&& || !`, sowie `if, concat, length, lower, upper, contains, empty, round, floor, ceil, abs, sqrt, min, max, toNumber, format, today, dateAdd, dateBetween`.

## Bewusst nicht enthalten

- Notarisierung durch Apple (braucht ein kostenpflichtiges Entwicklerkonto)
- Mehrere Fenster für denselben eigenen Workspace (geteilte Workspaces anderer öffnen sich dagegen in eigenen Fenstern)
- Eine feste Adresse fürs Teilen (bräuchte ein Konto bei einem Tunnel-Anbieter oder eine eigene Domain)

## Datenschutz und Netzwerk

flou macht zur Laufzeit keine Netzwerkanfragen außer der Update-Prüfung: Beim Start fragt die App einmal `latest.json` des neuesten GitHub-Releases ab (nur Versionsnummer, keine Nutzerdaten). Abschaltbar über die Befehlspalette („Automatische Update-Suche an/aus“). Nur wenn du ausdrücklich „Teilen starten“ wählst, lädt flou einmalig cloudflared von GitHub und baut den Tunnel zu Cloudflare auf; beim Beenden des Teilens oder der App wird er geschlossen. Gibt es gekoppelte eigene Geräte, meldet flou während des Teilens zusätzlich die aktuelle Tunnel-Adresse an ntfy.sh (siehe „flou auf dem iPhone“). Für die Mitschrift lädt flou einmalig das Whisper-Sprachmodell von Hugging Face; Ton verlässt den Computer nie, er wird im Arbeitsspeicher erkannt und verworfen. Hinterlegst du einen API-Schlüssel für die KI, sendet flou nur dann eine Anfrage an api.anthropic.com, wenn du eine KI-Aktion startest; mit ihr gehen genau die Inhalte, die die Aktion braucht (markierter Text, die Seite, die gewählte PDF, bei „Frag flou“ die passendsten Seiten). Der Schlüssel liegt im Schlüsselbund des Systems, Gäste und verbundene Geräte können die KI nicht nutzen. In der Datenbank landen nur Token-Zahlen und Kosten für die Übersicht. Die Content-Security-Policy erlaubt nur lokale Ressourcen. Externe Bilder in eingefügtem HTML werden nicht übernommen, Schriften sind eingebunden. Links öffnen sich nur auf ausdrücklichen ⌘-Klick im Standardbrowser.

## Lizenzen der Abhängigkeiten

`npm run licenses` prüft alle ausgelieferten npm-Pakete und Rust-Crates. Fast alles steht unter MIT, Apache-2.0, MPL-2.0 oder BSD. Ausnahmen, alle freizügig und kostenlos:

- **Inter**: SIL Open Font License
- **lucide-react**: ISC
- **tslib**: 0BSD
- Einige Crates, die Tauri selbst mitbringt (ICU, zlib-rs, foldhash): Unicode-3.0 bzw. Zlib

`argparse` (PSF-2.0) wird nur vom Kommandozeilen-Werkzeug von markdown-it genutzt und landet nicht im App-Bundle; der Lizenz-Check prüft das am Build.
