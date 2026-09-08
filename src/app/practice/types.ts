import {
  AnswerKind,
  type ExerciseType,
  type FsrsRating,
  type SkillFsrsState,
} from "@/generated/prisma/enums";

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
      answerKind: typeof AnswerKind.TEXT | typeof AnswerKind.NUMERIC | typeof AnswerKind.MATH;
      prompt: string;
      difficulty: number | null;
      expectedSeconds: number | null;
    };

export type PracticeScope =
  | {
      kind: "all";
    }
  | {
      kind: "collection";
      collectionId: string;
      collectionName: string;
    };

export type PracticeItem =
  | {
      status: "ready";
      scope: PracticeScope;
      skill: {
        id: string;
        title: string;
        fsrsState: SkillFsrsState;
        repetitions: number;
        alreadyStudied?: boolean;
        lapses: number;
      };
      exercise: PracticeExercise;
    }
  | {
      status: "none-due";
      preparing?: boolean;
      dailyLimitReached?: boolean;
      message: string;
      scope: PracticeScope;
    }
  | {
      status: "unavailable";
      message: string;
      scope?: PracticeScope;
    };

export type ChoicePracticeItem = PracticeItem;

export type PracticePreviewResult =
  | {
      status: "checked";
      answerCheck: PracticeAnswerCheckResult;
      proposedRating: FsrsRating | null;
      correctChoiceId: string | null;
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

export type CustomPracticeSessionClientSummary = {
  id: string;
  mode: "PRACTICE_ONLY" | "SCHEDULED";
  mixedReview: boolean;
  status: "ACTIVE" | "STOPPED" | "COMPLETED";
  targetCount: number;
  completedCount: number;
};

export type CustomPracticeClientItem = {
  itemKey: string;
  exerciseId: string;
  skillId: string;
  skillTitle: string;
  answerKind: AnswerKind;
  exerciseType?: ExerciseType;
  prompt: string;
  choices: ChoiceOption[];
  difficulty: number | null;
  expectedSeconds: number | null;
};

export type CustomPracticeClientView =
  | {
      status: "ready";
      session: CustomPracticeSessionClientSummary;
      item: CustomPracticeClientItem;
    }
  | {
      status: "completed" | "stopped" | "preparing" | "daily-limit" | "unavailable";
      session?: CustomPracticeSessionClientSummary;
      message: string;
    };

export type CustomPracticeClientPreviewResult =
  | {
      status: "checked";
      answerCheck: PracticeAnswerCheckResult;
      correctChoiceId: string | null;
      correctAnswerDisplay: string;
      explanation: string | null;
    }
  | {
      status: "not-found" | "unavailable";
      message: string;
    };

export type CustomPracticeClientCommitResult =
  | {
      status: "committed";
      idempotent: boolean;
      completedCount: number;
      targetCount: number;
      next: CustomPracticeClientView;
    }
  | {
      status: "invalid-answer" | "not-found" | "conflict" | "not-presented" | "unavailable";
      message: string;
    };

export type CustomPracticeSessionCreateResult =
  | {
      status: "ready" | "preparing";
      sessionId: string;
      message?: string;
    }
  | {
      status: "unavailable";
      message: string;
    };
