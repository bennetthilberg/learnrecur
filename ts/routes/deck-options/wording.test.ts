// Copyright: LearnRecur contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import { FluentBundle, FluentResource, setBundles } from "@generated/ftl";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, test } from "vitest";

import { newInsertOrderChoices } from "./choices";
import { deckOptionsWording } from "./wording";

beforeAll(() => {
    const bundle = new FluentBundle("en-US", { useIsolating: false });
    for (const module of ["deck-config", "scheduling"]) {
        const source = readFileSync(new URL(`../../../ftl/core/${module}.ftl`, import.meta.url), "utf8");
        expect(bundle.addResource(new FluentResource(source))).toEqual([]);
    }
    setBundles([bundle]);
});

afterAll(() => setBundles([]));

test("ordinary deck wording stays unchanged", () => {
    const wording = deckOptionsWording(false);
    expect(wording.newTitle).toBe("New Cards");
    expect(wording.newPerDay).toBe("New cards/day");
    expect(wording.sequential).toBe("Sequential (oldest cards first)");
    expect(wording.ignoreReviewLimit).toBe("New cards ignore review limit");
    expect(wording.reschedule).toBe("Reschedule cards on change");
    expect(wording.collectionScope).toBe("Affects the entire collection.");
    expect(wording.presetScope).toBeUndefined();
    expect(wording.reviewsTooLow(25, 250)).toBe(
        "If adding 25 new cards each day, your review limit should be at least 250.",
    );
});

test("skill limits count scheduled skills rather than generated exercises", () => {
    const wording = deckOptionsWording(true);
    expect(wording.newTitle).toBe("New skills");
    expect(wording.newPerDay).toBe("New skills/day");
    expect(wording.sequential).toBe("Sequential (oldest skills first)");
    expect(wording.newLimitHelp).toContain("one schedule");
    expect(wording.newLimitHelp).toContain("do not count as new skills");
    expect(wording.reviewsTooLow(25, 250)).toBe(
        "If adding 25 new skills each day, your review limit should be at least 250.",
    );
    expect(wording.reviewsTooLow(1, 10)).toBe(
        "If adding 1 new skill each day, your review limit should be at least 10.",
    );
    expect(newInsertOrderChoices(true).map(({ value }) => value)).toEqual(
        newInsertOrderChoices().map(({ value }) => value),
    );
});

test("shared presets and global controls include ordinary decks", () => {
    const wording = deckOptionsWording(true);
    expect(wording.presetScope).toContain("every deck using this preset, including ordinary decks");
    expect(wording.tabsHelp).toContain("skills in skill decks and cards in ordinary decks");
    expect(wording.tabsHelp).toContain("This deck");
    expect(wording.tabsHelp).toContain("Today only");
    expect(wording.ignoreReviewLimit).toBe("New cards and skills ignore review limit");
    expect(wording.reschedule).toBe("Reschedule cards and skills on change");
    expect(wording.collectionScope).toContain("entire collection, including ordinary cards and skills");
});
