import { describe, expect, it, vi } from "vitest";

import { revokeWorkosAuthorizedApplications } from "@/lib/agent-access/settings";

describe("WorkOS authorized application cleanup", () => {
  it("lists every page before revoking every distinct grant", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          data: [{ application: { id: "app-1" }, oauth_resource: "https://learnrecur.example/mcp" }],
          list_metadata: { after: "cursor-2" },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          data: [
            { application: { id: "app-1" }, oauth_resource: "https://learnrecur.example/mcp" },
            { application: { id: "app-2" }, oauth_resource: "https://learnrecur.example/mcp" },
          ],
          list_metadata: { after: null },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(
      revokeWorkosAuthorizedApplications({
        workosUserId: "workos-user-1",
        apiKey: "sk_test_fixture",
        resourceUrl: "https://learnrecur.example/mcp",
        fetchImpl,
      }),
    ).resolves.toEqual({ revoked: 2 });

    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain("after=cursor-2");
    expect(String(fetchImpl.mock.calls[2]?.[0])).toContain("/authorized_applications/app-1");
    expect(String(fetchImpl.mock.calls[3]?.[0])).toContain("/authorized_applications/app-2");
    expect(fetchImpl.mock.calls[2]?.[1]).toMatchObject({ method: "DELETE" });
  });

  it("fails closed when WorkOS returns malformed grant inventory", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ data: [{ application: {} }], list_metadata: { after: null } }),
    );

    await expect(
      revokeWorkosAuthorizedApplications({
        workosUserId: "workos-user-1",
        apiKey: "sk_test_fixture",
        resourceUrl: "https://learnrecur.example/mcp",
        fetchImpl,
      }),
    ).rejects.toThrow(/invalid application/i);
  });

  it("leaves grants for unrelated OAuth resources untouched", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        data: [
          {
            application: { id: "other-app" },
            oauth_resource: "https://other.example/mcp",
          },
        ],
        list_metadata: { after: null },
      }),
    );

    await expect(
      revokeWorkosAuthorizedApplications({
        workosUserId: "workos-user-1",
        apiKey: "sk_test_fixture",
        resourceUrl: "https://learnrecur.example/mcp",
        fetchImpl,
      }),
    ).resolves.toEqual({ revoked: 0 });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
