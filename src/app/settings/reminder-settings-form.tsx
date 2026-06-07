"use client";

import { useActionState } from "react";

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

  return (
    <form action={formAction} className="skillDraftForm">
      <label className="settingsToggle">
        <input
          defaultChecked={preference.enabled}
          disabled={pending}
          name="enabled"
          type="checkbox"
        />
        <span>Email me when practice is due</span>
      </label>

      <div className="skillTwoColumnFields">
        <label className="skillField">
          <span>Reminder email</span>
          <input
            aria-invalid={hasFieldError(state, "email") ? "true" : undefined}
            autoComplete="email"
            defaultValue={preference.email}
            disabled={pending}
            maxLength={254}
            name="email"
            required
            type="email"
          />
          <FieldError state={state} name="email" />
        </label>

        <label className="skillField">
          <span>Minimum due skills</span>
          <input
            aria-invalid={hasFieldError(state, "minimumDueCount") ? "true" : undefined}
            defaultValue={preference.minimumDueCount}
            disabled={pending}
            max={99}
            min={1}
            name="minimumDueCount"
            required
            type="number"
          />
          <FieldError state={state} name="minimumDueCount" />
        </label>
      </div>

      <div className="skillTwoColumnFields">
        <label className="skillField">
          <span>Local hour</span>
          <select
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
          <FieldError state={state} name="localHour" />
        </label>

        <label className="skillField">
          <span>Timezone</span>
          <input
            aria-invalid={hasFieldError(state, "timezone") ? "true" : undefined}
            defaultValue={preference.timezone}
            disabled={pending}
            list="reminder-timezones"
            maxLength={80}
            name="timezone"
            required
          />
          <datalist id="reminder-timezones">
            {timezones.map((timezone) => (
              <option key={timezone} value={timezone} />
            ))}
          </datalist>
          <FieldError state={state} name="timezone" />
        </label>
      </div>

      <div className="skillFormActions">
        <button className="primaryButton" disabled={pending} type="submit">
          Save reminders
        </button>
      </div>
      <FormMessage state={state} />
    </form>
  );
}

function FieldError({
  state,
  name,
}: {
  state: ReminderSettingsActionState;
  name: string;
}) {
  const error = state.fieldErrors?.[name]?.[0];

  if (!error) {
    return null;
  }

  return <em>{error}</em>;
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
