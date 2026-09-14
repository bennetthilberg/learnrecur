"use client";

import { Select } from "@mantine/core";
import { useFormDraft } from "@/components/app/use-form-draft";
import { FormDraftNotice } from "@/components/app/form-draft-notice";
import { emptyMaterialWebsiteDraft, materialPdfDraftSchema, materialWebsiteDraftSchema } from "@/lib/forms/material-drafts";

import { Checkbox, Tabs } from "@mantine/core";
import {
  BookOpenText,
  FilePdf,
  GlobeHemisphereWest,
  Sparkle,
  UploadSimple,
} from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";

import { ActionNotification } from "@/components/app/action-notification";
import { MAX_MATERIAL_PDF_PAGES } from "@/lib/materials/contracts";
import type { MaterialLibraryItem } from "@/lib/materials/library";
import {
  MAX_MATERIAL_TITLE_LENGTH,
  materialPdfErrorMessage,
  materialPdfFileErrorMessage,
  materialTitleFromPdfFileName,
  truncateMaterialTitle,
  validateMaterialPdfFile,
} from "@/lib/materials/pdf-upload";
import type { WebsiteDiscovery } from "@/lib/materials/web";

import {
  completeMaterialPdfAction,
  confirmWebsiteMaterialAction,
  discardPreparedMaterialPdfAction,
  discoverWebsiteMaterialAction,
  prepareMaterialPdfAction,
} from "./actions";
import { MaterialDeleteControl } from "./material-delete-control";

type CollectionOption = { id: string; name: string };
type MaterialImportWorkspaceProps = {
  collections: CollectionOption[];
  materials: MaterialLibraryItem[];
};

export function MaterialImportWorkspace({
  collections,
  materials,
}: MaterialImportWorkspaceProps) {
  const [activeSource, setActiveSource] = useState<string | null>("pdf");
  const [isImportBusy, setIsImportBusy] = useState(false);

  return (
    <div className="materialImportLayout" data-layout={materials.length === 0 ? "first-import" : "with-library"}>
      {materials.length > 0 ? (
        <section className="skillPanel materialReusePanel" aria-labelledby="reuse-material-title">
          <div className="skillPanelHeader">
            <div>
              <h2 id="reuse-material-title">Reuse a material</h2>
              <p>Select a book or reference you already imported.</p>
            </div>
            <BookOpenText size={20} weight="bold" aria-hidden="true" />
          </div>
            <div className="materialCompactList">
              {materials.slice(0, 6).map((material) => (
                <article className="materialCompactRow" key={material.id}>
                  <div>
                    <Link className="materialCompactTitle" href={`/skills/materials/${material.id}`}>
                      {material.title}
                    </Link>
                    <p>{materialSummary(material)}</p>
                  </div>
                  <div className="materialCompactActions">
                    <Link
                      aria-label={
                        material.revisionStatus === "READY"
                          ? `Create skills from ${material.title}`
                          : `Open ${material.title}`
                      }
                      className={
                        material.revisionStatus === "READY" ? "primaryButton" : "secondaryButton"
                      }
                      href={
                        material.revisionStatus === "READY"
                          ? `/skills/materials/${material.id}/create`
                          : `/skills/materials/${material.id}`
                      }
                    >
                      {material.revisionStatus === "READY" ? (
                        <>
                          <Sparkle size={15} weight="bold" aria-hidden="true" /> Create skills
                        </>
                      ) : "Open material"}
                    </Link>
                    <MaterialDeleteControl
                      compact
                      materialId={material.id}
                      returnTo="/skills/new/multiple"
                      title={material.title}
                    />
                  </div>
                </article>
              ))}
            </div>
          {materials.length > 6 ? (
            <Link className="materialTextLink" href="/skills/materials">
              View all {materials.length} materials
            </Link>
        ) : null}
      </section>
      ) : null}

      <section className="skillPanel materialImportPanel" aria-labelledby="add-material-title">
        <div className="skillPanelHeader">
          <div>
            <h2 id="add-material-title">Add a material</h2>
            <p>Import once, then return to different chapters over time.</p>
          </div>
        </div>
        <Tabs
          classNames={{
            root: "materialImportTabs",
            list: "materialImportTabList",
            tab: "materialImportTab",
            panel: "materialImportTabPanel",
          }}
          keepMounted
          onChange={(value) => {
            if (!isImportBusy) {
              setActiveSource(value);
            }
          }}
          value={activeSource}
        >
          <Tabs.List aria-label="Material source type">
            <Tabs.Tab
              disabled={isImportBusy}
              leftSection={<FilePdf size={17} weight="bold" />}
              value="pdf"
            >
              PDF
            </Tabs.Tab>
            <Tabs.Tab
              disabled={isImportBusy}
              leftSection={<GlobeHemisphereWest size={17} weight="bold" />}
              value="website"
            >
              Website
            </Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="pdf">
            <MaterialPdfForm collections={collections} onBusyChange={setIsImportBusy} />
          </Tabs.Panel>
          <Tabs.Panel value="website">
            <WebsiteMaterialForm collections={collections} onBusyChange={setIsImportBusy} />
          </Tabs.Panel>
        </Tabs>
      </section>
    </div>
  );
}

function MaterialPdfForm({
  collections,
  onBusyChange,
}: {
  collections: CollectionOption[];
  onBusyChange: (busy: boolean) => void;
}) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const draft = useFormDraft("material-pdf", { title: "", collectionId: "", fileName: "" }, materialPdfDraftSchema);
  const { title } = draft.value;
  const setTitle = (title: string) => draft.update({ title });
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]> | undefined>();
  const [importBusy, runBusy] = useMaterialImportBusy(onBusyChange);
  const isBusy = importBusy || !draft.ready;
  const titleError = fieldErrors?.title?.[0];
  const fileError =
    materialPdfFileErrorMessage(fieldErrors) ?? (file ? validateMaterialPdfFile(file) : null);

  return (
    <form
      className="materialImportForm"
      onSubmit={(event) => {
        event.preventDefault();
        if (isBusy) {
          return;
        }
        if (!file) {
          setError("Choose a PDF file, then select Import PDF.");
          return;
        }
        const fileValidationError = validateMaterialPdfFile(file);
        if (fileValidationError) {
          setError(fileValidationError);
          return;
        }
        const form = event.currentTarget;
        setError(null);
        setFieldErrors(undefined);
        runBusy(() => submitPdf(form, file));
      }}
    >
      <p className="materialImportIntro">
        Up to 100 MB or {MAX_MATERIAL_PDF_PAGES.toLocaleString()} pages.
      </p>
      <div className="skillTwoColumnFields materialImportFields">
        <label className="skillField">
          <span>Material title</span>
          <input
            aria-describedby={titleError ? "material-pdf-title-error" : undefined}
            aria-invalid={titleError ? "true" : undefined}
            disabled={isBusy}
            maxLength={MAX_MATERIAL_TITLE_LENGTH}
            name="title"
            onChange={(event) => {
              setTitle(event.currentTarget.value);
              setFieldErrors(undefined);
              setError(null);
            }}
            placeholder="Practical Spanish Grammar"
            required
            value={title}
          />
          {titleError ? <em id="material-pdf-title-error">{titleError}</em> : null}
        </label>
        <CollectionSelect collections={collections} disabled={isBusy} value={draft.value.collectionId} onChange={(collectionId) => draft.update({ collectionId })} />
      </div>
      <label
        className="materialPdfDropzone"
        data-disabled={isBusy ? "true" : undefined}
        data-invalid={fileError ? "true" : undefined}
      >
        <input
          accept="application/pdf,.pdf"
          aria-describedby={fileError || file ? "material-pdf-file-detail" : undefined}
          aria-invalid={fileError ? "true" : undefined}
          disabled={isBusy}
          onChange={(event) => {
            const selected = event.currentTarget.files?.[0] ?? null;
            setFile(selected);
            draft.update({ fileName: selected?.name ?? "" });
            setError(null);
            setFieldErrors(undefined);
            if (selected && !title.trim()) {
              setTitle(materialTitleFromPdfFileName(selected.name));
            }
          }}
          ref={fileInputRef}
          type="file"
        />
        <UploadSimple size={22} weight="bold" aria-hidden="true" />
        <span>{file ? file.name : "Choose a PDF"}</span>
        {fileError || file ? (
          <small data-tone={fileError ? "error" : undefined} id="material-pdf-file-detail">
            {fileError ?? formatBytes(file?.size ?? 0)}
          </small>
        ) : null}
      </label>
      {draft.value.fileName && !file ? <p className="settingsFieldHint" role="status">Choose {draft.value.fileName} again. Your title and collection have been kept, but files cannot be restored after refresh.</p> : null}
      <FormDraftNotice {...draft} disabled={isBusy} restoredMessage="Unfinished import restored. Review it before importing." onDiscard={() => { setFile(null); if (fileInputRef.current) fileInputRef.current.value = ""; draft.discard(); }} />
      <ActionMessage error={error} message={null} />
      <div className="skillFormActions materialImportActions">
        <button
          aria-busy={importBusy}
          className="primaryButton"
          disabled={isBusy || !file}
          type="submit"
        >
          <span className="buttonPendingContent">
            {isBusy ? <span className="buttonSpinner" aria-hidden="true" /> : null}
            <span aria-live="polite">{isBusy ? "Importing PDF" : "Import PDF"}</span>
          </span>
        </button>
      </div>
    </form>
  );

  async function submitPdf(form: HTMLFormElement, selectedFile: File) {
    let preparedMaterial: { materialId: string; materialRevisionId: string } | null = null;

    try {
      const formData = new FormData(form);
      formData.set("originalName", selectedFile.name);
      formData.set("mimeType", selectedFile.type);
      formData.set("byteSize", String(selectedFile.size));
      const prepared = await prepareMaterialPdfAction(formData);
      if (prepared.status === "error") {
        setFieldErrors(prepared.fieldErrors);
        setError(materialPdfErrorMessage(prepared.fieldErrors, prepared.message));
        return;
      }
      preparedMaterial = {
        materialId: prepared.materialId,
        materialRevisionId: prepared.materialRevisionId,
      };
      const response = await fetch(prepared.uploadUrl, {
        method: "PUT",
        headers: prepared.headers,
        body: selectedFile,
      });
      if (!response.ok) {
        const uploadError = pdfUploadResponseError(response.status);
        const cleanupError = await discardPreparedUpload(preparedMaterial);
        setError(withPdfCleanupWarning(uploadError, cleanupError));
        return;
      }
      const queued = await completeMaterialPdfAction({
        materialRevisionId: prepared.materialRevisionId,
      });
      if (queued.status === "error") {
        const cleanupError = await discardPreparedUpload(preparedMaterial);
        setError(withPdfCleanupWarning(queued.message, cleanupError));
        return;
      }
      preparedMaterial = null;
      draft.saved();
      router.push(queued.redirectTo);
      router.refresh();
    } catch (caught) {
      const cleanupError = preparedMaterial
        ? await discardPreparedUpload(preparedMaterial)
        : null;
      const uploadError =
        preparedMaterial && caught instanceof TypeError
          ? "The browser could not reach private storage. Check your connection and try again."
          : caught instanceof Error
            ? caught.message
            : "Could not import the PDF.";
      setError(withPdfCleanupWarning(uploadError, cleanupError));
    }
  }

  async function discardPreparedUpload(input: {
    materialId: string;
    materialRevisionId: string;
  }) {
    try {
      const result = await discardPreparedMaterialPdfAction(input);
      return result.status === "error" ? result.message : null;
    } catch {
      return "The upload failed and its prepared material could not be cleaned up. Open Materials to remove it.";
    }
  }
}

function pdfUploadResponseError(status: number) {
  if (status === 403) {
    return "Private storage rejected the upload (HTTP 403). Try again; if this continues, contact support.";
  }
  if (status === 413) {
    return "Private storage rejected the PDF because it was too large (HTTP 413). Choose a smaller PDF and try again.";
  }

  return `The private upload failed (HTTP ${status}). Try again.`;
}

function withPdfCleanupWarning(uploadError: string, cleanupError: string | null) {
  return cleanupError
    ? `${uploadError} The incomplete material could not be removed automatically, so it remains in Materials for retry or deletion.`
    : uploadError;
}

function WebsiteMaterialForm({
  collections,
  onBusyChange,
}: {
  collections: CollectionOption[];
  onBusyChange: (busy: boolean) => void;
}) {
  const router = useRouter();
  const draft = useFormDraft("material-website", emptyMaterialWebsiteDraft, materialWebsiteDraftSchema);
  const { url, title, collectionId, discovery } = draft.value;
  const selectedUrls = useMemo(() => new Set(draft.value.selectedUrls), [draft.value.selectedUrls]);
  const setUrl = (url: string) => draft.update({ url });
  const setTitle = (title: string) => draft.update({ title });
  const setCollectionId = (collectionId: string) => draft.update({ collectionId });
  const setDiscovery = (discovery: WebsiteDiscovery | null) => draft.update({ discovery });
  const setSelectedUrls = (value: Set<string> | ((current: Set<string>) => Set<string>)) => draft.update((current) => ({ selectedUrls: [...(typeof value === "function" ? value(new Set(current.selectedUrls)) : value)] }));
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importBusy, runBusy] = useMaterialImportBusy(onBusyChange, () => { setError("Could not reach the server. Check your connection and try again."); setMessage(null); });
  const isBusy = importBusy || !draft.ready;
  const selectedCount = selectedUrls.size;
  const allSelected = Boolean(
    discovery && discovery.pages.length > 0 && selectedCount === discovery.pages.length,
  );

  const orderedSelectedUrls = useMemo(
    () => discovery?.pages.filter((page) => selectedUrls.has(page.url)).map((page) => page.url) ?? [],
    [discovery, selectedUrls],
  );

  return (
    <div className="materialImportForm">
      <p className="materialImportIntro">
        Public, book-like HTTPS sites only. LearnRecur previews the table of contents before saving
        any pages.
      </p>
      <div className="materialWebsiteDiscoveryRow">
        <label className="skillField">
          <span>Textbook or reference URL</span>
          <input
            disabled={isBusy}
            onChange={(event) => {
              setUrl(event.currentTarget.value);
              setDiscovery(null);
              setSelectedUrls(new Set());
            }}
            placeholder="https://openstax.org/details/books/..."
            type="url"
            value={url}
          />
        </label>
        <button
          className="secondaryButton"
          disabled={isBusy || !url.trim()}
          onClick={() => {
            setDiscovery(null);
            setSelectedUrls(new Set());
            setError(null);
            setMessage("Reading the table of contents…");
            runBusy(discover);
          }}
          type="button"
        >
          Discover pages
        </button>
      </div>

      {discovery ? (
        <div className="materialDiscoveryPreview">
          <div className="materialDiscoveryHeader">
            <div>
              <strong>{discovery.title}</strong>
              <p>
                {discovery.pages.length > 0
                  ? `${discovery.pages.length} same-site pages found`
                  : "Official PDF available"}
              </p>
            </div>
            {discovery.pages.length > 0 ? (
              <Checkbox
                checked={allSelected}
                disabled={isBusy}
                label="Select all"
                onChange={(event) => {
                  setSelectedUrls(
                    event.currentTarget.checked
                      ? new Set(discovery.pages.map((page) => page.url))
                      : new Set(),
                  );
                }}
              />
            ) : null}
          </div>
          {discovery.notice ? <p className="materialDiscoveryNotice">{discovery.notice}</p> : null}
          {discovery.preferredPdf ? (
            <div className="materialPdfPreference">
              <FilePdf size={18} weight="bold" aria-hidden="true" />
              <p>
                This site offers a downloadable PDF. For the strongest page references, open{" "}
                <a href={discovery.preferredPdf.url} rel="noreferrer" target="_blank">
                  {discovery.preferredPdf.title}
                </a>{" "}
                and import it in the PDF tab.
              </p>
            </div>
          ) : null}
          {discovery.pages.length > 0 ? (
            <>
              <div className="materialDiscoveryList">
                {discovery.pages.map((page) => (
                  <Checkbox
                    checked={selectedUrls.has(page.url)}
                    className="materialDiscoveryCheckbox"
                    disabled={isBusy}
                    key={page.url}
                    label={page.title}
                    ml={(page.level - 1) * 14}
                    onChange={(event) => {
                      setSelectedUrls((current) => {
                        const next = new Set(current);
                        if (event.currentTarget.checked) {
                          next.add(page.url);
                        } else {
                          next.delete(page.url);
                        }
                        return next;
                      });
                    }}
                  />
                ))}
              </div>
              <div className="skillTwoColumnFields materialDiscoveryFields materialImportFields">
                <label className="skillField">
                  <span>Material title</span>
                  <input
                    disabled={isBusy}
                    maxLength={MAX_MATERIAL_TITLE_LENGTH}
                    onChange={(event) => setTitle(event.currentTarget.value)}
                    required
                    value={title}
                  />
                </label>
                <label className="skillField">
                  <span>Collection</span>
                  <Select disabled={isBusy} value={collectionId}
                    onChange={(value) => setCollectionId(value ?? "")}
                    data={[{ value: "", label: "No collection" }, ...collections.map((collection) => ({ value: collection.id, label: collection.name }))]} />
                </label>
              </div>
              <div className="skillFormActions materialImportActions">
                <span>{selectedCount} pages selected</span>
                <button
                  className="primaryButton"
                  disabled={isBusy || selectedCount === 0 || !title.trim()}
                  onClick={() => {
                    setError(null);
                    setMessage("Saving the selected pages…");
                    runBusy(confirmImport);
                  }}
                  type="button"
                >
                  {isBusy ? "Importing website" : "Import selected pages"}
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
      <FormDraftNotice {...draft} disabled={isBusy} restoredMessage={discovery ? "Unfinished import restored. Review the selected pages before importing." : "Unfinished import restored. Discover pages when you’re ready."} onDiscard={() => draft.discard()} />
      <ActionMessage error={error} message={message} />
    </div>
  );

  async function discover() {
    const result = await discoverWebsiteMaterialAction({ url });
    if (result.status === "error") {
      setDiscovery(null);
      setSelectedUrls(new Set());
      setError(result.message);
      setMessage(null);
      return;
    }
    setDiscovery(result.discovery);
    setTitle(truncateMaterialTitle(result.discovery.title));
    setSelectedUrls(new Set(result.discovery.pages.map((page) => page.url)));
    setMessage(
      result.discovery.pages.length > 0
        ? "Review the pages before importing."
        : null,
    );
  }

  async function confirmImport() {
    if (!discovery) {
      return;
    }
    const result = await confirmWebsiteMaterialAction({
      title,
      collectionId: collectionId || null,
      sourceUrl: discovery.sourceUrl,
      selectedUrls: orderedSelectedUrls,
    });
    if (result.status === "error") {
      setError(result.message);
      setMessage(null);
      return;
    }
    draft.saved();
    router.push(result.redirectTo);
    router.refresh();
  }
}

function useMaterialImportBusy(onBusyChange: (busy: boolean) => void, onError?: () => void) {
  const [isBusy, setIsBusy] = useState(false);

  function runBusy(task: () => Promise<void>) {
    setIsBusy(true);
    onBusyChange(true);
    void task().catch(() => { onError?.(); }).finally(() => {
      setIsBusy(false);
      onBusyChange(false);
    });
  }

  return [isBusy, runBusy] as const;
}

function CollectionSelect({
  collections, disabled, value, onChange,
}: {
  collections: CollectionOption[]; disabled: boolean; value: string; onChange: (value: string) => void;
}) {
  return (
    <label className="skillField">
      <span>Collection</span>
      <Select disabled={disabled} name="collectionId" value={value} onChange={(value) => onChange(value ?? "")}
        data={[{ value: "", label: "No collection" }, ...collections.map((collection) => ({ value: collection.id, label: collection.name }))]} />
    </label>
  );
}

function ActionMessage({ error, message }: { error: string | null; message: string | null }) {
  return (
    <>
      <ActionNotification
        id="material-import-error"
        message={error}
        title="Could not add material"
        tone="error"
      />
      {message ? (
        <p className="materialActionStatus" role="status">
          {message}
        </p>
      ) : null}
    </>
  );
}

function materialSummary(material: MaterialLibraryItem) {
  const parts = [material.collectionName, material.pageCount ? `${material.pageCount} pages` : null];
  return parts.filter(Boolean).join(" · ") || "Ready to organize";
}

function formatBytes(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}
