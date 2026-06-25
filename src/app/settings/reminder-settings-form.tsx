"use client";

import { Select, Switch } from "@radix-ui/themes";
import { useCallback, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import { CheckCircle, WarningCircle } from "@phosphor-icons/react";
import { notifications } from "@/components/app/notifications";
import { PressButton } from "@/components/app/open-water";
import { RadixTextField } from "@/components/app/radix-form";

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
  const [pending, setPending] = useState(false);
  const [enabled, setEnabled] = useState(preference.enabled);
  const [localHour, setLocalHour] = useState(String(preference.localHour));
  const [timezone, setTimezone] = useState(preference.timezone);
  const formRef = useRef<HTMLFormElement>(null);
  const pendingRef = useRef(false);
  const localHourErrorId = useId();
  const timezoneErrorId = useId();
  const timezoneOptions = timezones.includes(preference.timezone)
    ? timezones
    : [preference.timezone, ...timezones];

  const saveForm = useCallback(
    async (
      form: HTMLFormElement,
      source: "form" | "toggle",
      enabledOverride?: boolean,
    ): Promise<ReminderSettingsActionState | null> => {
      if (pendingRef.current) {
        return null;
      }

      const formData = new FormData(form);
      if (enabledOverride !== undefined) {
        formData.set("enabled", enabledOverride ? "on" : "off");
      }
      const enabled = formData.get("enabled") === "on";

      pendingRef.current = true;
      setPending(true);

      try {
        const result = await saveReminderSettingsAction(idleState, formData);

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
    (checked: boolean) => {
      const form = formRef.current;

      if (!form) {
        return;
      }

      const previousEnabled = enabled;
      setEnabled(checked);

      void saveForm(form, "toggle", checked).then((result) => {
        if (!result || result.status !== "saved") {
          setEnabled(previousEnabled);
        }
      });
    },
    [enabled, saveForm],
  );

  return (
    <form className="settingsReminderForm" onSubmit={handleSubmit} ref={formRef}>
      <fieldset className="skillFormFieldset settingsReminderFieldset">
        <legend>General</legend>
        <div className="skillFormFieldsetBody settingsReminderFields">
          <label className="settingsSwitchRow">
            <input name="enabled" type="hidden" value={enabled ? "on" : "off"} />
            <Switch
              checked={enabled}
              className="settingsRadixSwitch"
              color="blue"
              disabled={pending}
              highContrast
              onCheckedChange={handleEnabledChange}
              radius="full"
              size="2"
              variant="surface"
            />
            <span className="settingsSwitchLabel">Email me when practice is due</span>
          </label>

          <RadixTextField
            error={state.fieldErrors?.email?.[0]}
            label="Send email to"
            name="email"
            autoComplete="email"
            defaultValue={preference.email}
            disabled={pending}
            maxLength={254}
            required
            type="email"
          />
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
              <input name="localHour" type="hidden" value={localHour} />
              <Select.Root
                disabled={pending}
                onValueChange={setLocalHour}
                size="2"
                value={localHour}
              >
                <Select.Trigger
                  aria-describedby={
                    hasFieldError(state, "localHour") ? localHourErrorId : undefined
                  }
                  aria-invalid={hasFieldError(state, "localHour") ? "true" : undefined}
                  className="settingsRadixSelect"
                  color={hasFieldError(state, "localHour") ? "red" : "blue"}
                  radius="medium"
                  variant="surface"
                />
                <Select.Content color="blue" variant="solid">
                  {Array.from({ length: 24 }, (_, hour) => (
                    <Select.Item key={hour} value={String(hour)}>
                      {formatHour(hour)}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
              <FieldError id={localHourErrorId} state={state} name="localHour" />
            </label>

            <label className="skillField">
              <span>Timezone</span>
              <input name="timezone" type="hidden" value={timezone} />
              <Select.Root
                disabled={pending}
                onValueChange={setTimezone}
                size="2"
                value={timezone}
              >
                <Select.Trigger
                aria-describedby={
                    hasFieldError(state, "timezone") ? timezoneErrorId : undefined
                }
                  aria-invalid={hasFieldError(state, "timezone") ? "true" : undefined}
                  className="settingsRadixSelect"
                  color={hasFieldError(state, "timezone") ? "red" : "blue"}
                  radius="medium"
                  variant="surface"
                />
                <Select.Content color="blue" variant="solid">
                  {timezoneOptions.map((timezone) => (
                    <Select.Item key={timezone} value={timezone}>
                      {timezone}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
              <FieldError id={timezoneErrorId} state={state} name="timezone" />
            </label>
          </div>

          <RadixTextField
            error={state.fieldErrors?.minimumDueCount?.[0]}
            label="Minimum due skills"
            name="minimumDueCount"
            defaultValue={preference.minimumDueCount}
            disabled={pending}
            max={99}
            min={1}
            required
            type="number"
          />
        </div>
      </fieldset>

      <div className="skillFormActions">
        <PressButton className="primaryButton" disabled={pending} type="submit">
          {pending ? "Saving" : "Save changes"}
        </PressButton>
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
