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
  {
    version: 18,
    name: 'database_computed_dirty_generation',
    sql: `
ALTER TABLE database_computed_dirty ADD COLUMN generation bigint NOT NULL DEFAULT 1;

-- Rebuild any stale results whose invalidation was dropped before jobs had generations.
UPDATE databases
SET computed_generation = computed_generation + 1, computed_cursor = NULL
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements(properties_json) AS def
  WHERE def->>'type' IN ('formula', 'rollup') AND def->>'deletedAt' IS NULL
);
`,
  },
  {
    version: 19,
    name: 'page_search_pinyin',
    sql: `
-- Derived pinyin keys (docs/architecture/search.md). NULL means not indexed yet: search then uses the
-- literal path for that page, and the background indexer fills it in without the workspace lock.
ALTER TABLE pages ADD COLUMN search_title_pinyin tsvector;
ALTER TABLE pages ADD COLUMN search_body_pinyin tsvector;

-- Any write that changes the source text clears the stale keys, even one that does not know about pinyin.
CREATE FUNCTION pages_search_pinyin_reset() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.title IS DISTINCT FROM OLD.title THEN NEW.search_title_pinyin := NULL; END IF;
  IF NEW.search_text IS DISTINCT FROM OLD.search_text THEN NEW.search_body_pinyin := NULL; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pages_search_pinyin_reset BEFORE UPDATE OF title, search_text ON pages
  FOR EACH ROW EXECUTE FUNCTION pages_search_pinyin_reset();

CREATE INDEX pages_search_pinyin_pending_idx ON pages (id)
  WHERE search_title_pinyin IS NULL OR search_body_pinyin IS NULL;
`,
  },
  {
    // 19 is reserved for a parallel feature; applied versions need not be contiguous.
    version: 20,
    name: 'whiteboard_pages',
    sql: `
ALTER TABLE pages DROP CONSTRAINT pages_kind;
ALTER TABLE pages ADD CONSTRAINT pages_kind CHECK (kind IN ('document', 'database', 'row', 'whiteboard'));
`,
  },
  {
    version: 21,
    name: 'calendar',
    sql: `
-- Workspace calendar preferences per account (docs/architecture/calendar.md); the last write wins.
CREATE TABLE calendar_settings (
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  settings_json jsonb NOT NULL CHECK (jsonb_typeof(settings_json) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id),
  FOREIGN KEY (workspace_id, user_id) REFERENCES workspace_memberships (workspace_id, user_id) ON DELETE RESTRICT
);

-- A database kept by an .ics import or subscription. The URL may hold a secret and is never returned.
CREATE TABLE calendar_sync_sources (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  database_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('ics-file', 'ics-url')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  url text CHECK (url IS NULL OR char_length(url) BETWEEN 1 AND 2000),
  interval_minutes integer CHECK (interval_minutes IS NULL OR interval_minutes BETWEEN 15 AND 1440),
  fields_json jsonb NOT NULL CHECK (jsonb_typeof(fields_json) = 'object'),
  status text NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'error')),
  running_since timestamptz,
  last_synced_at timestamptz,
  last_error text CHECK (last_error IS NULL OR char_length(last_error) BETWEEN 1 AND 32),
  last_counts_json jsonb CHECK (last_counts_json IS NULL OR jsonb_typeof(last_counts_json) = 'object'),
  warnings_json jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(warnings_json) = 'array'),
  event_count integer NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  next_run_at timestamptz,
  http_etag text CHECK (http_etag IS NULL OR char_length(http_etag) <= 512),
  http_last_modified text CHECK (http_last_modified IS NULL OR char_length(http_last_modified) <= 100),
  created_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  client_mutation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, database_id),
  UNIQUE (workspace_id, created_by, client_mutation_id),
  FOREIGN KEY (workspace_id, database_id) REFERENCES databases (workspace_id, page_id) ON DELETE RESTRICT,
  CONSTRAINT calendar_sync_sources_subscription CHECK (
    (kind = 'ics-url') = (url IS NOT NULL) AND (kind = 'ics-url') = (interval_minutes IS NOT NULL)),
  CONSTRAINT calendar_sync_sources_running CHECK ((status = 'running') = (running_since IS NOT NULL))
);
CREATE INDEX calendar_sync_sources_due_idx ON calendar_sync_sources (next_run_at) WHERE kind = 'ics-url';

-- One row per external event: the row it was written to, that row's revision right after, and a content digest.
CREATE TABLE calendar_sync_items (
  workspace_id uuid NOT NULL,
  source_id uuid NOT NULL,
  uid text COLLATE "C" NOT NULL CHECK (char_length(uid) BETWEEN 1 AND 1000),
  row_id uuid NOT NULL,
  synced_revision bigint NOT NULL CHECK (synced_revision > 0),
  content_hash bytea NOT NULL CHECK (octet_length(content_hash) = 32),
  -- Set when a subscription no longer lists the event and its row went to the trash.
  removed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, uid),
  FOREIGN KEY (workspace_id, source_id) REFERENCES calendar_sync_sources (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, row_id) REFERENCES pages (workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX calendar_sync_items_row_idx ON calendar_sync_items (workspace_id, row_id);
`,
  },
  {
    version: 22,
    name: 'calendar_caldav',
    sql: `
-- CalDAV sources (docs/architecture/calendar.md). caldav_json holds the server and calendar addresses, the
-- calendar name and whether it is writable; credentials are AES-256-GCM sealed with a key outside the database.
ALTER TABLE calendar_sync_sources DROP CONSTRAINT calendar_sync_sources_kind_check;
ALTER TABLE calendar_sync_sources DROP CONSTRAINT calendar_sync_sources_subscription;
ALTER TABLE calendar_sync_sources
  ADD COLUMN caldav_json jsonb CHECK (caldav_json IS NULL OR jsonb_typeof(caldav_json) = 'object'),
  ADD COLUMN credential_cipher bytea CHECK (credential_cipher IS NULL OR octet_length(credential_cipher) BETWEEN 30 AND 4096),
  ADD COLUMN credential_key_id text CHECK (credential_key_id IS NULL OR credential_key_id ~ '^[0-9a-f]{16}$'),
  ADD COLUMN sync_token text CHECK (sync_token IS NULL OR char_length(sync_token) BETWEEN 1 AND 2000),
  ADD COLUMN ctag text CHECK (ctag IS NULL OR char_length(ctag) BETWEEN 1 AND 1000),
  ADD CONSTRAINT calendar_sync_sources_kind CHECK (kind IN ('ics-file', 'ics-url', 'caldav')),
  ADD CONSTRAINT calendar_sync_sources_subscription CHECK (
    (kind = 'ics-url') = (url IS NOT NULL)
    AND (kind IN ('ics-url', 'caldav')) = (interval_minutes IS NOT NULL)
    AND (kind = 'caldav') = (caldav_json IS NOT NULL)
    AND (kind = 'caldav') = (credential_cipher IS NOT NULL)
    AND (credential_cipher IS NULL) = (credential_key_id IS NULL)
    AND (kind = 'caldav' OR (sync_token IS NULL AND ctag IS NULL)));
DROP INDEX calendar_sync_sources_due_idx;
CREATE INDEX calendar_sync_sources_due_idx ON calendar_sync_sources (next_run_at) WHERE kind IN ('ics-url', 'caldav');

-- One row per external resource (an .ics address in the collection) and the text last read or written, so
-- that writing back changes only what NBase knows. body is NULL when the text is larger than 1 MB.
CREATE TABLE calendar_sync_resources (
  workspace_id uuid NOT NULL,
  source_id uuid NOT NULL,
  href text COLLATE "C" NOT NULL CHECK (char_length(href) BETWEEN 1 AND 2000),
  etag text CHECK (etag IS NULL OR char_length(etag) BETWEEN 1 AND 512),
  body text CHECK (body IS NULL OR octet_length(body) <= 1048576),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, href),
  FOREIGN KEY (workspace_id, source_id) REFERENCES calendar_sync_sources (workspace_id, id) ON DELETE CASCADE
);

-- The resource an event lives in; attendees marks events NBase never writes back.
ALTER TABLE calendar_sync_items
  ADD COLUMN href text COLLATE "C" CHECK (href IS NULL OR char_length(href) BETWEEN 1 AND 2000),
  ADD COLUMN attendees boolean NOT NULL DEFAULT false;
CREATE INDEX calendar_sync_items_href_idx ON calendar_sync_items (source_id, href) WHERE href IS NOT NULL;
CREATE INDEX calendar_sync_items_attendees_idx ON calendar_sync_items (source_id, row_id) WHERE attendees;

-- Events changed on both sides; writing back waits until each is resolved. remote_json is the external
-- side's synced fields, NULL once the event is gone there; remote_etag and remote_body are the external text.
CREATE TABLE calendar_sync_conflicts (
  workspace_id uuid NOT NULL,
  source_id uuid NOT NULL,
  uid text COLLATE "C" NOT NULL CHECK (char_length(uid) BETWEEN 1 AND 1000),
  row_id uuid NOT NULL,
  copy_row_id uuid,
  kind text NOT NULL CHECK (kind IN ('both-changed', 'remote-deleted', 'local-deleted')),
  remote_href text COLLATE "C" CHECK (remote_href IS NULL OR char_length(remote_href) BETWEEN 1 AND 2000),
  remote_etag text CHECK (remote_etag IS NULL OR char_length(remote_etag) BETWEEN 1 AND 512),
  remote_body text CHECK (remote_body IS NULL OR octet_length(remote_body) <= 1048576),
  remote_json jsonb CHECK (remote_json IS NULL OR jsonb_typeof(remote_json) = 'object'),
  detected_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_id, uid),
  UNIQUE (source_id, row_id),
  FOREIGN KEY (workspace_id, source_id) REFERENCES calendar_sync_sources (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, row_id) REFERENCES pages (workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, copy_row_id) REFERENCES pages (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT calendar_sync_conflicts_copy CHECK ((kind = 'both-changed') = (copy_row_id IS NOT NULL))
);
CREATE INDEX calendar_sync_conflicts_copy_idx ON calendar_sync_conflicts (source_id, copy_row_id) WHERE copy_row_id IS NOT NULL;
`,
  },
  {
    version: 23,
    name: 'calendar_oauth',
    sql: `
-- OAuth apps a workspace registered with Google or Microsoft (docs/architecture/calendar.md). The Google client
-- secret is sealed like CalDAV credentials; a Microsoft public client has none.
CREATE TABLE calendar_oauth_apps (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google', 'microsoft')),
  client_id text NOT NULL CHECK (char_length(client_id) BETWEEN 1 AND 256),
  secret_cipher bytea CHECK (secret_cipher IS NULL OR octet_length(secret_cipher) BETWEEN 30 AND 4096),
  tenant text CHECK (tenant IS NULL OR char_length(tenant) BETWEEN 1 AND 253),
  key_id text CHECK (key_id IS NULL OR key_id ~ '^[0-9a-f]{16}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, provider),
  CONSTRAINT calendar_oauth_apps_google CHECK (provider <> 'google' OR (secret_cipher IS NOT NULL AND key_id IS NOT NULL)),
  CONSTRAINT calendar_oauth_apps_microsoft CHECK (provider <> 'microsoft' OR tenant IS NOT NULL)
);

-- One authorization in progress. Only digests of the Google state and of the browser binding cookie are kept;
-- the PKCE verifier or device code (secret_cipher) and the tokens obtained (token_cipher) are sealed with the flow id.
CREATE TABLE calendar_oauth_flows (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('google', 'microsoft')),
  source_id uuid,
  state_hash bytea UNIQUE CHECK (state_hash IS NULL OR octet_length(state_hash) = 32),
  binding_hash bytea CHECK (binding_hash IS NULL OR octet_length(binding_hash) = 32),
  secret_cipher bytea NOT NULL CHECK (octet_length(secret_cipher) BETWEEN 30 AND 8192),
  token_cipher bytea CHECK (token_cipher IS NULL OR octet_length(token_cipher) BETWEEN 30 AND 16384),
  key_id text NOT NULL CHECK (key_id ~ '^[0-9a-f]{16}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed', 'used')),
  error text CHECK (error IS NULL OR error IN ('OAUTH_DENIED', 'OAUTH_EXPIRED', 'OAUTH_FAILED', 'ACCOUNT_MISMATCH', 'FETCH_FAILED',
    'API_DISABLED')),
  account_json jsonb CHECK (account_json IS NULL OR jsonb_typeof(account_json) = 'object'),
  calendars_json jsonb CHECK (calendars_json IS NULL OR jsonb_typeof(calendars_json) = 'array'),
  expires_at timestamptz NOT NULL,
  next_poll_at timestamptz,
  poll_interval integer CHECK (poll_interval IS NULL OR poll_interval BETWEEN 1 AND 3600),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, user_id) REFERENCES workspace_memberships (workspace_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, source_id) REFERENCES calendar_sync_sources (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT calendar_oauth_flows_failed CHECK ((status = 'failed') = (error IS NOT NULL)),
  CONSTRAINT calendar_oauth_flows_google CHECK (provider <> 'google' OR (state_hash IS NOT NULL AND binding_hash IS NOT NULL))
);
CREATE INDEX calendar_oauth_flows_expires_idx ON calendar_oauth_flows (expires_at);
CREATE INDEX calendar_oauth_flows_workspace_idx ON calendar_oauth_flows (workspace_id, provider);
CREATE INDEX calendar_oauth_flows_source_idx ON calendar_oauth_flows (workspace_id, source_id) WHERE source_id IS NOT NULL;
CREATE INDEX calendar_oauth_flows_user_idx ON calendar_oauth_flows (workspace_id, user_id);
`,
  },
  {
    version: 24,
    name: 'calendar_aggregate',
    sql: `
-- Databases a calendar source made stay out of navigation after syncing stops, until revealed by hand.
ALTER TABLE databases ADD COLUMN calendar_hidden boolean NOT NULL DEFAULT false;
UPDATE databases d SET calendar_hidden = true
  WHERE EXISTS (SELECT 1 FROM calendar_sync_sources s WHERE s.workspace_id = d.workspace_id AND s.database_id = d.page_id)
    -- Sources stopped before this version left no record; their databases still have the exact fields a source creates,
    -- with 外部 ID hidden in every view.
    OR ((SELECT jsonb_agg(jsonb_build_array(e->>'name', e->>'type', e->>'deletedAt') ORDER BY o)
          FROM jsonb_array_elements(d.properties_json) WITH ORDINALITY AS x(e, o))
        = '[["名称", "title", null], ["时间", "date", null], ["地点", "text", null], ["说明", "text", null], ["外部 ID", "text", null]]'::jsonb
      AND jsonb_array_length(d.views_json) > 0
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(d.views_json) v
        WHERE NOT COALESCE(v->'hiddenPropertyIds', '[]'::jsonb) ? (d.properties_json->4->>'id')));

-- The workspace's aggregate calendar: ordinary databases on the workspace calendar of aggregate_user_id sync to it.
ALTER TABLE calendar_sync_sources
  ADD COLUMN aggregate_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  ADD CONSTRAINT calendar_sync_sources_aggregate CHECK (aggregate_user_id IS NULL OR kind = 'caldav');
CREATE UNIQUE INDEX calendar_sync_sources_aggregate_idx ON calendar_sync_sources (workspace_id) WHERE aggregate_user_id IS NOT NULL;

-- Events of the aggregate calendar: the row is in database_id and its time in property_id. NULL for the source's own database.
ALTER TABLE calendar_sync_items
  ADD COLUMN database_id uuid,
  ADD COLUMN property_id text CHECK (property_id IS NULL OR char_length(property_id) BETWEEN 1 AND 100),
  ADD CONSTRAINT calendar_sync_items_aggregate CHECK ((database_id IS NULL) = (property_id IS NULL));
`,
  },
  {
    version: 25,
    name: 'page_version_labels',
    sql: `
-- Named versions (docs/architecture/history-trash.md). Naming a version changes neither the page revision nor the
-- snapshot; it only marks a version worth finding again.
ALTER TABLE page_versions
  ADD COLUMN label text CHECK (label IS NULL OR char_length(label) BETWEEN 1 AND 100),
  ADD COLUMN note text CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 1000),
  ADD CONSTRAINT page_versions_note_needs_label CHECK (note IS NULL OR label IS NOT NULL);
CREATE INDEX page_versions_named_idx ON page_versions (workspace_id, page_id, revision) WHERE label IS NOT NULL;
`,
  },
  {
    version: 26,
    name: 'workspace_members',
    sql: `
-- Members and invitation links (docs/architecture/members.md). Personal rows reference memberships with
-- ON DELETE RESTRICT, so a removed member keeps the row with removed_at set and every authorization path skips it.
ALTER TABLE workspace_memberships ADD COLUMN removed_at timestamptz;
ALTER TABLE workspace_memberships ADD CONSTRAINT workspace_memberships_owner_stays CHECK (role <> 'owner' OR removed_at IS NULL);

-- One-time invitation links. Only the SHA-256 digest of the token is stored; the token itself is shown once.
CREATE TABLE workspace_invitations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  role text NOT NULL CHECK (role IN ('editor', 'viewer')),
  created_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  accepted_at timestamptz,
  accepted_user_id uuid REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT workspace_invitations_expiry CHECK (expires_at > created_at),
  CONSTRAINT workspace_invitations_accepted CHECK ((accepted_at IS NULL) = (accepted_user_id IS NULL)),
  CONSTRAINT workspace_invitations_single_end CHECK (revoked_at IS NULL OR accepted_at IS NULL)
);
CREATE INDEX workspace_invitations_workspace_idx ON workspace_invitations (workspace_id, created_at DESC, id);
`,
  },
  {
    version: 27,
    name: 'database_schema_versions',
    sql: `
-- Schema history of databases (docs/architecture/databases.md). Every write of fields or views leaves the state it
-- produced; restoring a version writes a new one. Versions are never cleaned up automatically.
CREATE TABLE database_schema_versions (
  workspace_id uuid NOT NULL,
  database_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  properties_json jsonb NOT NULL CHECK (jsonb_typeof(properties_json) = 'array'),
  views_json jsonb NOT NULL CHECK (jsonb_typeof(views_json) = 'array'),
  saved_at timestamptz NOT NULL,
  actor_user_id uuid REFERENCES users (id) ON DELETE RESTRICT,
  operation text NOT NULL CHECK (operation IN ('baseline', 'create', 'update', 'relation', 'restore')),
  restored_from bigint CHECK (restored_from IS NULL OR restored_from > 0),
  PRIMARY KEY (workspace_id, database_id, revision),
  FOREIGN KEY (workspace_id, database_id) REFERENCES databases (workspace_id, page_id) ON DELETE RESTRICT,
  CONSTRAINT database_schema_versions_restore CHECK ((operation = 'restore') = (restored_from IS NOT NULL))
);
INSERT INTO database_schema_versions (workspace_id, database_id, revision, properties_json, views_json, saved_at, actor_user_id, operation)
SELECT workspace_id, page_id, revision, properties_json, views_json, updated_at, NULL, 'baseline' FROM databases;

-- The computed worker takes queued rows a database at a time, upstream databases first.
CREATE INDEX database_computed_dirty_database_idx ON database_computed_dirty (workspace_id, database_id);
`,
  },
  {
    version: 28,
    name: 'page_comments_and_shares',
    sql: `
-- Comments and read-only share links (docs/architecture/collaboration.md). Neither touches page content or revisions.
CREATE TABLE page_comment_threads (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  page_id uuid NOT NULL,
  anchor_block_id text CHECK (anchor_block_id IS NULL OR anchor_block_id ~ '^[a-z0-9]{8}$'),
  anchor_path integer[] NOT NULL CHECK (cardinality(anchor_path) BETWEEN 1 AND 16 AND 0 <= ALL (anchor_path)),
  quote text NOT NULL CHECK (char_length(quote) <= 500),
  created_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT page_comment_threads_resolved CHECK ((resolved_at IS NULL) = (resolved_by IS NULL)),
  FOREIGN KEY (workspace_id, page_id) REFERENCES pages (workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX page_comment_threads_page_idx ON page_comment_threads (workspace_id, page_id, created_at, id);

CREATE TABLE page_comments (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
  thread_id uuid NOT NULL REFERENCES page_comment_threads (id) ON DELETE RESTRICT,
  author_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  deleted_at timestamptz
);
CREATE INDEX page_comments_thread_idx ON page_comments (thread_id, created_at, id);

-- Only the SHA-256 digest of a share token is stored; the token itself is shown once.
CREATE TABLE page_share_links (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  page_id uuid NOT NULL,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  include_children boolean NOT NULL,
  created_by uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  view_count integer NOT NULL DEFAULT 0 CHECK (view_count >= 0),
  last_viewed_at timestamptz,
  CONSTRAINT page_share_links_expiry CHECK (expires_at > created_at),
  FOREIGN KEY (workspace_id, page_id) REFERENCES pages (workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX page_share_links_page_idx ON page_share_links (workspace_id, page_id, created_at DESC, id);
`,
  },
  {
    version: 29,
    name: 'page_version_search_text',
    sql: `
-- Search text of page versions (docs/architecture/search.md). Derived and rebuildable from content_json; NULL means not
-- derived yet, and such a version matches by title only until the background indexer fills it. New snapshots copy
-- pages.search_text, so only versions saved before this migration wait for the indexer.
ALTER TABLE page_versions ADD COLUMN search_text text;
-- The current revision of every page already has its text in pages.
UPDATE page_versions h SET search_text = p.search_text FROM pages p
  WHERE p.workspace_id = h.workspace_id AND p.id = h.page_id AND p.revision = h.revision;
CREATE INDEX page_versions_search_pending_idx ON page_versions (workspace_id, page_id, revision) WHERE search_text IS NULL;
`,
  },
  {
    version: 30,
    name: 'page_collab_rooms',
    sql: `
-- Real-time co-editing rooms (docs/architecture/realtime.md). Revisions stay the authoritative content; a room holds the
-- Yjs state built on top of base_revision. A new epoch is a fresh random value so an old offline client never mixes
-- its updates into a rebuilt room.
CREATE TABLE page_collab_rooms (
  workspace_id uuid NOT NULL,
  page_id uuid NOT NULL,
  epoch bigint NOT NULL CHECK (epoch BETWEEN 1 AND 4294967295),
  base_revision bigint NOT NULL,
  saved_revision bigint,
  saved_state_vector bytea CHECK (octet_length(saved_state_vector) <= 65536),
  snapshot bytea,
  snapshot_seq bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, page_id),
  CONSTRAINT page_collab_rooms_saved CHECK ((saved_revision IS NULL) = (saved_state_vector IS NULL)),
  FOREIGN KEY (workspace_id, page_id) REFERENCES pages (workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE page_collab_updates (
  workspace_id uuid NOT NULL,
  page_id uuid NOT NULL,
  epoch bigint NOT NULL,
  seq bigint NOT NULL CHECK (seq > 0),
  "update" bytea NOT NULL CHECK (octet_length("update") <= 262144),
  user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, page_id, epoch, seq),
  FOREIGN KEY (workspace_id, page_id) REFERENCES page_collab_rooms (workspace_id, page_id) ON DELETE CASCADE
);

-- Every content write that did not come from the room's saver starts the room again from the new revision; a title-only
-- write is pushed into the room; trashing a page ends its room. The notification is delivered only after commit.
CREATE FUNCTION page_collab_external_write() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  room_epoch bigint;
  next_epoch bigint;
BEGIN
  SELECT epoch INTO room_epoch FROM page_collab_rooms WHERE workspace_id = NEW.workspace_id AND page_id = NEW.id FOR UPDATE;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    DELETE FROM page_collab_rooms WHERE workspace_id = NEW.workspace_id AND page_id = NEW.id;
    PERFORM pg_notify('nbase_rooms', json_build_object('k', 'closed', 'w', NEW.workspace_id, 'p', NEW.id)::text);
    RETURN NEW;
  END IF;
  IF current_setting('nbase.collab_epoch', true) IS NOT DISTINCT FROM room_epoch::text THEN RETURN NEW; END IF;
  IF NEW.content_json IS DISTINCT FROM OLD.content_json THEN
    next_epoch := floor(random() * 4294967294)::bigint + 1;
    UPDATE page_collab_rooms SET epoch = next_epoch, base_revision = NEW.revision, saved_revision = NULL, saved_state_vector = NULL,
      snapshot = NULL, snapshot_seq = 0, updated_at = now()
      WHERE workspace_id = NEW.workspace_id AND page_id = NEW.id;
    DELETE FROM page_collab_updates WHERE workspace_id = NEW.workspace_id AND page_id = NEW.id;
    PERFORM pg_notify('nbase_rooms', json_build_object('k', 'reset', 'w', NEW.workspace_id, 'p', NEW.id, 'e', next_epoch,
      'r', NEW.revision::text, 'why', current_setting('nbase.write_reason', true), 'a', current_setting('nbase.actor', true))::text);
  ELSIF NEW.title IS DISTINCT FROM OLD.title THEN
    PERFORM pg_notify('nbase_rooms', json_build_object('k', 'title', 'w', NEW.workspace_id, 'p', NEW.id, 'title', NEW.title)::text);
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER pages_collab_external_write AFTER UPDATE OF content_json, title, deleted_at ON pages
  FOR EACH ROW EXECUTE FUNCTION page_collab_external_write();`,
  },
  {
    version: 31,
    name: 'page_properties',
    sql: `
-- Properties an ordinary page defines for itself (docs/architecture/page-properties.md): an ordered JSON array of
-- fields, each carrying its value. Rows keep using row_properties and the schema of their database.
ALTER TABLE pages ADD COLUMN page_properties jsonb;
ALTER TABLE pages ADD CONSTRAINT pages_page_properties CHECK (
  page_properties IS NULL OR (kind = 'document' AND jsonb_typeof(page_properties) = 'array'));
ALTER TABLE page_versions ADD COLUMN page_properties jsonb;
ALTER TABLE page_versions ADD CONSTRAINT page_versions_page_properties
  CHECK (page_properties IS NULL OR jsonb_typeof(page_properties) = 'array');`,
  },
];
