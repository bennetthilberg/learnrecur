import { afterEach, describe, expect, it, vi } from "vitest";

const clerkMocks = vi.hoisted(() => ({
  getUser: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({
  clerkClient: vi.fn(async () => ({
    users: {
      getUser: clerkMocks.getUser,
    },
  })),
}));

import {
  buildPracticeUrl,
  buildReminderIdempotencyKey,
  buildSettingsUrl,
  getReminderLocalDate,
  isReminderLocalHourDue,
  normalizeReminderPreferenceInput,
  renderDueReminderEmail,
  resolveClerkReminderAccountEmail,
} from "@/lib/reminders";

afterEach(() => {
  clerkMocks.getUser.mockReset();
});

describe("reminder preference input", () => {
  it("normalizes enabled reminder settings", () => {
    expect(
      normalizeReminderPreferenceInput({
        enabled: "on",
        email: " learner@example.com ",
        localHour: "9",
        timezone: " America/New_York ",
        minimumDueCount: "2",
      }),
    ).toEqual({
      status: "valid",
      input: {
        enabled: true,
        email: "learner@example.com",
        localHour: 9,
        timezone: "America/New_York",
        minimumDueCount: 2,
      },
    });
  });

  it("normalizes omitted checkbox values to disabled", () => {
    expect(
      normalizeReminderPreferenceInput({
        email: "learner@example.com",
        localHour: 9,
        timezone: "America/New_York",
        minimumDueCount: 1,
      }),
    ).toEqual({
      status: "valid",
      input: {
        enabled: false,
        email: "learner@example.com",
        localHour: 9,
        timezone: "America/New_York",
        minimumDueCount: 1,
      },
    });
  });

  it("allows disabled reminder settings without an email", () => {
    expect(
      normalizeReminderPreferenceInput({
        enabled: false,
        email: "",
        localHour: 9,
        timezone: "America/New_York",
        minimumDueCount: 1,
      }),
    ).toEqual({
      status: "valid",
      input: {
        enabled: false,
        email: "",
        localHour: 9,
        timezone: "America/New_York",
        minimumDueCount: 1,
      },
    });
  });

  it("rejects invalid reminder settings with field errors", () => {
    const result = normalizeReminderPreferenceInput({
      enabled: "maybe",
      email: "not email",
      localHour: "24",
      timezone: "Not/AZone",
      minimumDueCount: "0",
    });

    expect(result.status).toBe("invalid");
    expect(result).toMatchObject({
      fieldErrors: {
        enabled: expect.arrayContaining([expect.any(String)]),
        localHour: expect.arrayContaining(["Choose an hour from 0 to 23."]),
        timezone: expect.arrayContaining(["Choose a valid IANA timezone."]),
        minimumDueCount: expect.arrayContaining([
          "Minimum due count must be at least 1.",
        ]),
      },
    });
  });

  it("rejects enabled reminder settings without a valid email", () => {
    const result = normalizeReminderPreferenceInput({
      enabled: true,
      email: "not email",
      localHour: 9,
      timezone: "America/New_York",
      minimumDueCount: 1,
    });

    expect(result.status).toBe("invalid");
    expect(result).toMatchObject({
      fieldErrors: {
        email: expect.arrayContaining(["Enter a valid email address."]),
      },
    });
  });
});

describe("reminder scheduling helpers", () => {
  it("detects local reminder hours and local dates", () => {
    const now = new Date("2026-06-04T13:00:00.000Z");

    expect(
      isReminderLocalHourDue(now, {
        localHour: 9,
        timezone: "America/New_York",
      }),
    ).toBe(true);
    expect(
      isReminderLocalHourDue(now, {
        localHour: 8,
        timezone: "America/New_York",
      }),
    ).toBe(false);
    expect(getReminderLocalDate(now, "America/New_York")).toBe("2026-06-04");
  });

  it("builds deterministic practice URLs and idempotency keys", () => {
    expect(buildPracticeUrl("https://learnrecur.example")).toBe(
      "https://learnrecur.example/practice",
    );
    expect(buildSettingsUrl("https://learnrecur.example")).toBe(
      "https://learnrecur.example/settings",
    );
    expect(buildReminderIdempotencyKey("user_123", "2026-06-04")).toBe(
      "learnrecur:due-reminder:user_123:2026-06-04",
    );
  });
});

describe("clerk reminder account email resolution", () => {
  it("returns the primary Clerk email only when it is verified", async () => {
    clerkMocks.getUser
      .mockResolvedValueOnce({
        primaryEmailAddress: {
          emailAddress: "verified@example.com",
          verification: {
            status: "verified",
          },
        },
      })
      .mockResolvedValueOnce({
        primaryEmailAddress: {
          emailAddress: "unverified@example.com",
          verification: {
            status: "failed",
          },
        },
      })
      .mockResolvedValueOnce({
        primaryEmailAddress: null,
      });

    await expect(resolveClerkReminderAccountEmail("user_verified")).resolves.toBe(
      "verified@example.com",
    );
    await expect(resolveClerkReminderAccountEmail("user_unverified")).resolves.toBeNull();
    await expect(resolveClerkReminderAccountEmail("user_missing_email")).resolves.toBeNull();
  });

  it("returns null when the Clerk user no longer exists", async () => {
    clerkMocks.getUser.mockRejectedValueOnce({ status: 404 });

    await expect(resolveClerkReminderAccountEmail("user_deleted")).resolves.toBeNull();
  });
});

describe("reminder email rendering", () => {
  it("keeps email content count-only and private", () => {
    const email = renderDueReminderEmail({
      dueCount: 3,
      practiceUrl: "https://learnrecur.example/practice",
      settingsUrl: "https://learnrecur.example/settings",
    });
    const combined = `${email.subject}\n${email.text}\n${email.html}`;

    expect(email.subject).toBe("3 skills are ready for practice");
    expect(combined).toContain("3 skills are");
    expect(combined).toContain("https://learnrecur.example/practice");
    expect(combined).toContain("https://learnrecur.example/settings");
    expect(combined).not.toMatch(/ser vs estar|source|answer|exercise/i);
  });
});
