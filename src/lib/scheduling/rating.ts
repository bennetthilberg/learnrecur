import { FsrsRating } from "@/generated/prisma/enums";

export type MapAttemptToFsrsRatingInput = {
  isCorrect: boolean;
  responseMs?: number | null;
  expectedSeconds?: number | null;
  manualRating?: FsrsRating | null;
};

export function mapAttemptToFsrsRating(input: MapAttemptToFsrsRatingInput): FsrsRating {
  if (!input.isCorrect) {
    return FsrsRating.AGAIN;
  }

  if (
    input.manualRating === FsrsRating.HARD ||
    input.manualRating === FsrsRating.GOOD ||
    input.manualRating === FsrsRating.EASY
  ) {
    return input.manualRating;
  }

  return FsrsRating.GOOD;
}
