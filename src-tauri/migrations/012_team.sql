-- Team-Mitglieder der eigenen Cloud: eingeladene Personen mit eigenem Zugang, die den ganzen
-- Team-Bereich sehen und bearbeiten (Gäste dagegen nur einzelne freigegebene Seiten).
ALTER TABLE share_members ADD COLUMN team_role TEXT CHECK (team_role IN ('member'));
