-- Lernstand der Karteikarten (die Karten selbst stehen in den Seiten: „Frage :: Antwort“ oder Toggle).
-- card_id ist ein Hash aus Seite und Frage. Persönlich: geht auf die eigenen Geräte, nie ans Team.
CREATE TABLE card_reviews (
  card_id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  due INTEGER NOT NULL,
  interval REAL NOT NULL DEFAULT 0,
  ease REAL NOT NULL DEFAULT 2.5,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX card_reviews_page ON card_reviews(page_id);
