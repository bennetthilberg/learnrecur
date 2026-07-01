import { describe, expect, it } from "vitest";

import { getPracticeShortcutIntent, type PracticeShortcutInput } from "@/lib/practice-shortcuts";

const defaultInput: PracticeShortcutInput = {
  answerKind: "CHOICE",
  answerReady: false,
  choiceCount: 4,
  feedbackVisible: false,
  flagFormOpen: false,
  key: "1",
  pending: false,
  ratingAvailable: false,
  targetRole: "document",
};

describe("getPracticeShortcutIntent", () => {
  it("selects visible multiple-choice options by number before feedback", () => {
    expect(getPracticeShortcutIntent({ ...defaultInput, key: "1" })).toEqual({
      choiceIndex: 0,
      type: "select-choice",
    });
    expect(getPracticeShortcutIntent({ ...defaultInput, key: "4" })).toEqual({
      choiceIndex: 3,
      type: "select-choice",
    });
  });

  it("ignores number keys that do not map to a visible choice", () => {
    expect(getPracticeShortcutIntent({ ...defaultInput, key: "5" })).toEqual({ type: "none" });
    expect(getPracticeShortcutIntent({ ...defaultInput, key: "0" })).toEqual({ type: "none" });
  });

  it("does not select choices after feedback is visible", () => {
    expect(getPracticeShortcutIntent({ ...defaultInput, feedbackVisible: true, key: "1" })).toEqual({
      type: "none",
    });
  });

  it("maps number keys to review ratings when rating is available", () => {
    expect(
      getPracticeShortcutIntent({
        ...defaultInput,
        feedbackVisible: true,
        key: "2",
        ratingAvailable: true,
      }),
    ).toEqual({ rating: "hard", type: "set-rating" });
    expect(
      getPracticeShortcutIntent({
        ...defaultInput,
        feedbackVisible: true,
        key: "3",
        ratingAvailable: true,
      }),
    ).toEqual({ rating: "good", type: "set-rating" });
    expect(
      getPracticeShortcutIntent({
        ...defaultInput,
        feedbackVisible: true,
        key: "4",
        ratingAvailable: true,
        targetRole: "form-control",
      }),
    ).toEqual({ rating: "easy", type: "set-rating" });
  });

  it("does not map rating keys while the report form is open", () => {
    expect(
      getPracticeShortcutIntent({
        ...defaultInput,
        flagFormOpen: true,
        key: "3",
        ratingAvailable: true,
      }),
    ).toEqual({ type: "none" });
  });

  it("maps Enter to check before feedback and continue after feedback", () => {
    expect(
      getPracticeShortcutIntent({
        ...defaultInput,
        answerReady: true,
        key: "Enter",
      }),
    ).toEqual({ type: "check-answer" });
    expect(
      getPracticeShortcutIntent({
        ...defaultInput,
        answerReady: true,
        feedbackVisible: true,
        key: "Enter",
      }),
    ).toEqual({ type: "continue" });
  });

  it("lets focused controls handle Enter after feedback", () => {
    expect(
      getPracticeShortcutIntent({
        ...defaultInput,
        answerReady: true,
        feedbackVisible: true,
        key: "Enter",
        ratingAvailable: true,
        targetRole: "form-control",
      }),
    ).toEqual({ type: "none" });
  });

  it("does not check an empty answer", () => {
    expect(getPracticeShortcutIntent({ ...defaultInput, key: "Enter" })).toEqual({ type: "none" });
  });

  it("lets exact answer inputs use Enter to check without stealing ordinary typing", () => {
    expect(
      getPracticeShortcutIntent({
        ...defaultInput,
        answerKind: "TEXT",
        answerReady: true,
        key: "Enter",
        targetRole: "answer-input",
      }),
    ).toEqual({ type: "check-answer" });
    expect(
      getPracticeShortcutIntent({
        ...defaultInput,
        answerKind: "NUMERIC",
        answerReady: true,
        key: "1",
        targetRole: "answer-input",
      }),
    ).toEqual({ type: "none" });
  });

  it("suppresses shortcuts in report and form controls", () => {
    expect(
      getPracticeShortcutIntent({
        ...defaultInput,
        answerReady: true,
        key: "Enter",
        targetRole: "form-control",
      }),
    ).toEqual({ type: "none" });
    expect(
      getPracticeShortcutIntent({
        ...defaultInput,
        key: "2",
        targetRole: "form-control",
      }),
    ).toEqual({ type: "none" });
  });

  it("closes the report form with Escape even from a form control", () => {
    expect(
      getPracticeShortcutIntent({
        ...defaultInput,
        flagFormOpen: true,
        key: "Escape",
        targetRole: "form-control",
      }),
    ).toEqual({ type: "close-report" });
  });

  it("does nothing while another practice action is pending", () => {
    expect(
      getPracticeShortcutIntent({
        ...defaultInput,
        answerReady: true,
        key: "Enter",
        pending: true,
      }),
    ).toEqual({ type: "none" });
    expect(
      getPracticeShortcutIntent({
        ...defaultInput,
        key: "1",
        pending: true,
      }),
    ).toEqual({ type: "none" });
  });
});
