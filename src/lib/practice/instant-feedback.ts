import { checkAnswer, choiceAnswerSpecSchema } from "@/lib/answer-checking";
import { mapAttemptToFsrsRating } from "@/lib/scheduling/rating";

export type PracticeCheckingData = {
  answerSpec: unknown;
  correctAnswerDisplay: string;
  explanation: string | null;
};

// The same deterministic checker runs again on the server when saving. This
// preview never authorizes a review or changes the learner's schedule.
export function getInstantPracticeFeedback(
  exercise: PracticeCheckingData & { choices?: unknown },
  submittedAnswer: string,
) {
  const answerCheck = checkAnswer({ answerSpec: exercise.answerSpec, choices: exercise.choices, submittedAnswer });
  const choice = choiceAnswerSpecSchema.safeParse(exercise.answerSpec);
  return {
    status: "checked" as const,
    answerCheck,
    proposedRating: answerCheck.status === "correct" || answerCheck.status === "incorrect"
      ? mapAttemptToFsrsRating({ isCorrect: answerCheck.isCorrect }) : null,
    correctChoiceId: choice.success ? choice.data.correctChoiceId : null,
    correctAnswerDisplay: exercise.correctAnswerDisplay,
    explanation: exercise.explanation,
  };
}
