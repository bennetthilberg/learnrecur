"use client";

import { useActionState, useId } from "react";
import { TextField } from "@radix-ui/themes";

import type { NormalizedReminderPreferenceInput } from "@/lib/reminders";

import {
  saveReminderSettingsAction,
  type ReminderSettingsActionState,
} from "./actions";

const idleState: ReminderSettingsActionState = {
  status: "idle",
  message: null,
};

const timezones = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Phoenix",
  "America/Anchorage",
  "Pacific/Honolulu",
  "Europe/London",
  "Europe/Paris",
  "Asia/Tokyo",
  "Australia/Sydney",
];

export function ReminderSettingsForm({
  preference,
}: {
  preference: NormalizedReminderPreferenceInput;
}) {
  const [state, formAction, pending] = useActionState(
    saveReminderSettingsAction,
    idleState,
  );
  const emailErrorId = useId();
  const localHourErrorId = useId();
  const timezoneErrorId = useId();
  const minimumDueCountErrorId = useId();
  const timezoneOptions = timezones.includes(preference.timezone)
    ? timezones
    : [preference.timezone, ...timezones];

  return (
    <form action={formAction} className="skillDraftForm settingsReminderForm">
      <fieldset className="skillFormFieldset">
        <legend>Recipient</legend>
        <div className="skillFormFieldsetBody">
          <label className="settingsToggle">
            <input
              defaultChecked={preference.enabled}
              disabled={pending}
              name="enabled"
              type="checkbox"
            />
            <span>Email me when practice is due</span>
          </label>

          <label className="skillField">
            <span>Reminder email</span>
            <TextField.Root
              aria-describedby={hasFieldError(state, "email") ? emailErrorId : undefined}
              aria-invalid={hasFieldError(state, "email") ? "true" : undefined}
              autoComplete="email"
              defaultValue={preference.email}
              disabled={pending}
              maxLength={254}
              name="email"
              radius="medium"
              required
              type="email"
              variant="surface"
            />
            <FieldError id={emailErrorId} state={state} name="email" />
          </label>
        </div>
      </fieldset>

      <fieldset className="skillFormFieldset">
        <legend>Schedule</legend>
        <div className="skillFormFieldsetBody">
          <div className="skillTwoColumnFields">
            <label className="skillField">
              <span>Local hour</span>
              <select
                aria-describedby={
                  hasFieldError(state, "localHour") ? localHourErrorId : undefined
                }
                aria-invalid={hasFieldError(state, "localHour") ? "true" : undefined}
                defaultValue={preference.localHour}
                disabled={pending}
                name="localHour"
                required
              >
                {Array.from({ length: 24 }, (_, hour) => (
                  <option key={hour} value={hour}>
                    {formatHour(hour)}
                  </option>
                ))}
              </select>
              <FieldError id={localHourErrorId} state={state} name="localHour" />
            </label>

            <label className="skillField">
              <span>Timezone</span>
              <select
                aria-describedby={
                  hasFieldError(state, "timezone") ? timezoneErrorId : undefined
                }
                aria-invalid={hasFieldError(state, "timezone") ? "true" : undefined}
                defaultValue={preference.timezone}
                disabled={pending}
                name="timezone"
                required
              >
                {timezoneOptions.map((timezone) => (
                  <option key={timezone} value={timezone}>
                    {timezone}
                  </option>
                ))}
              </select>
              <FieldError id={timezoneErrorId} state={state} name="timezone" />
            </label>
          </div>

          <label className="skillField">
            <span>Minimum due skills</span>
            <TextField.Root
              aria-describedby={
                hasFieldError(state, "minimumDueCount") ? minimumDueCountErrorId : undefined
              }
              aria-invalid={hasFieldError(state, "minimumDueCount") ? "true" : undefined}
              defaultValue={preference.minimumDueCount}
              disabled={pending}
              max={99}
              min={1}
              name="minimumDueCount"
              radius="medium"
              required
              type="number"
              variant="surface"
            />
            <FieldError
              id={minimumDueCountErrorId}
              state={state}
              name="minimumDueCount"
            />
          </label>
        </div>
      </fieldset>

      <div className="skillFormActions">
        <button className="primaryButton" disabled={pending} type="submit">
          {pending ? "Saving" : "Save reminders"}
        </button>
      </div>
      <FormMessage state={state} />
    </form>
  );
}

function FieldError({
  id,
  state,
  name,
}: {
  id: string;
  state: ReminderSettingsActionState;
  name: string;
}) {
  const error = state.fieldErrors?.[name]?.[0];

  if (!error) {
    return null;
  }

  return <em id={id}>{error}</em>;
}

function FormMessage({ state }: { state: ReminderSettingsActionState }) {
  if (!state.message || state.status === "idle") {
    return null;
  }

  return (
    <p
      className="skillFormMessage"
      data-tone={state.status === "saved" ? "saved" : "error"}
      role="status"
    >
      {state.message}
    </p>
  );
}

function hasFieldError(state: ReminderSettingsActionState, field: string) {
  return Boolean(state.fieldErrors?.[field]?.length);
}

function formatHour(hour: number) {
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  const meridiem = hour < 12 ? "AM" : "PM";
  return `${displayHour} ${meridiem}`;
}
