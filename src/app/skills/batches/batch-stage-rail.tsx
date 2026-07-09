export function BatchStageRail({
  current,
}: {
  current: "describe" | "scope" | "generate" | "review";
}) {
  const stages = [
    ["describe", "Describe"],
    ["scope", "Review scope"],
    ["generate", "Generate"],
    ["review", "Review skills"],
  ] as const;
  const currentIndex = stages.findIndex(([key]) => key === current);
  return (
    <ol className="batchStageRail" aria-label="Skill batch progress">
      {stages.map(([key, label], index) => (
        <li
          data-state={index < currentIndex ? "complete" : index === currentIndex ? "current" : "upcoming"}
          key={key}
        >
          <span>{index + 1}</span>
          {label}
        </li>
      ))}
    </ol>
  );
}
