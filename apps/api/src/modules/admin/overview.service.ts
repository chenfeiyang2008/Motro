import { Inject, Injectable } from "@nestjs/common";
import { POOL, type Pool } from "../../auth/database.provider.js";
import type {
  AdminOverviewDto,
  AdminOverviewCourseItemDto,
  AdminOverviewImportItemDto,
  AdminOverviewOperationItemDto,
  AdminOverviewReviewItemDto,
} from "./overview.dto.js";

type OverviewRow = {
  generated_at: Date;
  users_total: string;
  members_total: string;
  active_lexicon_total: string;
  courses_total: string;
  published_courses_total: string;
  reviews_count: string;
  reviews_items: AdminOverviewReviewItemDto[] | null;
  imports_count: string;
  imports_items: AdminOverviewImportItemDto[] | null;
  operations_count: string;
  operations_items: AdminOverviewOperationItemDto[] | null;
  publishing_count: string;
  publishing_items: AdminOverviewCourseItemDto[] | null;
};

/** Read-only, privacy-safe aggregate for the admin landing page. */
@Injectable()
export class AdminOverviewService {
  constructor(@Inject(POOL) private readonly pool: Pool) {}

  async getOverview(): Promise<AdminOverviewDto> {
    const { rows } = await this.pool.query<OverviewRow>(`
      SELECT
        now() AS generated_at,
        (SELECT count(*)::text FROM users WHERE status = 'active') AS users_total,
        (SELECT count(*)::text FROM memberships
          WHERE plan = 'member' AND status = 'active'
            AND (expires_at IS NULL OR expires_at >= now())) AS members_total,
        (SELECT count(*)::text FROM lexical_entries WHERE status = 'active') AS active_lexicon_total,
        (SELECT count(*)::text FROM courses WHERE status = 'active') AS courses_total,
        (SELECT count(*)::text FROM courses
          WHERE status = 'active' AND visibility = 'published') AS published_courses_total,

        (SELECT count(*)::text FROM enrichment_drafts d
          JOIN import_batch_commit_rows r ON r.id = d.import_batch_commit_row_id
          JOIN wiktionary_source_facts f
            ON f.source_fact_identity = d.wiktionary_source_fact_id
           AND f.status = 'fetched' AND f.content_hash IS NOT NULL
          WHERE f.revision_timestamp IS NOT NULL
            AND NULLIF(f.source_url, '') IS NOT NULL
            AND NULLIF(f.license_name, '') IS NOT NULL
            AND NULLIF(f.license_url, '') IS NOT NULL
            AND NULLIF(f.attribution, '') IS NOT NULL
            AND ((d.status = 'draft_ready' AND NULLIF(d.simplified_chinese_meaning, '') IS NOT NULL)
              OR (d.status = 'manual_action'
                AND d.error_code IN ('DRAFT_BUDGET_EXCEEDED', 'WIKI_AMBIGUOUS')
                AND EXISTS (SELECT 1 FROM manual_handling_facts h
                  WHERE h.draft_id = d.id AND h.next_status = 'draft_ready')))
            AND NOT EXISTS (SELECT 1 FROM review_decisions x WHERE x.draft_id = d.id)) AS reviews_count,
        COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'id', d.id, 'label', d.normalized_spelling, 'status',
          CASE WHEN d.status = 'manual_action' THEN 'manual_action' ELSE 'draft_ready' END,
          'createdAt', d.created_at) ORDER BY d.created_at DESC)
          FROM (
            SELECT d.id, d.status, d.created_at, r.normalized_spelling
            FROM enrichment_drafts d
            JOIN import_batch_commit_rows r ON r.id = d.import_batch_commit_row_id
            JOIN wiktionary_source_facts f
              ON f.source_fact_identity = d.wiktionary_source_fact_id
             AND f.status = 'fetched' AND f.content_hash IS NOT NULL
            WHERE ((d.status = 'draft_ready' AND NULLIF(d.simplified_chinese_meaning, '') IS NOT NULL)
              OR (d.status = 'manual_action'
                AND d.error_code IN ('DRAFT_BUDGET_EXCEEDED', 'WIKI_AMBIGUOUS')
                AND EXISTS (SELECT 1 FROM manual_handling_facts h
                  WHERE h.draft_id = d.id AND h.next_status = 'draft_ready')))
              AND NOT EXISTS (SELECT 1 FROM review_decisions x WHERE x.draft_id = d.id)
            ORDER BY d.created_at DESC LIMIT 5
          ) d), '[]'::jsonb)::jsonb AS reviews_items,

        (SELECT count(*)::text FROM import_batches WHERE status IN ('failed', 'validating')) AS imports_count,
        COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'id', b.id, 'label', b.source_declaration, 'status', b.status, 'updatedAt', b.updated_at)
          ORDER BY b.updated_at DESC)
          FROM (SELECT id, source_declaration, status, updated_at
                FROM import_batches WHERE status IN ('failed', 'validating')
                ORDER BY updated_at DESC LIMIT 5) b), '[]'::jsonb)::jsonb AS imports_items,

        (SELECT count(*)::text FROM application_operations WHERE status IN ('failed', 'manual_action')) AS operations_count,
        COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'id', o.id, 'label', o.operation_type, 'status', o.status,
          'updatedAt', o.updated_at, 'errorCode', o.last_error_code)
          ORDER BY o.updated_at DESC)
          FROM (SELECT id, operation_type, status, updated_at, last_error_code
                FROM application_operations WHERE status IN ('failed', 'manual_action')
                ORDER BY updated_at DESC LIMIT 5) o), '[]'::jsonb)::jsonb AS operations_items,

        (SELECT count(*)::text FROM courses WHERE status = 'active' AND visibility <> 'published') AS publishing_count,
        COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'id', c.id, 'label', c.title, 'status', c.visibility, 'updatedAt', c.updated_at)
          ORDER BY c.updated_at DESC)
          FROM (SELECT id, title, visibility, updated_at
                FROM courses WHERE status = 'active' AND visibility <> 'published'
                ORDER BY updated_at DESC LIMIT 5) c), '[]'::jsonb)::jsonb AS publishing_items
    `);
    const row = rows[0];
    if (!row) throw new Error("管理概览查询未返回结果");
    return {
      generatedAt: row.generated_at.toISOString(),
      metrics: {
        users: { total: Number(row.users_total) },
        members: { total: Number(row.members_total) },
        activeLexiconEntries: { total: Number(row.active_lexicon_total) },
        courses: { total: Number(row.courses_total) },
        publishedCourses: { total: Number(row.published_courses_total) },
      },
      queues: {
        reviews: { count: Number(row.reviews_count), items: row.reviews_items ?? [] },
        imports: { count: Number(row.imports_count), items: row.imports_items ?? [] },
        operations: { count: Number(row.operations_count), items: row.operations_items ?? [] },
        publishing: { count: Number(row.publishing_count), items: row.publishing_items ?? [] },
      },
    };
  }
}
