export const MATERIAL_DELETION_RETURN_PATHS = [
  "/skills/materials",
  "/skills/new/multiple",
] as const;

export type MaterialDeletionReturnPath = (typeof MATERIAL_DELETION_RETURN_PATHS)[number];

export function getMaterialDeletionReturnPath(value: string): MaterialDeletionReturnPath {
  return MATERIAL_DELETION_RETURN_PATHS.find((path) => path === value) ?? "/skills/materials";
}
