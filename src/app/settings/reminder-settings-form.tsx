"use client";

import { useCallback, useId, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { CheckCircle, WarningCircle } from "@phosphor-icons/react";
import { notifications } from "@mantine/notifications";

import type { NormalizedReminderPreferenceInput } from "@/lib/reminders";

import {
  saveReminderSettingsAction,
  type ReminderSettingsActionState,
} from "./actions";

const idleState: ReminderSettingsActionState = {
  status: "idle",
  message: null,
};

const reminderSettingsNotificationId = "settings-reminder-settings-notice";

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
  const [state, setState] = useState<ReminderSettingsActionState>(idleState);
  const [currentPreference, setCurrentPreference] = useState(preference);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const emailErrorId = useId();
  const localHourErrorId = useId();
  const timezoneErrorId = useId();
  const minimumDueCountErrorId = useId();
  const timezoneOptions = timezones.includes(currentPreference.timezone)
    ? timezones
    : [currentPreference.timezone, ...timezones];

  const saveForm = useCallback(
    async (
      form: HTMLFormElement,
      source: "form" | "toggle",
    ): Promise<ReminderSettingsActionState | null> => {
      if (pendingRef.current) {
        return null;
      }

      const formData = new FormData(form);
      const enabled = formData.get("enabled") === "on";

      pendingRef.current = true;
      setPending(true);

      try {
        const result = await saveReminderSettingsAction(idleState, formData);

        if (result.status === "saved" && result.preference) {
          setCurrentPreference(result.preference);
        }

        setState(result);
        showReminderSettingsNotification(result, source, enabled);

        return result;
      } catch {
        const result: ReminderSettingsActionState = {
          status: "error",
          message: "Could not save reminder settings. Try again.",
        };

        setState(result);
        showReminderSettingsNotification(result, source, enabled);

        return result;
      } finally {
        pendingRef.current = false;
        setPending(false);
      }
    },
    [],
  );

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void saveForm(event.currentTarget, "form");
    },
    [saveForm],
  );

  const handleEnabledChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const checkbox = event.currentTarget;
      const form = checkbox.form;

      if (!form) {
        return;
      }

      const checked = checkbox.checked;

      void saveForm(form, "toggle").then((result) => {
        if (!result || result.status !== "saved") {
          checkbox.checked = !checked;
        }
      });
    },
    [saveForm],
  );

  return (
    <form className="settingsReminderForm" onSubmit={handleSubmit}>
      <fieldset className="skillFormFieldset settingsReminderFieldset">
        <legend>General</legend>
        <div className="skillFormFieldsetBody settingsReminderFields">
          <label className="settingsSwitchRow">
            <input
              className="settingsSwitchInput"
              defaultChecked={currentPreference.enabled}
              disabled={pending}
              name="enabled"
              onChange={handleEnabledChange}
              type="checkbox"
            />
            <span className="settingsSwitchControl" aria-hidden="true" />
            <span className="settingsSwitchLabel">Email me when practice is due</span>
          </label>

          <label className="skillField">
            <span>Send email to</span>
            <input
              aria-describedby={hasFieldError(state, "email") ? emailErrorId : undefined}
              aria-invalid={hasFieldError(state, "email") ? "true" : undefined}
              autoComplete="email"
              disabled={pending}
              maxLength={254}
              name="email"
              readOnly
              required
              type="email"
              value={currentPreference.email}
            />
            <span className="settingsFieldHint">Reminders can only be sent to your account email.</span>
            <FieldError id={emailErrorId} state={state} name="email" />
          </label>
        </div>
      </fieldset>

      <fieldset className="skillFormFieldset settingsReminderFieldset">
        <legend>Schedule</legend>
        <p className="settingsFieldHint">
          We check once a day and send only if your due count meets this threshold.
        </p>
        <div className="skillFormFieldsetBody settingsReminderFields">
          <div className="skillTwoColumnFields">
            <label className="skillField">
              <span>Local hour</span>
              <select
                aria-describedby={
                  hasFieldError(state, "localHour") ? localHourErrorId : undefined
                }
                aria-invalid={hasFieldError(state, "localHour") ? "true" : undefined}
                defaultValue={currentPreference.localHour}
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
                defaultValue={currentPreference.timezone}
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
            <input
              aria-describedby={
                hasFieldError(state, "minimumDueCount") ? minimumDueCountErrorId : undefined
              }
              aria-invalid={hasFieldError(state, "minimumDueCount") ? "true" : undefined}
              defaultValue={currentPreference.minimumDueCount}
              disabled={pending}
              max={99}
              min={1}
              name="minimumDueCount"
              required
              type="number"
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
          {pending ? "Saving" : "Save changes"}
        </button>
      </div>
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

function hasFieldError(state: ReminderSettingsActionState, field: string) {
  return Boolean(state.fieldErrors?.[field]?.length);
}

function formatHour(hour: number) {
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  const meridiem = hour < 12 ? "AM" : "PM";
  return `${displayHour} ${meridiem}`;
}

function showReminderSettingsNotification(
  state: ReminderSettingsActionState,
  source: "form" | "toggle",
  enabled: boolean,
) {
  if (!state.message || state.status === "idle") {
    return;
  }

  const saved = state.status === "saved";
  const message = saved && source === "toggle"
    ? enabled
      ? "Reminders are on."
      : "Reminders are off."
    : state.message;

  notifications.show({
    id: reminderSettingsNotificationId,
    autoClose: saved ? 3500 : 8000,
    className: "learnrecurNotification",
    color: saved ? "leaf" : "amber",
    icon: saved ? (
      <CheckCircle size={18} weight="bold" />
    ) : (
      <WarningCircle size={18} weight="bold" />
    ),
    message,
    position: "top-right",
    title: saved ? "Reminder settings saved" : "Could not save reminders",
    withBorder: true,
    withCloseButton: true,
  });
}
