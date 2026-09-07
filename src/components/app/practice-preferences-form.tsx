"use client";
import { useState, useSyncExternalStore, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Checkbox, NativeSelect, Stack, Switch, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { CheckCircle, FloppyDisk, WarningCircle } from "@phosphor-icons/react";
import { savePracticePreferencesAction } from "@/app/settings/practice-preference-actions";
import {
  EXACT_TEXT_POLICY,
  NATURAL_TEXT_POLICY,
  type PracticePreference,
  type TextPolicy,
} from "@/lib/practice/policies";

type Props = {
  target: { scope: "user" } | { scope: "collection" | "skill"; id: string };
  preference: PracticePreference | null;
  inheritedPreference?: PracticePreference;
  textPolicy?: TextPolicy | null;
  inheritedTextPolicy?: TextPolicy;
  alreadyStudied?: boolean;
  mixedReview?: boolean;
};
const label = (value: PracticePreference) =>
  value === "RECALL_FIRST" ? "Recall first" : "Balanced";
const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;
export function PracticePreferencesForm(props: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // A native input can change before its React handler hydrates. Keep every
  // control disabled until its selected value can be retained and submitted.
  const hasHydrated = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  const disabled = pending || !hasHydrated;
  const [preference, setPreference] = useState(props.preference ?? "DEFAULT");
  const [profile, setProfile] = useState(
    props.textPolicy?.profile ?? "DEFAULT",
  );
  const [caseLenient, setCaseLenient] = useState(
    props.textPolicy?.normalizeCase ?? true,
  );
  const [spaceLenient, setSpaceLenient] = useState(
    props.textPolicy?.normalizeWhitespace ?? true,
  );
  const [studied, setStudied] = useState(props.alreadyStudied ?? false);
  const [mixed, setMixed] = useState(props.mixedReview ?? false);
  const effectivePreference =
    preference === "DEFAULT"
      ? (props.inheritedPreference ?? "BALANCED")
      : (preference as PracticePreference);
  const inheritedText = props.inheritedTextPolicy ?? NATURAL_TEXT_POLICY;
  const effectiveText =
    profile === "DEFAULT"
      ? inheritedText
      : profile === "NATURAL"
        ? NATURAL_TEXT_POLICY
        : profile === "EXACT"
          ? EXACT_TEXT_POLICY
          : {
              version: 2 as const,
              profile: "CUSTOM" as const,
              normalizeCase: caseLenient,
              normalizeWhitespace: spaceLenient,
            };
  return (
    <form
      className="practicePreferencesForm"
      onSubmit={(event) => {
        event.preventDefault();
        startTransition(async () => {
          const result = await savePracticePreferencesAction(
            props.target,
            props.target.scope === "user"
              ? { practicePreference: effectivePreference, mixedReview: mixed }
              : {
                  practicePreference:
                    preference === "DEFAULT" ? null : preference,
                  textPolicy: profile === "DEFAULT" ? null : effectiveText,
                  ...(props.target.scope === "skill"
                    ? { alreadyStudied: studied }
                    : {}),
                },
          ).catch(() => ({
            status: "error" as const,
            message: "Could not save practice preferences. Try again.",
          }));
          notifications.show({
            title:
              result.status === "saved"
                ? "Preferences saved"
                : "Could not save preferences",
            message: result.message,
            color: result.status === "saved" ? "leaf" : "amber",
            icon:
              result.status === "saved" ? (
                <CheckCircle size={18} />
              ) : (
                <WarningCircle size={18} />
              ),
            className: "learnrecurNotification",
            position: "top-right",
            withBorder: true,
            withCloseButton: true,
          });
          if (result.status === "saved") router.refresh();
        });
      }}
    >
      <Stack gap="md">
        <NativeSelect
          label="Practice preference"
          disabled={disabled}
          value={preference}
          onChange={(event) => setPreference(event.currentTarget.value)}
          data={[
            ...(props.target.scope === "user"
              ? []
              : [
                  {
                    value: "DEFAULT",
                    label: `Use default (${label(props.inheritedPreference ?? "BALANCED")})`,
                  },
                ]),
            { value: "BALANCED", label: "Balanced" },
            { value: "RECALL_FIRST", label: "Recall first" },
          ]}
          description={`Effective: ${label(effectivePreference)}. Recall first prefers suitable input exercises.`}
        />
        {props.target.scope === "skill" && (
          <Checkbox
            label="I have already studied this skill"
            description="Allow suitable input practice from the first review."
            checked={studied}
            disabled={disabled}
            onChange={(event) => setStudied(event.currentTarget.checked)}
          />
        )}
        {props.target.scope === "user" ? (
          <Switch
            label="Mixed review by default"
            description="Reduce rule cues and vary compatible due skills within your chosen scope. You can switch this during a session."
            checked={mixed}
            disabled={disabled}
            onChange={(event) => setMixed(event.currentTarget.checked)}
          />
        ) : (
          <>
            <NativeSelect
              label="Text comparison"
              disabled={disabled}
              value={profile}
              onChange={(event) =>
                setProfile(event.currentTarget.value as typeof profile)
              }
              data={[
                {
                  value: "DEFAULT",
                  label: `Use default (${inheritedText.profile === "EXACT" ? "Exact text" : inheritedText.profile === "CUSTOM" ? "Custom" : "Natural language"})`,
                },
                { value: "NATURAL", label: "Natural language" },
                { value: "EXACT", label: "Exact text" },
                { value: "CUSTOM", label: "Custom" },
              ]}
            />
            {profile === "CUSTOM" && (
              <>
                <Checkbox
                  label="Ignore capitalization"
                  checked={caseLenient}
                  disabled={disabled}
                  onChange={(event) =>
                    setCaseLenient(event.currentTarget.checked)
                  }
                />
                <Checkbox
                  label="Normalize whitespace"
                  checked={spaceLenient}
                  disabled={disabled}
                  onChange={(event) =>
                    setSpaceLenient(event.currentTarget.checked)
                  }
                />
              </>
            )}
            <Text size="sm">
              Letters and accents stay distinct. Effective comparison{" "}
              {effectiveText.normalizeCase ? "ignores" : "preserves"}{" "}
              capitalization and{" "}
              {effectiveText.normalizeWhitespace ? "normalizes" : "preserves"}{" "}
              whitespace. A change prepares future exercises; your review
              history stays intact.
            </Text>
          </>
        )}
        <div>
          <button className="primaryButton" disabled={disabled} type="submit">
            <FloppyDisk size={16} aria-hidden="true" />
            {pending ? "Saving" : "Save practice preferences"}
          </button>
        </div>
      </Stack>
    </form>
  );
}
