"use client";

import { type CSSProperties, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  Divider,
  Group,
  MantineProvider,
  Progress,
  Radio,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Switch,
  Textarea,
  TextInput,
  createTheme,
  type MantineColorsTuple,
} from "@mantine/core";
import classes from "./design-lab.module.css";

const lrBlue: MantineColorsTuple = [
  "#e9f0ff",
  "#d7e2ff",
  "#aec4ff",
  "#83a3fb",
  "#5e85f0",
  "#3567e4",
  "#034cd5",
  "#043daa",
  "#12306d",
  "#0c214b",
];

const theme = createTheme({
  colors: {
    lrBlue,
  },
  primaryColor: "lrBlue",
  defaultRadius: "xs",
  fontFamily: "var(--font-lexend), sans-serif",
  headings: {
    fontFamily: "var(--font-lexend), sans-serif",
    fontWeight: "500",
  },
});

const lockedDesign = {
  accent: { color: "#b76a00", ink: "#6f4200", label: "Amber" },
  canvasTint: 15,
  density: { label: "Roomy", pad: 26, space: 22 },
  elevation: {
    border: "color-mix(in srgb, var(--lab-primary) 12%, var(--lr-line))",
    label: "Soft",
    shadow: "0 1px 2px rgba(18, 29, 51, 0.035), 0 8px 18px rgba(18, 29, 51, 0.045)",
  },
  headingWeight: 500,
  neutral: {
    faint: "#687789",
    ink: "#131a24",
    label: "Steel",
    line: "#dce3eb",
    muted: "#4b5968",
    page: "#f6f8fb",
    panel: "#ffffff",
  },
  numberFont: "var(--font-lexend), sans-serif",
  primary: "#034cd5",
  radius: 5,
};

const navOptions = [
  { value: "sidebar", label: "Sidebar" },
  { value: "rail", label: "Rail" },
  { value: "tabs", label: "Tabs" },
];

const surfaceOptions = [
  { value: "bordered", label: "Bordered" },
  { value: "shadow", label: "No border" },
  { value: "hairline", label: "Hairline" },
];

const tableOptions = [
  { value: "rules", label: "Rules" },
  { value: "bands", label: "Bands" },
  { value: "cards", label: "Cards" },
];

const focusOptions = [
  { value: "halo", label: "Halo" },
  { value: "edge", label: "Edge" },
  { value: "underline", label: "Underline" },
];

const badgeOptions = [
  { value: "pill", label: "Pills" },
  { value: "chip", label: "Chips" },
  { value: "label", label: "Labels" },
];

const messageOptions = [
  { value: "stripe", label: "Stripe" },
  { value: "panel", label: "Panel" },
  { value: "compact", label: "Compact" },
];

const emptyOptions = [
  { value: "technical", label: "Technical" },
  { value: "checklist", label: "Checklist" },
  { value: "minimal", label: "Minimal" },
];

type BadgeStyle = (typeof badgeOptions)[number]["value"];
type EmptyStyle = (typeof emptyOptions)[number]["value"];
type FeedbackState = "neutral" | "correct" | "missed";
type FocusStyle = (typeof focusOptions)[number]["value"];
type MessageStyle = (typeof messageOptions)[number]["value"];
type NavStyle = (typeof navOptions)[number]["value"];
type SurfaceStyle = (typeof surfaceOptions)[number]["value"];
type TableStyle = (typeof tableOptions)[number]["value"];

export function DesignLab() {
  const [badgeStyle, setBadgeStyle] = useState<BadgeStyle>("chip");
  const [dimensionalCards, setDimensionalCards] = useState(false);
  const [emptyStyle, setEmptyStyle] = useState<EmptyStyle>("technical");
  const [feedback, setFeedback] = useState<FeedbackState>("correct");
  const [focusStyle, setFocusStyle] = useState<FocusStyle>("halo");
  const [messageStyle, setMessageStyle] = useState<MessageStyle>("stripe");
  const [navStyle, setNavStyle] = useState<NavStyle>("sidebar");
  const [surfaceStyle, setSurfaceStyle] = useState<SurfaceStyle>("bordered");
  const [tableStyle, setTableStyle] = useState<TableStyle>("rules");
  const [answer, setAnswer] = useState("ser");
  const [readyTarget, setReadyTarget] = useState("5");
  const [requiresAnswerKey, setRequiresAnswerKey] = useState(true);
  const [includeWorkedExample, setIncludeWorkedExample] = useState(false);

  const primary = lockedDesign.primary;
  const surfaceConfig = getSurfaceConfig(
    surfaceStyle,
    lockedDesign.elevation.border,
    lockedDesign.elevation.shadow,
  );

  const labStyle = useMemo(
    () =>
      ({
        "--lab-accent": lockedDesign.accent.color,
        "--lab-accent-ink": lockedDesign.accent.ink,
        "--lab-accent-soft": mixColor("#ffffff", lockedDesign.accent.color, 0.12),
        "--lab-focus-color": primary,
        "--lab-heading-weight": lockedDesign.headingWeight,
        "--lab-inner-border": surfaceConfig.innerBorder,
        "--lab-plane-side": mixColor(lockedDesign.neutral.line, primary, 0.08),
        "--lab-plane-top": mixColor("#ffffff", primary, 0.055),
        "--lab-number-font": lockedDesign.numberFont,
        "--lab-pad": `${lockedDesign.density.pad}px`,
        "--lab-page": mixColor(
          lockedDesign.neutral.page,
          "#e9f2ff",
          lockedDesign.canvasTint / 100,
        ),
        "--lab-primary": primary,
        "--lab-primary-dark": mixColor(primary, "#071c3d", 0.48),
        "--lab-primary-soft": mixColor("#ffffff", primary, 0.1),
        "--lab-radius": `${lockedDesign.radius}px`,
        "--lab-radius-lg": `${lockedDesign.radius + 5}px`,
        "--lab-radius-sm": `${Math.max(3, lockedDesign.radius - 2)}px`,
        "--lab-segment-bg": "#edf1f6",
        "--lab-shadow": surfaceConfig.shadow,
        "--lab-space": `${lockedDesign.density.space}px`,
        "--lab-surface-border": surfaceConfig.border,
        "--lr-error": "#a33b33",
        "--lr-faint": lockedDesign.neutral.faint,
        "--lr-ink": lockedDesign.neutral.ink,
        "--lr-line": lockedDesign.neutral.line,
        "--lr-muted": lockedDesign.neutral.muted,
        "--lr-panel": lockedDesign.neutral.panel,
        "--lr-success": "#23735a",
        "--lr-warning": "#9a6400",
      }) as CSSProperties,
    [primary, surfaceConfig.border, surfaceConfig.innerBorder, surfaceConfig.shadow],
  );

  const contrast = getContrastRatio(primary, "#ffffff");

  return (
    <MantineProvider theme={theme} defaultColorScheme="light">
      <main
        className={classes.shell}
        data-badge={badgeStyle}
        data-dimensional={dimensionalCards ? "on" : "off"}
        data-focus={focusStyle}
        data-surface={surfaceStyle}
        style={labStyle}
      >
        <section className={classes.intro}>
          <div className={classes.heroCopy}>
            <p className={classes.kicker}>LearnRecur design lab</p>
            <h1 className={classes.display}>Precise review workspace.</h1>
            <div className={classes.signalStrip}>
              <span className={classes.signalBar} aria-hidden="true" />
              <div>
                <p>LearnRecur</p>
                <strong>Focused practice, generated from real source material.</strong>
              </div>
            </div>
          </div>

          <Card component="section" className={classes.controlPanel} aria-label="Design controls">
            <Stack gap="var(--lab-space)">
              <Group justify="space-between" align="flex-start" gap="sm">
                <div>
                  <p className={classes.controlTitle}>Open decisions</p>
                  <p className={classes.mutedText}>
                    Locked tokens are listed below; controls are for remaining system choices.
                  </p>
                </div>
                <Badge className={classes.contrastBadge}>{contrast.toFixed(2)}:1</Badge>
              </Group>

              <LockedTokenGrid />

              <Switch
                label="Subtle 3D card edges"
                checked={dimensionalCards}
                onChange={(event) => setDimensionalCards(event.currentTarget.checked)}
                classNames={{
                  root: classes.switchRoot,
                  track: classes.switchTrack,
                  thumb: classes.switchThumb,
                  label: classes.switchLabel,
                }}
              />

              <DesignSegmented
                label="Navigation posture"
                value={navStyle}
                onChange={(value) => setNavStyle(value as NavStyle)}
                data={navOptions}
              />

              <DesignSegmented
                label="Surface separation"
                value={surfaceStyle}
                onChange={(value) => setSurfaceStyle(value as SurfaceStyle)}
                data={surfaceOptions}
              />

              <DesignSegmented
                label="Data table treatment"
                value={tableStyle}
                onChange={(value) => setTableStyle(value as TableStyle)}
                data={tableOptions}
              />

              <DesignSegmented
                label="Focus state"
                value={focusStyle}
                onChange={(value) => setFocusStyle(value as FocusStyle)}
                data={focusOptions}
              />

              <DesignSegmented
                label="Badge shape"
                value={badgeStyle}
                onChange={(value) => setBadgeStyle(value as BadgeStyle)}
                data={badgeOptions}
              />

              <DesignSegmented
                label="Message treatment"
                value={messageStyle}
                onChange={(value) => setMessageStyle(value as MessageStyle)}
                data={messageOptions}
              />

              <DesignSegmented
                label="Empty state posture"
                value={emptyStyle}
                onChange={(value) => setEmptyStyle(value as EmptyStyle)}
                data={emptyOptions}
              />
            </Stack>
          </Card>
        </section>

        <section className={classes.grid}>
          <section className={`${classes.panel} ${classes.workspacePanel}`}>
            <div className={classes.panelHeader}>
              <p className={classes.sectionLabel}>Workspace shell</p>
              <h2 className={classes.panelTitle}>Daily review command surface.</h2>
            </div>
            <WorkspacePreview navStyle={navStyle} />
          </section>

          <Card component="section" className={classes.panel}>
            <Group justify="space-between" align="flex-start" gap="sm" className={classes.panelHeader}>
              <div>
                <p className={classes.sectionLabel}>Typography</p>
                <h2 className={classes.panelTitle}>Hierarchy through restrained contrast.</h2>
              </div>
              <Badge className={classes.badgePill}>500</Badge>
            </Group>

            <Stack gap="var(--lab-space)">
              <div className={classes.typeRamp}>
                <h3 className={classes.typeBig}>Ser versus estar</h3>
                <p className={classes.typeBody}>
                  Choose the verb that matches the sentence. The answer should be clear,
                  quick to check, and close to the format a learner saw in class.
                </p>
                <p className={classes.typeSmall}>
                  Italic sample: <em>temporary condition, not identity</em>
                </p>
              </div>

              <div className={classes.weights}>
                {[320, 400, 500, 560, 600, 680].map((weight) => (
                  <p key={weight} style={{ fontWeight: weight }}>
                    {weight} Practice queue ready
                  </p>
                ))}
              </div>
            </Stack>
          </Card>

          <Card component="section" className={classes.panel}>
            <Group justify="space-between" align="flex-start" gap="sm" className={classes.panelHeader}>
              <div>
                <p className={classes.sectionLabel}>Core actions</p>
                <h2 className={classes.panelTitle}>Buttons, badges, and state.</h2>
              </div>
              <Button variant="subtle" className={classes.iconButton}>
                Reset
              </Button>
            </Group>

            <Group gap="sm" className={classes.buttonRow}>
              <Button className={classes.primaryButton}>Start practice</Button>
              <Button variant="light" className={classes.secondaryButton}>
                Add source
              </Button>
              <Button variant="default" className={classes.ghostButton}>
                Edit draft
              </Button>
            </Group>

            <Group gap="xs" className={classes.badgeRow}>
              <Badge className={classes.badgePill}>Due now</Badge>
              <Badge className={classes.badgePillSoft}>Growing</Badge>
              <Badge className={classes.badgePillSignal}>Needs review</Badge>
              <Badge className={classes.badgePillAccent}>Source gap</Badge>
            </Group>

            <SimpleGrid cols={{ base: 1, xs: 3 }} spacing="sm">
              <Metric label="Due skills" value="12" />
              <Metric label="Accuracy" value="84%" />
              <Metric label="Ready" value="39" />
            </SimpleGrid>
          </Card>

          <section className={classes.practicePanel}>
            <Group justify="space-between" align="flex-start" gap="sm" className={classes.panelHeader}>
              <div>
                <p className={classes.sectionLabel}>Practice card</p>
                <h2 className={classes.panelTitle}>One exercise, one decision.</h2>
              </div>
              <DesignSegmented
                value={feedback}
                onChange={(value) => setFeedback(value as FeedbackState)}
                data={[
                  { value: "neutral", label: "Try" },
                  { value: "correct", label: "Right" },
                  { value: "missed", label: "Missed" },
                ]}
                className={classes.feedbackControl}
              />
            </Group>

            <Card className={classes.practiceCard}>
              <Group justify="space-between" gap="sm" className={classes.practiceMeta}>
                <Badge className={classes.badgePillSoft}>Spanish grammar</Badge>
                <p className={classes.mutedText}>Expected: 18 sec</p>
              </Group>

              <h3 className={classes.exercisePrompt}>
                Complete the sentence: Mi hermana ___ medica.
              </h3>

              <Radio.Group value={answer} onChange={setAnswer} className={classes.choiceStack}>
                <Radio value="ser" label="es" classNames={radioClasses} />
                <Radio value="estar" label="esta" classNames={radioClasses} />
                <Radio value="tener" label="tiene" classNames={radioClasses} />
              </Radio.Group>

              <FeedbackBlock state={feedback} />

              <Group gap="sm" className={classes.practiceActions}>
                <Button className={classes.primaryButton}>Check</Button>
                <Button variant="default" className={classes.ghostButton}>
                  Flag
                </Button>
              </Group>
            </Card>
          </section>

          <Card component="section" className={classes.panel}>
            <p className={classes.sectionLabel}>Forms</p>
            <h2 className={classes.panelTitle}>Skill drafting inputs.</h2>

            <Stack gap="var(--lab-space)">
              <TextInput
                label="Skill title"
                defaultValue="Choose ser or estar for identity and condition"
                classNames={{ input: classes.input, label: classes.fieldLabel }}
              />

              <Textarea
                label="Exercise constraint"
                defaultValue="Use short sentences with one blank. Avoid rare vocabulary unless it appears in the source."
                minRows={4}
                classNames={{ input: classes.textarea, label: classes.fieldLabel }}
              />

              <div className={classes.formSplit}>
                <TextInput
                  label="Ready target"
                  type="number"
                  min={1}
                  max={12}
                  value={readyTarget}
                  onChange={(event) => setReadyTarget(event.currentTarget.value)}
                  classNames={{ input: classes.input, label: classes.fieldLabel }}
                />
                <DesignSegmented
                  defaultValue="mixed"
                  data={["Easy", "Mixed", "Hard"].map((option) => ({
                    value: option.toLowerCase(),
                    label: option,
                  }))}
                />
              </div>

              <Checkbox
                label="Require objective answer key before activation"
                checked={requiresAnswerKey}
                onChange={(event) => setRequiresAnswerKey(event.currentTarget.checked)}
                classNames={{
                  body: classes.checkboxBody,
                  input: classes.checkboxInput,
                  label: classes.checkboxLabel,
                }}
              />

              <Switch
                label="Include one worked example"
                checked={includeWorkedExample}
                onChange={(event) => setIncludeWorkedExample(event.currentTarget.checked)}
                classNames={{
                  root: classes.switchRoot,
                  track: classes.switchTrack,
                  thumb: classes.switchThumb,
                  label: classes.switchLabel,
                }}
              />
            </Stack>
          </Card>

          <Card component="section" className={classes.panel}>
            <p className={classes.sectionLabel}>Progress</p>
            <h2 className={classes.panelTitle}>Mastery without confetti.</h2>

            <Stack gap="var(--lab-space)">
              <div className={classes.progressGroup}>
                <Group justify="space-between" gap="sm" className={classes.controlLabelRow}>
                  <span>Current collection strength</span>
                  <span className={classes.numberText}>42%</span>
                </Group>
                <Progress value={42} color={primary} radius="xl" className={classes.progress} />
              </div>

              <div className={classes.skillList}>
                <SkillRow title="Ser vs. estar" status="Due today" value="Strong" />
                <SkillRow title="Power rule derivatives" status="Tomorrow" value="Growing" />
                <SkillRow title="Fraction decimal equivalents" status="New" value="Practicing" />
              </div>
            </Stack>
          </Card>

          <Card component="section" className={`${classes.panel} ${classes.tablePanel}`}>
            <p className={classes.sectionLabel}>Data surfaces</p>
            <h2 className={classes.panelTitle}>Readable rows, useful numbers.</h2>
            <DataTablePreview tableStyle={tableStyle} />
          </Card>

          <Card component="section" className={classes.panel}>
            <p className={classes.sectionLabel}>System messages</p>
            <h2 className={classes.panelTitle}>Quiet guidance, strong contrast.</h2>
            <Stack gap="sm" className={classes.noticeStack}>
              <Notice messageStyle={messageStyle} tone="info" title="Source imported">
                18 candidate skills were found. 12 have enough examples to activate.
              </Notice>
              <Notice messageStyle={messageStyle} tone="accent" title="Needs review">
                The generator could not verify every answer key in this section.
              </Notice>
              <Notice messageStyle={messageStyle} tone="error" title="Activation blocked">
                Add an objective answer key before this skill can enter the review queue.
              </Notice>
            </Stack>
          </Card>

          <Card component="section" className={classes.panel}>
            <p className={classes.sectionLabel}>Empty state</p>
            <h2 className={classes.panelTitle}>Specific, not decorative.</h2>
            <EmptyStatePreview emptyStyle={emptyStyle} />
          </Card>

          <Card component="section" className={classes.panel}>
            <p className={classes.sectionLabel}>Color system</p>
            <h2 className={classes.panelTitle}>Tonal ramp and warm accent.</h2>

            <div className={classes.swatches}>
              <Swatch color={mixColor("#ffffff", primary, 0.08)} label="Blue 50" />
              <Swatch color={mixColor("#ffffff", primary, 0.22)} label="Blue 100" />
              <Swatch color={primary} label="Primary" />
              <Swatch color={mixColor(primary, "#071c3d", 0.45)} label="Blue 800" />
              <Swatch color={lockedDesign.accent.color} label={lockedDesign.accent.label} />
            </div>

            <Divider className={classes.separator} />

            <p className={classes.noteText}>
              #034cd5 is the selected primary and sits just over 7:1 with white. The neutral
              ramp is cool-tinted, body text stays dark, and the accent is warm by design.
            </p>
          </Card>
        </section>
      </main>
    </MantineProvider>
  );
}

const radioClasses = {
  root: classes.radioRoot,
  radio: classes.radioInput,
  label: classes.radioLabel,
  body: classes.radioBody,
};

const segmentedClasses = {
  root: classes.segmented,
  control: classes.segmentedControl,
  indicator: classes.segmentedIndicator,
  label: classes.segmentedLabel,
};

function DesignSegmented({
  className,
  data,
  defaultValue,
  label,
  onChange,
  value,
}: {
  className?: string;
  data: { value: string; label: string }[];
  defaultValue?: string;
  label?: string;
  onChange?: (value: string) => void;
  value?: string;
}) {
  return (
    <div className={classes.segmentedField}>
      {label ? <p className={classes.fieldLabel}>{label}</p> : null}
      <SegmentedControl
        fullWidth
        value={value}
        defaultValue={defaultValue}
        onChange={onChange}
        data={data}
        className={className}
        classNames={segmentedClasses}
      />
    </div>
  );
}

function LockedTokenGrid() {
  const tokens = [
    ["Primary", lockedDesign.primary],
    ["Radius", `${lockedDesign.radius}px`],
    ["Spacing", lockedDesign.density.label],
    ["Canvas", `${lockedDesign.canvasTint}%`],
    ["Shadow", lockedDesign.elevation.label],
    ["Neutral", lockedDesign.neutral.label],
    ["Accent", lockedDesign.accent.label],
    ["Numbers", "Lexend"],
  ];

  return (
    <div className={classes.lockedTokens}>
      {tokens.map(([label, value]) => (
        <div key={label} className={classes.lockedToken}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

function WorkspacePreview({ navStyle }: { navStyle: NavStyle }) {
  return (
    <div className={`${classes.workspace} ${classes[`workspace-${navStyle}`]}`}>
      <aside className={classes.workspaceNav}>
        <p className={classes.navBrand}>LR</p>
        {["Review", "Sources", "Skills", "Reports"].map((item, index) => (
          <button
            key={item}
            className={`${classes.navItem} ${index === 0 ? classes.navItemActive : ""}`}
          >
            {item}
          </button>
        ))}
      </aside>
      <div className={classes.workspaceMain}>
        <div className={classes.workspaceTopbar}>
          <div>
            <p className={classes.workspaceEyebrow}>Today</p>
            <h3 className={classes.workspaceTitle}>Review queue</h3>
          </div>
          <Badge className={classes.badgePillAccent}>12 due</Badge>
        </div>
        <div className={classes.workspaceContent}>
          <div className={classes.queueList}>
            <QueueRow title="Spanish grammar" detail="Ser vs. estar" value="18 sec" active />
            <QueueRow title="Calculus" detail="Power rule derivatives" value="31 sec" />
            <QueueRow title="Fractions" detail="Decimal equivalents" value="24 sec" />
          </div>
          <div className={classes.inspector}>
            <p className={classes.inspectorLabel}>Current prompt</p>
            <p className={classes.inspectorPrompt}>Mi hermana ___ medica.</p>
            <div className={classes.inspectorGrid}>
              <Metric label="Attempts" value="04" />
              <Metric label="Recall" value="91%" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function QueueRow({
  active,
  detail,
  title,
  value,
}: {
  active?: boolean;
  detail: string;
  title: string;
  value: string;
}) {
  return (
    <button className={`${classes.queueRow} ${active ? classes.queueRowActive : ""}`}>
      <span>
        <strong>{title}</strong>
        <em>{detail}</em>
      </span>
      <span className={classes.numberText}>{value}</span>
    </button>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className={classes.metric}>
      <p className={classes.metricValue}>{value}</p>
      <p className={classes.metricLabel}>{label}</p>
    </div>
  );
}

function FeedbackBlock({ state }: { state: FeedbackState }) {
  if (state === "neutral") {
    return (
      <div className={classes.feedbackNeutral}>
        <span className={classes.feedbackIcon}>?</span>
        <p>Answer first, then get immediate feedback.</p>
      </div>
    );
  }

  if (state === "missed") {
    return (
      <div className={classes.feedbackMissed}>
        <span className={classes.feedbackIcon}>x</span>
        <div>
          <p className={classes.feedbackTitle}>Not quite.</p>
          <p>
            Use <strong>es</strong> for identity or profession.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={classes.feedbackCorrect}>
      <span className={classes.feedbackIcon}>OK</span>
      <div>
        <p className={classes.feedbackTitle}>Correct.</p>
        <p>
          A profession describes identity, so this takes <strong>ser</strong>.
        </p>
      </div>
    </div>
  );
}

function SkillRow({
  title,
  status,
  value,
}: {
  title: string;
  status: string;
  value: string;
}) {
  return (
    <div className={classes.skillRow}>
      <div>
        <p className={classes.skillTitle}>{title}</p>
        <p className={classes.mutedText}>{status}</p>
      </div>
      <Badge className={classes.badgePillSoft}>{value}</Badge>
    </div>
  );
}

function DataTablePreview({ tableStyle }: { tableStyle: TableStyle }) {
  const rows = [
    ["Spanish grammar", "12", "84%", "Due today"],
    ["Power rule", "7", "91%", "Tomorrow"],
    ["Fraction conversion", "4", "76%", "New"],
    ["Stoichiometry", "9", "88%", "Friday"],
  ];

  return (
    <div className={`${classes.tableWrap} ${classes[`table-${tableStyle}`]}`}>
      <table className={classes.dataTable}>
        <thead>
          <tr>
            <th>Collection</th>
            <th>Due</th>
            <th>Accuracy</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([collection, due, accuracy, status]) => (
            <tr key={collection}>
              <td>{collection}</td>
              <td className={classes.numberText}>{due}</td>
              <td className={classes.numberText}>{accuracy}</td>
              <td>
                <Badge className={status === "New" ? classes.badgePillAccent : classes.badgePillSoft}>
                  {status}
                </Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Notice({
  children,
  messageStyle,
  title,
  tone,
}: {
  children: React.ReactNode;
  messageStyle: MessageStyle;
  title: string;
  tone: "info" | "accent" | "error";
}) {
  return (
    <div className={`${classes.notice} ${classes[`notice-${tone}`]} ${classes[`notice-${messageStyle}`]}`}>
      <span className={classes.noticeMark} aria-hidden="true" />
      <div>
        <p className={classes.noticeTitle}>{title}</p>
        <p className={classes.noticeBody}>{children}</p>
      </div>
    </div>
  );
}

function EmptyStatePreview({ emptyStyle }: { emptyStyle: EmptyStyle }) {
  if (emptyStyle === "checklist") {
    return (
      <div className={`${classes.emptyState} ${classes.emptyChecklist}`}>
        <div>
          <p className={classes.emptyTitle}>Source setup checklist</p>
          <p className={classes.mutedText}>Complete the minimum inputs before generating skills.</p>
        </div>
        <ul className={classes.emptyList}>
          <li>Attach source material</li>
          <li>Choose subject and level</li>
          <li>Confirm answer-key style</li>
        </ul>
        <Button className={classes.primaryButton}>Add source</Button>
      </div>
    );
  }

  if (emptyStyle === "minimal") {
    return (
      <div className={`${classes.emptyState} ${classes.emptyMinimal}`}>
        <div>
          <p className={classes.emptyTitle}>No source selected</p>
          <p className={classes.mutedText}>Add source material to start building a review queue.</p>
        </div>
        <Button className={classes.primaryButton}>Add source</Button>
      </div>
    );
  }

  return (
    <div className={classes.emptyState}>
      <div className={classes.emptyMark} aria-hidden="true" />
      <div>
        <p className={classes.emptyTitle}>No source selected</p>
        <p className={classes.mutedText}>
          Pick a document or paste notes before generating a skill map.
        </p>
      </div>
      <Button className={classes.primaryButton}>Add source</Button>
    </div>
  );
}

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <div className={classes.swatch}>
      <span style={{ background: color }} className={classes.colorSwatch} />
      <p className={classes.swatchLabel}>{label}</p>
      <p className={classes.mutedText}>{color}</p>
    </div>
  );
}

function mixColor(a: string, b: string, amount: number) {
  const first = hexToRgb(a);
  const second = hexToRgb(b);
  const mixed = first.map((channel, index) =>
    Math.round(channel + (second[index] - channel) * amount),
  );
  return rgbToHex(mixed[0], mixed[1], mixed[2]);
}

function getContrastRatio(a: string, b: string) {
  const l1 = relativeLuminance(hexToRgb(a));
  const l2 = relativeLuminance(hexToRgb(b));
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(rgb: number[]) {
  const [r, g, b] = rgb.map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  });

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function hexToRgb(hex: string) {
  const fallback = [3, 76, 213];
  if (!/^#[0-9a-f]{6}$/i.test(hex)) {
    return fallback;
  }

  return [0, 2, 4].map((start) => parseInt(hex.slice(start + 1, start + 3), 16));
}

function rgbToHex(r: number, g: number, b: number) {
  return `#${[r, g, b]
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}

function getSurfaceConfig(surfaceStyle: SurfaceStyle, lockedBorder: string, lockedShadow: string) {
  if (surfaceStyle === "shadow") {
    return {
      border: "transparent",
      innerBorder: "transparent",
      shadow: "0 2px 5px rgba(18, 29, 51, 0.055), 0 18px 34px rgba(18, 29, 51, 0.075)",
    };
  }

  if (surfaceStyle === "hairline") {
    return {
      border: "var(--lr-line)",
      innerBorder: "var(--lr-line)",
      shadow: "0 1px 2px rgba(18, 29, 51, 0.025)",
    };
  }

  return {
    border: lockedBorder,
    innerBorder: "var(--lr-line)",
    shadow: lockedShadow,
  };
}
