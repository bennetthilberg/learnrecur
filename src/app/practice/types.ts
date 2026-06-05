import { AnswerKind, type FsrsRating, type SkillFsrsState } from "@/generated/prisma/enums";

export type PracticeAnswerCheckResult = {
  status: "correct" | "incorrect" | "invalid-input" | "invalid-spec" | "unsupported";
  isCorrect: boolean;
  normalizedAnswer: string | null;
  reason?: string;
  message?: string;
};

export type ChoicePracticeAnswerCheckResult = PracticeAnswerCheckResult;

export type ChoiceOption = {
  id: string;
  label: string;
};

export type PracticeExercise =
  | {
      id: string;
      skillId: string;
      answerKind: typeof AnswerKind.CHOICE;
      prompt: string;
      choices: ChoiceOption[];
      difficulty: number | null;
      expectedSeconds: number | null;
    }
  | {
      id: string;
      skillId: string;
      answerKind: typeof AnswerKind.TEXT | typeof AnswerKind.NUMERIC;
      prompt: string;
      difficulty: number | null;
      expectedSeconds: number | null;
    };

export type PracticeItem =
  | {
      status: "ready";
      skill: {
        id: string;
        title: string;
        fsrsState: SkillFsrsState;
        repetitions: number;
        lapses: number;
      };
      exercise: PracticeExercise;
    }
  | {
      status: "none-due";
      message: string;
    }
  | {
      status: "unavailable";
      message: string;
    };

export type ChoicePracticeItem = PracticeItem;

export type PracticePreviewResult =
  | {
      status: "checked";
      answerCheck: PracticeAnswerCheckResult;
      proposedRating: FsrsRating | null;
      correctAnswerDisplay: string;
      explanation: string | null;
    }
  | {
      status: "not-found";
      message: string;
    };

export type ChoicePracticePreviewResult = PracticePreviewResult;

export type PracticeCommitResult =
  | {
      status: "committed";
      idempotent: boolean;
      finalRating: FsrsRating;
      nextItem: PracticeItem;
    }
  | {
      status: "not-committed";
      answerCheck: PracticeAnswerCheckResult;
      message: string;
    }
  | {
      status: "not-found";
      message: string;
    }
  | {
      status: "conflict";
      message: string;
    };

export type ChoicePracticeCommitResult = PracticeCommitResult;

export type PracticeFlagResult =
  | {
      status: "flagged";
      message: string;
      nextItem: PracticeItem;
    }
  | {
      status: "not-flagged";
      message: string;
    }
  | {
      status: "not-found";
      message: string;
    };

export type ChoicePracticeFlagResult = PracticeFlagResult;

export type ChoicePracticeSeedResult =
  | {
      status: "ready";
      message: string;
      skillCount: number;
      exerciseCount: number;
      nextItem: PracticeItem;
    }
  | {
      status: "disabled" | "error";
      message: string;
    };
