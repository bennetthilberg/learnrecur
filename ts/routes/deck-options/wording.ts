// Copyright: LearnRecur contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

import * as tr from "@generated/ftl";

export function deckOptionsWording(skillDeck: boolean) {
    return {
        newTitle: skillDeck ? tr.deckConfigNewSkills() : tr.schedulingNewCards(),
        newPerDay: skillDeck ? tr.deckConfigNewSkillsday() : tr.schedulingNewCardsday(),
        sequential: skillDeck
            ? tr.deckConfigNewInsertionOrderSkills()
            : tr.deckConfigNewInsertionOrderSequential(),
        reviewsTooLow: (count: number, expected: number) =>
            skillDeck
                ? tr.deckConfigSkillsReviewsTooLow({ count, expected })
                : tr.deckConfigReviewsTooLow({ cards: count, expected }),
        newLimitHelp: skillDeck
            ? tr.deckConfigNewSkillsLimitTooltip()
            : tr.deckConfigNewLimitTooltip(),
        insertionHelp: skillDeck
            ? tr.deckConfigSkillInsertionOrderTooltip()
            : tr.deckConfigNewInsertionOrderTooltip(),
        tabsHelp: skillDeck
            ? tr.deckConfigSkillLimitTabs()
            : tr.deckConfigTabDescription(),
        ignoreReviewLimit: skillDeck
            ? tr.deckConfigNewCardsAndSkillsIgnoreReviewLimit()
            : tr.deckConfigNewCardsIgnoreReviewLimit(),
        reschedule: skillDeck
            ? tr.deckConfigRescheduleCardsAndSkillsOnChange()
            : tr.deckConfigRescheduleCardsOnChange(),
        collectionScope: skillDeck
            ? tr.deckConfigCardsAndSkillsCollectionScope()
            : tr.deckConfigAffectsEntireCollection(),
        presetScope: skillDeck ? tr.deckConfigCardsAndSkillsPresetScope() : undefined,
    };
}
