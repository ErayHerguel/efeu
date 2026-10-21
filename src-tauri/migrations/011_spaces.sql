-- Bereiche und Kategorien in der Seitenleiste (wie Kanäle bei Discord).
-- Bereich einer Seite: der ihrer obersten Seite. 'team' sehen alle im Team, 'private' nur man selbst
-- (auf allen eigenen Geräten), 'local' verlässt den Computer nie. Ohne Cloud spielt der Bereich keine Rolle.
ALTER TABLE pages ADD COLUMN space TEXT NOT NULL DEFAULT 'private' CHECK (space IN ('team', 'private', 'local'));
-- Kategorie einer obersten Seite (bei Unterseiten ohne Bedeutung). Ohne Fremdschlüssel: eine gelöschte
-- Kategorie lässt ihre Seiten einfach unkategorisiert zurück.
ALTER TABLE pages ADD COLUMN category_id TEXT;
-- Wer zuletzt etwas geändert hat (Mitglied der Cloud), für „Zuletzt bearbeitet von …“.
ALTER TABLE pages ADD COLUMN updated_by TEXT;

CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  space TEXT NOT NULL DEFAULT 'private' CHECK (space IN ('team', 'private', 'local')),
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
