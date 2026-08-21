import { describe, expect, it, vi } from "vitest";
import { AdminOverviewService } from "../../apps/api/src/modules/admin/overview.service.js";

describe("AdminOverviewService", () => {
  it("maps one aggregate row into the public dashboard projection", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          generated_at: new Date("2026-08-19T03:00:00.000Z"),
          users_total: "12",
          members_total: "3",
          active_lexicon_total: "420",
          courses_total: "8",
          published_courses_total: "5",
          reviews_count: "1",
          reviews_items: [
            {
              id: "review-1",
              label: "abandon",
              status: "draft_ready",
              createdAt: "2026-08-19T02:00:00.000Z",
            },
          ],
          imports_count: "0",
          imports_items: [],
          operations_count: "0",
          operations_items: [],
          publishing_count: "2",
          publishing_items: [
            {
              id: "course-1",
              label: "基础词汇",
              status: "draft",
              updatedAt: "2026-08-19T01:00:00.000Z",
            },
          ],
        },
      ],
    });
    const service = new AdminOverviewService({ query } as never);

    const result = await service.getOverview();
    expect(result).toEqual({
      generatedAt: "2026-08-19T03:00:00.000Z",
      metrics: {
        users: { total: 12 },
        members: { total: 3 },
        activeLexiconEntries: { total: 420 },
        courses: { total: 8 },
        publishedCourses: { total: 5 },
      },
      queues: {
        reviews: {
          count: 1,
          items: [
            {
              id: "review-1",
              label: "abandon",
              status: "draft_ready",
              createdAt: "2026-08-19T02:00:00.000Z",
            },
          ],
        },
        imports: { count: 0, items: [] },
        operations: { count: 0, items: [] },
        publishing: {
          count: 2,
          items: [
            {
              id: "course-1",
              label: "基础词汇",
              status: "draft",
              updatedAt: "2026-08-19T01:00:00.000Z",
            },
          ],
        },
      },
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toMatch(/password|sessionToken|providerPayload|stack/i);
  });
});
