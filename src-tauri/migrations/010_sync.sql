-- Abgleich mit der eigenen Cloud. Die Tabellen bleiben leer, solange keine Cloud eingerichtet ist:
-- Die Trigger, die Änderungen erfassen, legt die App erst beim Einrichten an (src/sync/capture.ts).

-- Hybride Uhr dieses Geräts. Zeitstempel sind 'ms-gerät' und lassen sich als Text vergleichen.
CREATE TABLE sync_clock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  device TEXT NOT NULL,
  ms INTEGER NOT NULL DEFAULT 0,
  -- 1, während Änderungen aus der Cloud übernommen werden (die Trigger erfassen dann nichts)
  applying INTEGER NOT NULL DEFAULT 0
);

-- Lokale Änderungen, die noch nicht in der Cloud angekommen sind.
-- kind 'row': cols enthält die geänderten Spalten (NULL = Zeile gelöscht).
-- kind 'doc'/'board': Seiteninhalt bzw. Board hat sich geändert, Details stehen in der Tabelle selbst.
CREATE TABLE sync_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'row' CHECK (kind IN ('row', 'doc', 'board')),
  tbl TEXT NOT NULL,
  pk TEXT NOT NULL,
  cols TEXT,
  hlc TEXT NOT NULL
);

-- Zeitstempel der letzten Änderung je Spalte (col '' = Zeile gelöscht). Neuere Änderung gewinnt.
CREATE TABLE sync_meta (
  tbl TEXT NOT NULL,
  pk TEXT NOT NULL,
  col TEXT NOT NULL,
  hlc TEXT NOT NULL,
  PRIMARY KEY (tbl, pk, col)
) WITHOUT ROWID;

-- Yjs-Zustand je Seite (zeichengenaues Zusammenführen) und was die Cloud davon schon hat.
CREATE TABLE sync_docs (
  page_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  acked TEXT NOT NULL DEFAULT ''
);

-- Versionen der Board-Elemente, die die Cloud schon hat (Element-ID → Version), und Hintergrund-Zeitstempel.
CREATE TABLE sync_boards (
  page_id TEXT PRIMARY KEY,
  acked TEXT NOT NULL DEFAULT '{}',
  background_hlc TEXT NOT NULL DEFAULT ''
);

-- Verbindung zur Cloud (Adresse, Stand des Abrufs). Schlüssel liegen im Schlüsselbund, nicht hier.
CREATE TABLE sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
