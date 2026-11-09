export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'initial_document_storage',
    sql: `
CREATE TABLE users (
  id uuid PRIMARY KEY,
  login_name text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,
  CONSTRAINT users_login_name_format CHECK (login_name ~ '^[a-z0-9][a-z0-9._-]{2,63}$')
);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspaces_name_length CHECK (char_length(name) BETWEEN 1 AND 200)
);

CREATE TABLE workspace_memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id),
  CONSTRAINT workspace_memberships_role CHECK (role IN ('owner', 'editor', 'viewer'))
);

CREATE INDEX workspace_memberships_user_idx ON workspace_memberships (user_id, workspace_id);

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  csrf_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT sessions_token_hash_length CHECK (octet_length(token_hash) = 32),
  CONSTRAINT sessions_csrf_hash_length CHECK (octet_length(csrf_hash) = 32),
  CONSTRAINT sessions_expiry CHECK (expires_at > created_at)
);

CREATE INDEX sessions_user_active_idx ON sessions (user_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE pages (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  parent_id uuid,
  title text NOT NULL DEFAULT '',
  content_json jsonb NOT NULL,
  content_schema_version integer NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deletion_group_id uuid,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, parent_id) REFERENCES pages (workspace_id, id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT pages_not_own_parent CHECK (parent_id IS DISTINCT FROM id),
  CONSTRAINT pages_title_length CHECK (char_length(title) <= 255),
  CONSTRAINT pages_content_object CHECK (jsonb_typeof(content_json) = 'object'),
  CONSTRAINT pages_schema_version CHECK (content_schema_version >= 1),
  CONSTRAINT pages_revision_positive CHECK (revision > 0),
  CONSTRAINT pages_deletion_pair CHECK ((deleted_at IS NULL) = (deletion_group_id IS NULL))
);

CREATE INDEX pages_active_children_idx ON pages (workspace_id, parent_id, created_at, id)
  WHERE deleted_at IS NULL;
CREATE INDEX pages_deleted_group_idx ON pages (workspace_id, deletion_group_id, id)
  WHERE deleted_at IS NOT NULL;

CREATE TABLE page_mutation_receipts (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  client_mutation_id uuid NOT NULL,
  operation text NOT NULL,
  request_hash bytea NOT NULL,
  page_id uuid,
  response_status smallint NOT NULL,
  response_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, actor_user_id, client_mutation_id),
  CONSTRAINT page_mutation_receipts_hash_length CHECK (octet_length(request_hash) = 32),
  CONSTRAINT page_mutation_receipts_operation_length CHECK (char_length(operation) BETWEEN 1 AND 64),
  CONSTRAINT page_mutation_receipts_success CHECK (response_status BETWEEN 200 AND 299)
);

CREATE INDEX page_mutation_receipts_page_idx ON page_mutation_receipts (workspace_id, page_id, created_at);

CREATE TABLE instance_state (
  singleton boolean PRIMARY KEY DEFAULT true,
  owner_user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  owner_workspace_id uuid NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE RESTRICT,
  initialized_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT instance_state_single_row CHECK (singleton)
);
`,
  },
  {
    version: 2,
    name: 'workspace_attachments',
    sql: `
CREATE TABLE attachments (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  uploader_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  file_name text NOT NULL,
  media_type text NOT NULL,
  byte_size integer NOT NULL,
  sha256 bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  CONSTRAINT attachments_file_name_length CHECK (char_length(file_name) BETWEEN 1 AND 180),
  CONSTRAINT attachments_media_type_length CHECK (char_length(media_type) BETWEEN 1 AND 100),
  CONSTRAINT attachments_size CHECK (byte_size BETWEEN 1 AND 10485760),
  CONSTRAINT attachments_sha256_length CHECK (octet_length(sha256) = 32)
);

CREATE INDEX attachments_workspace_created_idx ON attachments (workspace_id, created_at, id);
`,
  },
  {
    version: 3,
    name: 'page_search_text',
    sql: `
ALTER TABLE pages ADD COLUMN search_text text NOT NULL DEFAULT '';
CREATE INDEX pages_search_active_idx ON pages (workspace_id, updated_at DESC, id)
  WHERE deleted_at IS NULL;
`,
  },
  {
    version: 4,
    name: 'page_version_history',
    sql: `
CREATE TABLE page_versions (
  workspace_id uuid NOT NULL,
  page_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  title text NOT NULL,
  parent_id uuid,
  content_json jsonb NOT NULL,
  content_schema_version integer NOT NULL,
  deleted_at timestamptz,
  saved_at timestamptz NOT NULL,
  actor_user_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  operation text NOT NULL CHECK (operation IN ('baseline', 'create', 'update', 'trash', 'restore', 'restore-version')),
  PRIMARY KEY (workspace_id, page_id, revision),
  FOREIGN KEY (workspace_id, page_id) REFERENCES pages(workspace_id, id) ON DELETE RESTRICT
);

INSERT INTO page_versions (workspace_id, page_id, revision, title, parent_id, content_json,
  content_schema_version, deleted_at, saved_at, actor_user_id, operation)
SELECT workspace_id, id, revision, title, parent_id, content_json,
  content_schema_version, deleted_at, updated_at, NULL, 'baseline' FROM pages;

CREATE INDEX pages_trash_list_idx ON pages (workspace_id, deleted_at DESC, id DESC)
  WHERE deleted_at IS NOT NULL;
`,
  },
  {
    version: 5,
    name: 'account_auth_epoch',
    sql: `
ALTER TABLE users ADD COLUMN auth_epoch bigint NOT NULL DEFAULT 1 CHECK (auth_epoch > 0);
`,
  },
  {
    version: 6,
    name: 'page_appearance_and_favorites',
    sql: `
ALTER TABLE pages ADD COLUMN icon text, ADD COLUMN cover text;
ALTER TABLE pages ADD CONSTRAINT pages_icon_length CHECK (icon IS NULL OR char_length(icon) BETWEEN 1 AND 32);
ALTER TABLE pages ADD CONSTRAINT pages_cover_format CHECK (cover IS NULL OR cover ~ '^[a-z]{1,32}$');
ALTER TABLE page_versions ADD COLUMN icon text, ADD COLUMN cover text;
CREATE TABLE page_favorites (
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  page_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id, page_id),
  FOREIGN KEY (workspace_id, user_id) REFERENCES workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, page_id) REFERENCES pages (workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX page_favorites_user_idx ON page_favorites (workspace_id, user_id, created_at, page_id);
`,
  },
  {
    version: 7,
    name: 'workspace_tags',
    sql: `
CREATE TABLE workspace_tags (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 32),
  name_key text COLLATE "C" NOT NULL,
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT workspace_tags_name_key UNIQUE (workspace_id, name_key)
);
CREATE TABLE page_tags (
  workspace_id uuid NOT NULL,
  page_id uuid NOT NULL,
  tag_id uuid NOT NULL,
  PRIMARY KEY (workspace_id, page_id, tag_id),
  FOREIGN KEY (workspace_id, page_id) REFERENCES pages (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, tag_id) REFERENCES workspace_tags (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX page_tags_tag_idx ON page_tags (workspace_id, tag_id, page_id);
`,
  },
  {
    version: 8,
    name: 'personal_note_templates',
    sql: `
CREATE TABLE note_templates (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  content_json jsonb NOT NULL CHECK (jsonb_typeof(content_json) = 'object'),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, owner_user_id) REFERENCES workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT
);
CREATE INDEX note_templates_owner_idx ON note_templates (workspace_id, owner_user_id, created_at, id);
`,
  },
  {
    version: 9,
    name: 'daily_notes',
    sql: `
ALTER TABLE workspaces
  ADD COLUMN note_time_zone text NOT NULL DEFAULT 'Asia/Shanghai',
  ADD COLUMN daily_parent_id uuid,
  ADD COLUMN daily_template_id text,
  ADD CONSTRAINT workspaces_note_time_zone_length CHECK (char_length(note_time_zone) BETWEEN 1 AND 100),
  ADD CONSTRAINT workspaces_daily_parent_fk FOREIGN KEY (id, daily_parent_id)
    REFERENCES pages(workspace_id, id) ON DELETE RESTRICT;
ALTER TABLE pages ADD COLUMN daily_note_date date;
CREATE UNIQUE INDEX pages_daily_note_identity_idx ON pages (workspace_id, daily_note_date)
  WHERE daily_note_date IS NOT NULL;
`,
  },
  {
    version: 10,
    name: 'page_backlinks',
    sql: `
CREATE TABLE page_links (
  workspace_id uuid NOT NULL,
  source_page_id uuid NOT NULL,
  target_page_id uuid NOT NULL,
  occurrence integer NOT NULL CHECK (occurrence >= 0),
  snippet text NOT NULL CHECK (char_length(snippet) BETWEEN 1 AND 353),
  PRIMARY KEY (workspace_id, source_page_id, occurrence),
  FOREIGN KEY (workspace_id, source_page_id) REFERENCES pages (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, target_page_id) REFERENCES pages (workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX page_links_target_idx ON page_links (workspace_id, target_page_id, source_page_id, occurrence);
`,
  },
  {
    version: 11,
    name: 'compact_page_receipts',
    sql: `
UPDATE page_mutation_receipts r SET response_json = r.response_json - 'content'
FROM page_versions v
WHERE r.operation IN ('create', 'update', 'trash', 'restore', 'restore-version', 'copy', 'open-daily-note', 'quick-capture')
  AND r.response_json ? 'content'
  AND v.workspace_id = r.workspace_id AND v.page_id = r.page_id
  AND v.revision = CASE WHEN r.response_json->>'revision' ~ '^[0-9]+$' THEN (r.response_json->>'revision')::bigint END
  AND v.content_json = r.response_json->'content';
`,
  },
  {
    version: 12,
    name: 'page_sort_position',
    sql: `
CREATE SEQUENCE pages_sort_position_seq;
ALTER TABLE pages ADD COLUMN sort_position bigint;
UPDATE pages p SET sort_position = ranked.position * 1024
FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS position FROM pages) ranked
WHERE ranked.id = p.id;
SELECT setval('pages_sort_position_seq', (SELECT count(*) + 1 FROM pages), false);
ALTER TABLE pages ALTER COLUMN sort_position SET DEFAULT nextval('pages_sort_position_seq') * 1024;
ALTER TABLE pages ALTER COLUMN sort_position SET NOT NULL;
ALTER SEQUENCE pages_sort_position_seq OWNED BY pages.sort_position;
CREATE INDEX pages_sibling_order_idx ON pages (workspace_id, parent_id, sort_position, id) WHERE deleted_at IS NULL;
`,
  },
  {
    version: 13,
    name: 'databases',
    sql: `
ALTER TABLE pages ADD COLUMN kind text NOT NULL DEFAULT 'document';
ALTER TABLE pages ADD COLUMN row_properties jsonb;
ALTER TABLE pages ADD CONSTRAINT pages_kind CHECK (kind IN ('document', 'database', 'row'));
ALTER TABLE pages ADD CONSTRAINT pages_row_properties CHECK (
  (kind = 'row') = (row_properties IS NOT NULL)
  AND (row_properties IS NULL OR jsonb_typeof(row_properties) = 'object'));
ALTER TABLE page_versions ADD COLUMN row_properties jsonb;
ALTER TABLE page_versions ADD CONSTRAINT page_versions_row_properties
  CHECK (row_properties IS NULL OR jsonb_typeof(row_properties) = 'object');

CREATE TABLE databases (
  workspace_id uuid NOT NULL,
  page_id uuid NOT NULL,
  properties_json jsonb NOT NULL,
  views_json jsonb NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, page_id),
  FOREIGN KEY (workspace_id, page_id) REFERENCES pages (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT databases_properties_array CHECK (jsonb_typeof(properties_json) = 'array'),
  CONSTRAINT databases_views_array CHECK (jsonb_typeof(views_json) = 'array'),
  CONSTRAINT databases_revision_positive CHECK (revision > 0)
);
`,
  },
  {
    version: 14,
    name: 'database_background_reindex',
    sql: `
ALTER TABLE databases ADD COLUMN search_generation bigint NOT NULL DEFAULT 0;
ALTER TABLE databases ADD COLUMN search_indexed_generation bigint NOT NULL DEFAULT 0;
ALTER TABLE databases ADD COLUMN search_cursor uuid;
`,
  },
  {
    version: 15,
    name: 'database_text_collation',
    sql: `
-- Natural, case-insensitive ordering for text columns, matching Intl.Collator('zh-Hans-CN', { numeric, base }).
CREATE COLLATION nbase_zh (provider = icu, locale = 'zh-Hans-CN-u-kn-true-ks-level1', deterministic = false);
`,
  },
  {
    version: 16,
    name: 'database_row_links',
    sql: `
-- Derived from the owning row's row_properties, like page_links from page content.
CREATE TABLE database_row_links (
  workspace_id uuid NOT NULL,
  property_id uuid NOT NULL,
  source_row_id uuid NOT NULL,
  target_row_id uuid NOT NULL,
  PRIMARY KEY (workspace_id, property_id, source_row_id, target_row_id),
  FOREIGN KEY (workspace_id, source_row_id) REFERENCES pages (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, target_row_id) REFERENCES pages (workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX database_row_links_target_idx ON database_row_links (workspace_id, property_id, target_row_id, source_row_id);
`,
  },
  {
    version: 17,
    name: 'database_computed_cache',
    sql: `
-- Formula and rollup results used for filtering and sorting. Always recomputable from rows and schemas.
CREATE TABLE database_computed (
  workspace_id uuid NOT NULL,
  database_id uuid NOT NULL,
  row_id uuid NOT NULL,
  values_json jsonb NOT NULL,
  PRIMARY KEY (workspace_id, row_id),
  FOREIGN KEY (workspace_id, row_id) REFERENCES pages (workspace_id, id) ON DELETE RESTRICT
);
CREATE TABLE database_computed_dirty (
  workspace_id uuid NOT NULL,
  database_id uuid NOT NULL,
  row_id uuid NOT NULL,
  PRIMARY KEY (workspace_id, row_id),
  FOREIGN KEY (workspace_id, row_id) REFERENCES pages (workspace_id, id) ON DELETE RESTRICT
);
ALTER TABLE databases ADD COLUMN computed_generation bigint NOT NULL DEFAULT 0;
ALTER TABLE databases ADD COLUMN computed_done_generation bigint NOT NULL DEFAULT 0;
ALTER TABLE databases ADD COLUMN computed_cursor uuid;
`,
  },
];
