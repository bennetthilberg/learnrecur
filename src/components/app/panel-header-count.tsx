export function PanelHeaderCount({
  ariaLabel,
  label,
  value,
}: {
  ariaLabel: string;
  label: string;
  value: string;
}) {
  return (
    <dl className="panelHeaderCount" aria-label={ariaLabel}>
      <div>
        <dt>{label}</dt>
        <dd>{value}</dd>
      </div>
    </dl>
  );
}
