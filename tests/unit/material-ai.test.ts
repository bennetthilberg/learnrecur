import { afterEach, describe, expect, it, vi } from "vitest";

const geminiGenerateContentMock = vi.hoisted(() => vi.fn());

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = {
      generateContent: geminiGenerateContentMock,
    };
  },
}));

import {
  createMaterialDraftAiSetup,
  materialScopePlannerJsonSchema,
  type MaterialScopePlannerInput,
} from "@/lib/materials/ai";
import type { MaterialScopeResolution } from "@/lib/materials/contracts";

afterEach(() => {
  geminiGenerateContentMock.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const gemini = {
  apiMode: "enterprise-agent-platform" as const,
  endpoint: "https://aiplatform.googleapis.com/",
  model: "gemini-3.5-flash",
  clientOptions: {
    vertexai: true,
    apiKey: "enterprise-key",
    httpOptions: {
      apiVersion: "v1",
    },
  },
};

const openRouterFallback = {
  apiKey: "sk-or-test",
  baseUrl: "https://openrouter.ai/api/v1",
  model: "google/gemma-4-31b-it",
};

const plannerInput: MaterialScopePlannerInput = {
  materialTitle: "Practical Spanish Grammar",
  materialKind: "PDF",
  instruction: "make skills for the reflexive verb rules",
  structuralReferences: [],
  sections: [
    {
      id: "section-reflexive-verbs",
      parentId: null,
      ordinal: 1,
      level: 1,
      title: "Reflexive verbs",
      pageStart: 193,
      pageEnd: 205,
      url: null,
      anchor: null,
    },
  ],
  chunks: [
    {
      id: "chunk-reflexive-verbs",
      materialSectionId: "section-reflexive-verbs",
      headingText: "Reflexive verbs",
      text: "Reflexive verbs use a reflexive pronoun that agrees with the subject.",
    },
  ],
};

const rawScopePlan = {
  resolutionStatus: "resolved",
  resolvedScopeLabel: "Reflexive verb rules",
  clarification: null,
  clarificationOptions: [],
  warnings: [],
  items: [
    {
      key: "reflexive-pronouns",
      title: "Using Spanish Reflexive Pronouns",
      objective: "Choose the reflexive pronoun that agrees with the sentence subject.",
      includeConcepts: ["reflexive pronoun agreement"],
      excludeConcepts: ["reciprocal constructions"],
      materialSectionIds: ["section-reflexive-verbs"],
      evidenceChunkIds: ["chunk-reflexive-verbs"],
    },
  ],
};

const candidatePlan: MaterialScopeResolution = {
  version: 1,
  materialRevisionId: "revision-1",
  instruction: plannerInput.instruction,
  resolutionStatus: "resolved",
  resolvedScopeLabel: rawScopePlan.resolvedScopeLabel,
  warnings: [],
  items: [
    {
      ...rawScopePlan.items[0],
      locator: {
        version: 1,
        materialRevisionId: "revision-1",
        materialSectionIds: ["section-reflexive-verbs"],
        evidenceChunkIds: ["chunk-reflexive-verbs"],
        source: {
          kind: "pdf",
          pageRanges: [{ start: 193, end: 205 }],
        },
      },
    },
  ],
};

const target = {
  title: "Using Spanish Reflexive Pronouns",
  objective: "Choose the reflexive pronoun that agrees with the sentence subject.",
  includeConcepts: ["reflexive pronoun agreement"],
  excludeConcepts: ["reciprocal constructions"],
};

const generatedDraft = {
  title: target.title,
  objective: target.objective,
  rules: ["The reflexive pronoun agrees with the subject."],
  examples: ["Yo me levanto."],
  exerciseConstraints: "Use one sentence per exercise.",
  tags: ["spanish", "reflexive-verbs"],
};

function retryableGeminiError(code: 429 | 503, status: "RESOURCE_EXHAUSTED" | "UNAVAILABLE") {
  return new Error(
    JSON.stringify({
      error: {
        code,
        status,
        message: "The Gemini model is temporarily unavailable.",
      },
    }),
  );
}

function openRouterResponse(value: unknown) {
  return new Response(
    JSON.stringify({
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: JSON.stringify(value),
          },
        },
      ],
      model: openRouterFallback.model,
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    },
  );
}

function parseOpenRouterRequest(init: RequestInit | undefined) {
  return JSON.parse(String(init?.body)) as {
    messages: Array<{ role: string; content: unknown }>;
    response_format: {
      json_schema: {
        name: string;
        schema: Record<string, unknown>;
        strict: boolean;
      };
    };
  };
}

describe("material AI OpenRouter fallback", () => {
  it("falls back to OpenRouter when Gemini scope planning is rate limited", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const warningSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    geminiGenerateContentMock.mockRejectedValueOnce(
      retryableGeminiError(429, "RESOURCE_EXHAUSTED"),
    );
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
      void _url;
      void _init;
      return openRouterResponse(rawScopePlan);
    });
    vi.stubGlobal("fetch", fetchMock);

    const setup = createMaterialDraftAiSetup({ gemini, openRouterFallback });
    const result = await setup.planScope(plannerInput);

    expect(result).toEqual(rawScopePlan);
    expect(geminiGenerateContentMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warningSpy).toHaveBeenCalledWith(
      "[ai] retrying with fallback provider",
      expect.objectContaining({
        operation: "material scope planning",
        failedModel: gemini.model,
        fallbackProvider: "openrouter",
        fallbackModel: openRouterFallback.model,
      }),
    );

    const request = parseOpenRouterRequest(fetchMock.mock.calls[0][1]);
    expect(request.response_format.json_schema).toMatchObject({
      name: "materialScopePlan",
      schema: materialScopePlannerJsonSchema,
      strict: true,
    });
    expect(JSON.stringify(request.messages[1].content)).toContain(plannerInput.instruction);
  });

  it("falls back to OpenRouter for scope review and includes the candidate plan", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    geminiGenerateContentMock.mockRejectedValueOnce(retryableGeminiError(503, "UNAVAILABLE"));
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
      void _url;
      void _init;
      return openRouterResponse(rawScopePlan);
    });
    vi.stubGlobal("fetch", fetchMock);

    const setup = createMaterialDraftAiSetup({ gemini, openRouterFallback });
    const result = await setup.reviewScope?.({ ...plannerInput, candidatePlan });

    expect(result).toEqual(rawScopePlan);
    expect(geminiGenerateContentMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const request = parseOpenRouterRequest(fetchMock.mock.calls[0][1]);
    expect(request.response_format.json_schema).toMatchObject({
      name: "materialScopeReview",
      strict: true,
    });
    const prompt = JSON.stringify(request.messages[1].content);
    expect(prompt).toContain("Candidate plan:");
    expect(prompt).toContain(candidatePlan.items[0].title);
  });

  it("does not fall back when Gemini rejects an invalid scope request", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    geminiGenerateContentMock.mockRejectedValueOnce(
      new Error(
        JSON.stringify({
          error: {
            code: 400,
            status: "INVALID_ARGUMENT",
            message: "The request is invalid.",
          },
        }),
      ),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const setup = createMaterialDraftAiSetup({ gemini, openRouterFallback });

    await expect(setup.planScope(plannerInput)).rejects.toThrow("INVALID_ARGUMENT");
    expect(geminiGenerateContentMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back for target repair, draft generation, and PDF-backed verification", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    geminiGenerateContentMock.mockRejectedValue(
      retryableGeminiError(503, "UNAVAILABLE"),
    );

    const repairedTarget = {
      status: "repaired",
      title: target.title,
      objective: target.objective,
      includeConcepts: target.includeConcepts,
      excludeConcepts: target.excludeConcepts,
      note: "Removed an unsupported nearby concept.",
    };
    const verification = {
      verdict: "verified",
      reasons: [],
      note: null,
      recovery: "none",
    };
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const request = parseOpenRouterRequest(init);
      const schemaName = request.response_format.json_schema.name;

      if (schemaName === "materialDraftTargetRepair") {
        return openRouterResponse(repairedTarget);
      }
      if (schemaName === "skillDraft") {
        return openRouterResponse({ drafts: [generatedDraft] });
      }
      if (schemaName === "materialDraftVerification") {
        return openRouterResponse(verification);
      }

      throw new Error(`Unexpected OpenRouter schema: ${schemaName}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const setup = createMaterialDraftAiSetup({ gemini, openRouterFallback });
    const repaired = await setup.repairTarget?.({
      target,
      materialTitle: plannerInput.materialTitle,
      evidenceText: plannerInput.chunks[0].text,
      verificationNote: "The first version included an unsupported nearby concept.",
    });
    const draft = await setup.generateDraft({
      sourceText: plannerInput.chunks[0].text,
      sourceLabel: plannerInput.materialTitle,
      focusNote: target.objective,
      collectionName: null,
      tags: ["spanish"],
      sourceContext: plannerInput.chunks[0].text,
    });
    const verified = await setup.verifyDraft({
      target,
      draft: generatedDraft,
      materialTitle: plannerInput.materialTitle,
      evidenceText: plannerInput.chunks[0].text,
      sourceMedia: [
        {
          sourceFileId: "source-pdf-1",
          label: "reflexive verbs pages.pdf",
          mimeType: "application/pdf",
          bytes: Buffer.from("%PDF source slice"),
        },
      ],
    });

    expect(repaired).toEqual(repairedTarget);
    expect(draft).toEqual({ drafts: [generatedDraft] });
    expect(verified).toEqual(verification);
    expect(geminiGenerateContentMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const requests = fetchMock.mock.calls.map((call) => parseOpenRouterRequest(call[1]));
    expect(
      requests.map((request) => request.response_format.json_schema.name),
    ).toEqual(["materialDraftTargetRepair", "skillDraft", "materialDraftVerification"]);
    expect(requests[2].messages[1].content).toEqual(
      expect.arrayContaining([
        {
          type: "file",
          file: {
            filename: "reflexive verbs pages.pdf",
            file_data: `data:application/pdf;base64,${Buffer.from("%PDF source slice").toString("base64")}`,
          },
        },
      ]),
    );
  });
});
