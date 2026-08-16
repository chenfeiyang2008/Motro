-- 0034_review_decisions
-- Ticket 07 internal review foundation (fake-only, no learner publication).
--
-- Review decisions, decision snapshots, and manual-handling facts are immutable
-- (append-only) facts.  This migration does NOT create final lexical content,
-- course releases, or any learner-visible projection: a review decision is never
-- automatically published.  All facts here are admin/internal only.
--
-- Security invariants enforced in this migration:
--   - review_decisions / review_decision_snapshots / manual_handling_facts are
--     INSERT-only (BEFORE UPDATE/DELETE triggers RAISE).
--   - decision_type restricted to the three command verbs.
--   - decision_hash is a deterministic 64-hex digest over a canonical payload.
--   - idempotency_key is global-unique per (reviewer, key); replay returns the
--     frozen first response (stored in review_decision_idempotency).
--   - one draft accepts at most one terminal review decision (UNIQUE(draft_id)).
--   - manual_handling_facts only allow target_state = 'draft_ready' when the
--     draft's manual_action belongs to a resolvable class; non-resolvable
--     classes (auth / model identity / source+revision missing / schema+security
--     failure / license unverifiable) are blocked by trigger.
--
-- We do NOT store: prompt, provider raw payload, provider API key, session
-- token, storage path, full raw error.  Only safe summaries and hashes.

CREATE TABLE review_decisions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id              uuid NOT NULL REFERENCES enrichment_drafts (id) ON DELETE RESTRICT,
  reviewer_id           uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  decision_type         text NOT NULL
                        CHECK (decision_type IN ('accept', 'accept_with_edits', 'reject')),
  reason                text NOT NULL CHECK (length(reason) <= 1000),
  decision_hash         text NOT NULL CHECK (decision_hash ~ '^[0-9a-f]{64}$'),
  request_hash          text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  idempotency_key       text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  audit_event_id        uuid REFERENCES audit_events (id) ON DELETE RESTRICT,
  created_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (draft_id),
  UNIQUE (reviewer_id, idempotency_key)
);

-- Idempotency replay cache: freeze the first decision response for a given
-- (reviewer, idempotency_key).  Same key + same request_hash => replay returns
-- the stored response; same key + different request_hash => 409 (enforced in
-- application, surfaced here by the PRIVATE KEY and request_hash).
CREATE TABLE review_decision_idempotency (
  reviewer_id           uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  idempotency_key       text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  request_hash          text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  response_json         jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (reviewer_id, idempotency_key)
);

-- Immutable snapshot of the decision + the exact provenance / model / template
-- facts that were in force when the decision was made.  1:1 with a decision.
CREATE TABLE review_decision_snapshots (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id             uuid NOT NULL UNIQUE REFERENCES review_decisions (id) ON DELETE RESTRICT,
  draft_id                uuid NOT NULL REFERENCES enrichment_drafts (id) ON DELETE RESTRICT,
  decision_type           text NOT NULL
                          CHECK (decision_type IN ('accept', 'accept_with_edits', 'reject')),
  english_spelling        text NOT NULL CHECK (length(english_spelling) BETWEEN 1 AND 1000),
  part_of_speech          text CHECK (part_of_speech IS NULL OR length(part_of_speech) <= 80),
  simplified_chinese_meaning text CHECK (simplified_chinese_meaning IS NULL
                                         OR length(simplified_chinese_meaning) <= 120),
  learning_hint           text CHECK (learning_hint IS NULL OR length(learning_hint) <= 80),
  -- Fixed source-fact identity (64-hex) + provenance/attribution snapshot.
  source_fact_identity    text NOT NULL CHECK (source_fact_identity ~ '^[0-9a-f]{64}$'),
  source_name             text NOT NULL CHECK (length(source_name) BETWEEN 1 AND 200),
  source_page_id          text NOT NULL CHECK (length(source_page_id) BETWEEN 1 AND 200),
  source_revision_id      text NOT NULL CHECK (length(source_revision_id) BETWEEN 1 AND 200),
  source_revision_timestamp timestamptz NOT NULL,
  source_url              text NOT NULL CHECK (length(source_url) BETWEEN 1 AND 2000),
  license_name            text NOT NULL CHECK (length(license_name) BETWEEN 1 AND 200),
  license_version         text CHECK (license_version IS NULL OR length(license_version) <= 80),
  license_url             text NOT NULL CHECK (length(license_url) BETWEEN 1 AND 2000),
  attribution             text NOT NULL CHECK (length(attribution) BETWEEN 1 AND 2000),
  -- Model / template identity held by the draft at decision time.
  configured_model_alias  text NOT NULL CHECK (length(configured_model_alias) BETWEEN 1 AND 128),
  resolved_provider_model text CHECK (resolved_provider_model IS NULL OR length(resolved_provider_model) <= 128),
  provider_fingerprint    text CHECK (provider_fingerprint IS NULL OR length(provider_fingerprint) <= 256),
  prompt_template_version text NOT NULL CHECK (length(prompt_template_version) BETWEEN 1 AND 128),
  draft_schema_version    integer NOT NULL CHECK (draft_schema_version >= 1),
  content_hash            text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  created_at              timestamptz NOT NULL DEFAULT now()
);

-- Append-only manual-handling fact, recorded when an admin resolves a
-- *resolvable* manual_action into draft_ready.  target_state is fixed to
-- 'draft_ready' (the only allowed outcome for a resolvable handling).
CREATE TABLE manual_handling_facts (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id                  uuid NOT NULL REFERENCES enrichment_drafts (id) ON DELETE RESTRICT,
  actor_id                  uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  handling_kind             text NOT NULL CHECK (handling_kind IN
                                  ('manually_supplemented', 'ambiguity_resolved',
                                   'budget_or_quota_handled', 'manual_handling')),
  reason                    text NOT NULL CHECK (length(reason) <= 1000),
  previous_status           text NOT NULL CHECK (previous_status = 'manual_action'),
  next_status               text NOT NULL CHECK (next_status = 'draft_ready'),
  target_state              text NOT NULL CHECK (target_state = 'draft_ready'),
  request_hash              text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  idempotency_key           text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  audit_event_id            uuid REFERENCES audit_events (id) ON DELETE RESTRICT,
  supplement_summary        text CHECK (supplement_summary IS NULL OR length(supplement_summary) <= 500),
  supplemental_fields       jsonb,
  error_code                text CHECK (error_code IS NULL OR length(error_code) <= 64),
  source_error_summary      text CHECK (source_error_summary IS NULL OR length(source_error_summary) <= 500),
  created_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (draft_id, idempotency_key)
);

CREATE INDEX review_decisions_draft_created_idx ON review_decisions (draft_id, created_at DESC);
CREATE INDEX review_decisions_reviewer_created_idx ON review_decisions (reviewer_id, created_at DESC);
CREATE INDEX review_decision_snapshots_draft_idx ON review_decision_snapshots (draft_id);
CREATE INDEX manual_handling_facts_draft_idx ON manual_handling_facts (draft_id, created_at DESC);
CREATE INDEX manual_handling_facts_actor_idx ON manual_handling_facts (actor_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Immutability: INSERT-only facts.  UPDATE/DELETE are rejected.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION motro_reject_review_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'review facts are immutable (update/delete not allowed)';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER review_decisions_no_update
  BEFORE UPDATE ON review_decisions
  FOR EACH ROW EXECUTE FUNCTION motro_reject_review_mutation();
CREATE TRIGGER review_decisions_no_delete
  BEFORE DELETE ON review_decisions
  FOR EACH ROW EXECUTE FUNCTION motro_reject_review_mutation();
CREATE TRIGGER review_decision_snapshots_no_update
  BEFORE UPDATE ON review_decision_snapshots
  FOR EACH ROW EXECUTE FUNCTION motro_reject_review_mutation();
CREATE TRIGGER review_decision_snapshots_no_delete
  BEFORE DELETE ON review_decision_snapshots
  FOR EACH ROW EXECUTE FUNCTION motro_reject_review_mutation();
CREATE TRIGGER manual_handling_facts_no_update
  BEFORE UPDATE ON manual_handling_facts
  FOR EACH ROW EXECUTE FUNCTION motro_reject_review_mutation();
CREATE TRIGGER manual_handling_facts_no_delete
  BEFORE DELETE ON manual_handling_facts
  FOR EACH ROW EXECUTE FUNCTION motro_reject_review_mutation();

-- ---------------------------------------------------------------------------
-- Non-resolvable manual_action guard: an admin must NOT be able to fabricate
-- source/model identity or wait out a hard failure by "marking it resolved".
--
-- A resolvable manual_action is one where the operator supplements structure
-- without changing source truth / model identity / security conclusion:
--   - supplied budget/quota (DRAFT_BUDGET_EXCEEDED)
--   - resolves documented ambiguity (WIKI_AMBIGUOUS)
--
-- Everything else in the manual set is non-resolvable (provider auth failure,
-- model identity insufficient, source or revision missing/unverifiable,
-- schema/security failure, license/attribution unverifiable).  Attempting to
-- advance such a draft to draft_ready via manual_handling_facts is rejected.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION motro_guard_manual_handling()
RETURNS trigger AS $$
DECLARE
  v_draft_status text;
  v_error_code   text;
BEGIN
  SELECT d.status, d.error_code
    INTO v_draft_status, v_error_code
    FROM enrichment_drafts d WHERE d.id = NEW.draft_id;
  IF v_draft_status IS NULL THEN
    RAISE EXCEPTION 'manual_handling_facts references a non-existent draft';
  END IF;
  IF v_draft_status <> 'manual_action' THEN
    RAISE EXCEPTION 'manual_handling_facts requires draft.status = manual_action, got %', v_draft_status;
  END IF;
  -- Resolvable classes: budget/quota handling and documented ambiguity.
  IF v_error_code IN ('DRAFT_BUDGET_EXCEEDED', 'WIKI_AMBIGUOUS') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'manual_action class % is not resolvable to draft_ready; '
                   'only DRAFT_BUDGET_EXCEEDED and WIKI_AMBIGUOUS are permitted',
                   COALESCE(v_error_code, '(unknown)');
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER manual_handling_facts_check_resolvable
  BEFORE INSERT ON manual_handling_facts
  FOR EACH ROW EXECUTE FUNCTION motro_guard_manual_handling();
