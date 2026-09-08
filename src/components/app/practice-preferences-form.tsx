"use client";
import { useState, useSyncExternalStore, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Checkbox,
  NativeSelect,
  NumberInput,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { CheckCircle, FloppyDisk, WarningCircle } from "@phosphor-icons/react";
import { savePracticePreferencesAction } from "@/app/settings/practice-preference-actions";
import {
  EXACT_TEXT_POLICY,
  NATURAL_TEXT_POLICY,
  type PracticePreference,
  type TextPolicy,
} from "@/lib/practice/policies";

import {
  dailyNewSkillLimitSchema,
  formatPracticeDayStart,
  parsePracticeDayStart,
  practiceDayStartTimeSchema,
  practiceTimezoneSchema,
} from "@/lib/practice/daily-limit-contracts";
import { desiredRetentionSchema } from "@/lib/scheduling/contracts";

const practiceTimezones = ["UTC", ...Intl.supportedValuesOf("timeZone")];

type Props = {
  dailyNewSkillLimit?: number | null;
  practiceTimezone?: string;
  desiredRetention?: number | null;
  practiceDayStartMinutes?: number;
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
  const hasHydrated = useSyncExternalStore(
    subscribe,
    clientSnapshot,
    serverSnapshot,
  );
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
  const [unlimited, setUnlimited] = useState(props.dailyNewSkillLimit == null);
  const [dailyLimit, setDailyLimit] = useState<number | string>(
    props.dailyNewSkillLimit ?? 20,
  );
  const [timezone, setTimezone] = useState(props.practiceTimezone ?? "UTC");
  const [useDefaultRetention, setUseDefaultRetention] = useState(
    props.desiredRetention == null,
  );
  const [retentionPercent, setRetentionPercent] = useState<number | string>(
    props.desiredRetention == null
      ? 90
      : Math.round(props.desiredRetention * 100),
  );
  const [dayStart, setDayStart] = useState(
    formatPracticeDayStart(props.practiceDayStartMinutes ?? 0),
  );
  const validDailyLimit =
    unlimited || dailyNewSkillLimitSchema.safeParse(dailyLimit).success;
  const validTimezone = practiceTimezoneSchema.safeParse(timezone).success;
  const retentionValue =
    typeof retentionPercent === "number" ? retentionPercent / 100 : null;
  const validRetention =
    useDefaultRetention || desiredRetentionSchema.safeParse(retentionValue).success;
  const validDayStart = practiceDayStartTimeSchema.safeParse(dayStart).success;
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
        if (
          props.target.scope === "user" &&
          (!validDailyLimit || !validTimezone || !validRetention || !validDayStart)
        )
          return;
        startTransition(async () => {
          const result = await savePracticePreferencesAction(
            props.target,
            props.target.scope === "user"
              ? {
                  practicePreference: effectivePreference,
                  mixedReview: mixed,
                  dailyNewSkillLimit: unlimited ? null : dailyLimit,
                  practiceTimezone: timezone,
                  desiredRetention: useDefaultRetention ? null : retentionValue,
                  practiceDayStartMinutes: parsePracticeDayStart(dayStart),
                }
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
          <>
            <Switch
              label="Mixed review by default"
              description="Reduce rule cues and vary compatible due skills within your chosen scope. You can switch this during a session."
              checked={mixed}
              disabled={disabled}
              onChange={(event) => setMixed(event.currentTarget.checked)}
            />
            <Checkbox
              label="Unlimited new skills"
              checked={unlimited}
              disabled={disabled}
              onChange={(event) => setUnlimited(event.currentTarget.checked)}
            />
            <NumberInput
              label="New skills per day"
              description="Counts the first exercise shown for each new skill, across all collections. Scheduled follow-up reviews stay available. Use 0 for review-only practice."
              value={dailyLimit}
              min={0}
              max={1000}
              allowDecimal={false}
              allowNegative={false}
              disabled={disabled || unlimited}
              onChange={setDailyLimit}
              error={
                !validDailyLimit
                  ? "Enter a whole number from 0 to 1000."
                  : undefined
                }
            />
            <Text size="sm">
              New-skill allowance follows a practice day starting at {dayStart} in {timezone}.
            </Text>
            <details className="practiceAdvancedSettings">
              <summary>Advanced practice settings</summary>
              <Stack gap="md" mt="sm">
                <Checkbox
                  label="Use default retention (90%)"
                  checked={useDefaultRetention}
                  disabled={disabled}
                  onChange={(event) =>
                    setUseDefaultRetention(event.currentTarget.checked)
                  }
                />
                <NumberInput
                  label="Desired retention"
                  description="Higher retention schedules reviews closer together."
                  value={retentionPercent}
                  min={70}
                  max={99}
                  step={1}
                  suffix="%"
                  allowDecimal={false}
                  allowNegative={false}
                  disabled={disabled || useDefaultRetention}
                  onChange={setRetentionPercent}
                  error={
                    !validRetention
                      ? "Enter a whole percentage from 70 to 99."
                      : undefined
                  }
                />
                <TextInput
                  label="Practice day starts at"
                  description="This local time defines when the daily allowance resets."
                  type="time"
                  value={dayStart}
                  disabled={disabled}
                  onChange={(event) => setDayStart(event.currentTarget.value)}
                  error={
                    !validDayStart ? "Use a local time in HH:mm format." : undefined
                  }
                />
                <Select
                  label="Practice timezone"
                  description="Uses the local time in this zone, including daylight-saving changes."
                  data={
                    practiceTimezones.includes(timezone)
                      ? practiceTimezones
                      : [timezone, ...practiceTimezones]
                  }
                  value={timezone}
                  onChange={(value) => {
                    if (value) setTimezone(value);
                  }}
                  searchable
                  allowDeselect={false}
                  disabled={disabled}
                />
              </Stack>
            </details>
          </>
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
          <button
            className="primaryButton"
            disabled={
              disabled ||
              (props.target.scope === "user" &&
                (!validDailyLimit || !validTimezone || !validRetention || !validDayStart))
            }
            type="submit"
          >
            <FloppyDisk size={16} aria-hidden="true" />
            {pending ? "Saving" : "Save practice preferences"}
          </button>
        </div>
      </Stack>
    </form>
  );
}
