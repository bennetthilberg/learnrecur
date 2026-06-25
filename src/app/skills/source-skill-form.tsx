"use client";

import { Card } from "@radix-ui/themes";
import { useActionState, useEffect, useRef } from "react";
import { ClipboardText } from "@phosphor-icons/react";

import { PressButton } from "@/components/app/open-water";
import { RadixTextArea, RadixTextField } from "@/components/app/radix-form";

import {
  generateSkillDraftFromSourceAction,
  type SkillFormActionState,
} from "./actions";
import type {
  SourceCreationNotice,
  SourceGenerationStatus,
} from "./source-creation-workspace";

const idleState: SkillFormActionState = {
  status: "idle",
  message: null,
};

type SourceSkillFormProps = {
  onGenerationEnd?: () => void;
  onGenerationStart?: (status: SourceGenerationStatus) => void;
  onNotice?: (notice: SourceCreationNotice | null) => void;
};

export function SourceSkillForm({
  onGenerationEnd,
  onGenerationStart,
  onNotice,
}: SourceSkillFormProps) {
  const sourceTextRef = useRef<HTMLTextAreaElement>(null);
  const submittedRef = useRef(false);
  const latestNoticeRef = useRef<string | null>(null);
  const [state, action, isGenerating] = useActionState(
    generateSkillDraftFromSourceAction,
    idleState,
  );

  useEffect(() => {
    sourceTextRef.current?.focus({ preventScroll: true });

    const animationFrame = window.requestAnimationFrame(() => {
      sourceTextRef.current?.focus({ preventScroll: true });
    });

    return () => {
      window.cancelAnimationFrame(animationFrame);
    };
  }, []);

  useEffect(() => {
    if (!submittedRef.current || isGenerating) {
      return;
    }

    if (state.status === "error") {
      submittedRef.current = false;
      onGenerationEnd?.();
    }
  }, [isGenerating, onGenerationEnd, state.status]);

  useEffect(() => {
    if (!state.message || state.status === "idle") {
      return;
    }

    const nextNoticeKey = `${state.status}:${state.message}`;

    if (latestNoticeRef.current === nextNoticeKey) {
      return;
    }

    latestNoticeRef.current = nextNoticeKey;
    onNotice?.({
      tone: state.status === "saved" ? "success" : "error",
      message: state.message,
    });
  }, [onNotice, state.message, state.status]);

  return (
    <Card asChild size="3" variant="surface">
      <form
        action={action}
        className="skillPanel skillSourceForm"
        onSubmit={() => {
          submittedRef.current = true;
          onNotice?.(null);
          onGenerationStart?.({
            title: "Creating a skill from your text",
            detail: "Reading the pasted material and preparing a focused skill for review.",
          });
        }}
      >
        <div className="skillPanelHeader">
          <div>
            <h2>Paste learning material</h2>
          </div>
          <span className="skillPanelHeaderIcon" aria-hidden="true">
            <ClipboardText size={18} weight="bold" />
          </span>
        </div>
        <p className="skillUploadIntro">
          Paste copied notes, excerpts, or worksheet text. You will review the generated skill
          before adding it.
        </p>

        <fieldset className="skillFormFieldset">
          <legend>Source text</legend>
          <div className="skillFormFieldsetBody">
            <RadixTextArea
              autoFocus
              error={state.fieldErrors?.sourceText?.[0]}
              inputRef={sourceTextRef}
              label="Learning material"
              name="sourceText"
              placeholder="Paste notes, a copied textbook excerpt, worksheet instructions, or a short explanation from class."
              required
              rows={9}
            />
          </div>
        </fieldset>

        <details
          className="skillFormDetails"
          open={
            state.fieldErrors?.sourceLabel?.length ||
              state.fieldErrors?.collectionName?.length ||
              state.fieldErrors?.focusNote?.length ||
              state.fieldErrors?.tags?.length
              ? true
              : undefined
          }
        >
          <summary>
            <span>Optional context</span>
            <small>Collection, focus, and tags</small>
          </summary>
          <div className="skillFormFieldsetBody">
            <div className="skillTwoColumnFields">
              <RadixTextField
                error={state.fieldErrors?.sourceLabel?.[0]}
                label="Source label"
                name="sourceLabel"
                placeholder="Spanish chapter notes"
              />
              <RadixTextField
                error={state.fieldErrors?.collectionName?.[0]}
                label="Collection"
                name="collectionName"
                placeholder="Spanish grammar"
              />
            </div>

            <RadixTextArea
              error={state.fieldErrors?.focusNote?.[0]}
              label="Focus note"
              name="focusNote"
              placeholder="Focus on when to choose ser vs. estar, not vocabulary memorization."
              rows={3}
            />

            <RadixTextField
              error={state.fieldErrors?.tags?.[0]}
              label="Tags"
              name="tags"
              placeholder="spanish, verbs, grammar"
            />
          </div>
        </details>

        <div className="skillFormActions">
          <PressButton className="primaryButton" disabled={isGenerating} type="submit">
            {isGenerating ? "Creating" : "Create skill from text"}
          </PressButton>
        </div>
      </form>
    </Card>
  );
}
