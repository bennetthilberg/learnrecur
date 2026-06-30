export type PracticeShortcutAnswerKind = "CHOICE" | "TEXT" | "NUMERIC" | "MATH";

export type PracticeShortcutTargetRole = "document" | "answer-input" | "form-control";

export type PracticeShortcutIntent =
  | {
      type: "check-answer";
    }
  | {
      type: "close-report";
    }
  | {
      type: "continue";
    }
  | {
      choiceIndex: number;
      type: "select-choice";
    }
  | {
      rating: PracticeShortcutRating;
      type: "set-rating";
    }
  | {
      type: "none";
    };

export type PracticeShortcutRating = "hard" | "good" | "easy";

export type PracticeShortcutInput = {
  answerKind: PracticeShortcutAnswerKind;
  answerReady: boolean;
  choiceCount: number;
  feedbackVisible: boolean;
  flagFormOpen: boolean;
  key: string;
  pending: boolean;
  ratingAvailable: boolean;
  targetRole: PracticeShortcutTargetRole;
};

const NO_SHORTCUT: PracticeShortcutIntent = { type: "none" };

export function getPracticeShortcutIntent(input: PracticeShortcutInput): PracticeShortcutIntent {
  if (input.pending) {
    return NO_SHORTCUT;
  }

  if (input.flagFormOpen && input.key === "Escape") {
    return { type: "close-report" };
  }

  if (input.flagFormOpen) {
    return NO_SHORTCUT;
  }

  if (input.key === "Enter" && input.targetRole === "form-control") {
    return NO_SHORTCUT;
  }

  if (input.key === "Enter" && input.feedbackVisible) {
    return { type: "continue" };
  }

  if (input.ratingAvailable) {
    const rating = keyToRating(input.key);

    if (rating !== null) {
      return {
        rating,
        type: "set-rating",
      };
    }
  }

  if (input.targetRole === "form-control") {
    return NO_SHORTCUT;
  }

  if (input.targetRole === "answer-input") {
    if (input.key === "Enter" && !input.feedbackVisible && input.answerReady) {
      return { type: "check-answer" };
    }

    return NO_SHORTCUT;
  }

  if (input.key === "Enter") {
    if (input.answerReady) {
      return { type: "check-answer" };
    }

    return NO_SHORTCUT;
  }

  if (input.answerKind !== "CHOICE" || input.feedbackVisible) {
    return NO_SHORTCUT;
  }

  const choiceIndex = keyToChoiceIndex(input.key);

  if (choiceIndex === null || choiceIndex >= input.choiceCount) {
    return NO_SHORTCUT;
  }

  return {
    choiceIndex,
    type: "select-choice",
  };
}

function keyToChoiceIndex(key: string): number | null {
  if (!/^[1-9]$/.test(key)) {
    return null;
  }

  return Number.parseInt(key, 10) - 1;
}

function keyToRating(key: string): PracticeShortcutRating | null {
  if (key === "2") {
    return "hard";
  }

  if (key === "3") {
    return "good";
  }

  if (key === "4") {
    return "easy";
  }

  return null;
}
