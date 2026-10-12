-- Bildnachweis für Titelbilder (z. B. von Unsplash), je Asset-Datei.
CREATE TABLE cover_credits (
  asset TEXT PRIMARY KEY,
  author TEXT NOT NULL,
  author_url TEXT NOT NULL,
  source TEXT NOT NULL,
  source_url TEXT NOT NULL
);
