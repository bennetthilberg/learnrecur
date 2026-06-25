import { DataList } from "@radix-ui/themes";

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
    <DataList.Root className="panelHeaderCount" aria-label={ariaLabel} orientation="horizontal">
      <DataList.Item>
        <DataList.Label>{label}</DataList.Label>
        <DataList.Value>{value}</DataList.Value>
      </DataList.Item>
    </DataList.Root>
  );
}
