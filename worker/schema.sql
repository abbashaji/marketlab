CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  experiment TEXT NOT NULL,
  visitor TEXT NOT NULL,
  type TEXT NOT NULL,
  kind TEXT,
  source TEXT,
  payload TEXT,
  success INTEGER NOT NULL DEFAULT 0,
  ts INTEGER NOT NULL,
  day TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_day ON events (day);
CREATE INDEX IF NOT EXISTS idx_events_visitor ON events (visitor, day);
CREATE INDEX IF NOT EXISTS idx_events_created ON events (created);
