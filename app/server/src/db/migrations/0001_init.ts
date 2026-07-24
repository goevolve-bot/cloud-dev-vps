// Initial schema: `.pm/` cache tables (projects, tasks, comments, task_runs)
// plus runtime-only tables (runs, questions). See the Data model section of
// docs/pm-system-plan.md for what each table is for.
export const version = 1;
export const name = "init";

export const up = `
CREATE TABLE projects (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL UNIQUE,
  git_url           TEXT NOT NULL,
  repo_dir          TEXT,
  runner_socket     TEXT,
  default_provider  TEXT,
  default_model     TEXT,
  contract_json     TEXT,
  lifecycle         TEXT NOT NULL DEFAULT 'stopped',
  always_on         INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE tasks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_num      INTEGER NOT NULL,
  slug          TEXT NOT NULL,
  status        TEXT NOT NULL,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  branch        TEXT,
  path          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (project_id, task_num)
);
CREATE INDEX idx_tasks_project_status ON tasks (project_id, status);

CREATE TABLE comments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_num      INTEGER NOT NULL,
  comment_num   INTEGER NOT NULL,
  author        TEXT,
  body          TEXT NOT NULL,
  path          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  UNIQUE (project_id, task_num, comment_num)
);
CREATE INDEX idx_comments_project_task ON comments (project_id, task_num);

-- Cache of .pm/tasks/*/runs/NNNN.md outcome files. Distinct from the
-- runtime "runs" table below: this is what the repo remembers, rebuildable
-- from the working tree at any time.
CREATE TABLE task_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_num      INTEGER NOT NULL,
  run_num       INTEGER NOT NULL,
  phase         TEXT NOT NULL,
  provider      TEXT,
  model         TEXT,
  status        TEXT,
  cost_usd      REAL,
  tokens_in     INTEGER,
  tokens_out    INTEGER,
  started_at    TEXT,
  finished_at   TEXT,
  outcome       TEXT NOT NULL DEFAULT '',
  path          TEXT NOT NULL,
  UNIQUE (project_id, task_num, run_num)
);
CREATE INDEX idx_task_runs_project_task ON task_runs (project_id, task_num);

-- Runtime-only: the live queue and in-flight run state. Never written to
-- .pm/ directly; a finished run's durable record lands in task_runs via the
-- indexer once pm writes the outcome markdown.
CREATE TABLE runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_num        INTEGER NOT NULL,
  phase           TEXT NOT NULL,
  provider        TEXT NOT NULL,
  model           TEXT NOT NULL,
  prompt          TEXT,
  status          TEXT NOT NULL DEFAULT 'queued',
  exit_code       INTEGER,
  log_path        TEXT,
  artifacts_dir   TEXT,
  cost_usd        REAL,
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  created_at      TEXT NOT NULL,
  started_at      TEXT,
  finished_at     TEXT
);
CREATE INDEX idx_runs_project_status ON runs (project_id, status);
CREATE INDEX idx_runs_project_task ON runs (project_id, task_num);

CREATE TABLE questions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_num      INTEGER NOT NULL,
  run_id        INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  text          TEXT NOT NULL,
  answer        TEXT,
  answered_at   TEXT
);
CREATE INDEX idx_questions_run ON questions (run_id);
`;

export const down = `
DROP TABLE IF EXISTS questions;
DROP TABLE IF EXISTS runs;
DROP TABLE IF EXISTS task_runs;
DROP TABLE IF EXISTS comments;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS projects;
`;
