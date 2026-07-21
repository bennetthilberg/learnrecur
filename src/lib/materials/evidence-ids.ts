const MATERIAL_PAGE_EVIDENCE_PREFIX = "material-page:";

export function materialPageEvidenceId(pageId: string) {
  return `${MATERIAL_PAGE_EVIDENCE_PREFIX}${pageId}`;
}

export function parseMaterialPageEvidenceId(evidenceId: string) {
  return evidenceId.startsWith(MATERIAL_PAGE_EVIDENCE_PREFIX)
    ? evidenceId.slice(MATERIAL_PAGE_EVIDENCE_PREFIX.length) || null
    : null;
}
