import type { FsrsRating, SkillFsrsState } from "@/generated/prisma/enums";

export type ChoicePracticeAnswerCheckResult = {
  status: "correct" | "incorrect" | "invalid-input" | "invalid-spec" | "unsupported";
  isCorrect: boolean;
  normalizedAnswer: string | null;
  reason?: string;
  message?: string;
};

export type ChoiceOption = {
  id: string;
  label: string;
};

export type ChoicePracticeItem =
  | {
      status: "ready";
      skill: {
        id: string;
        title: string;
        fsrsState: SkillFsrsState;
        repetitions: number;
        lapses: number;
      };
      exercise: {
        id: string;
        skillId: string;
        prompt: string;
        choices: ChoiceOption[];
        difficulty: number | null;
        expectedSeconds: number | null;
      };
    }
  | {
      status: "none-due";
      message: string;
    };

export type ChoicePracticePreviewResult =
  | {
      status: "checked";
      answerCheck: ChoicePracticeAnswerCheckResult;
      proposedRating: FsrsRating | null;
      correctAnswerDisplay: string;
      explanation: string | null;
    }
  | {
      status: "not-found";
      message: string;
    };

export type ChoicePracticeCommitResult =
  | {
      status: "committed";
      idempotent: boolean;
      finalRating: FsrsRating;
      nextItem: ChoicePracticeItem;
    }
  | {
      status: "not-committed";
      answerCheck: ChoicePracticeAnswerCheckResult;
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

export type ChoicePracticeSeedResult =
  | {
      status: "ready";
      message: string;
      skillCount: number;
      exerciseCount: number;
      nextItem: ChoicePracticeItem;
    }
  | {
      status: "disabled" | "error";
      message: string;
    };
