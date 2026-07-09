"use client";

import { Checkbox, Tabs } from "@mantine/core";
import {
  BookOpenText,
  CheckCircle,
  FilePdf,
  GlobeHemisphereWest,
  UploadSimple,
  WarningCircle,
} from "@phosphor-icons/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, useTransition } from "react";

import {
  MAX_MATERIAL_PDF_BYTES,
  MAX_MATERIAL_PDF_PAGES,
} from "@/lib/materials/contracts";
import type { MaterialLibraryItem } from "@/lib/materials/library";
import type { WebsiteDiscovery } from "@/lib/materials/web";

import {
  completeMaterialPdfAction,
  confirmWebsiteMaterialAction,
  discoverWebsiteMaterialAction,
  prepareMaterialPdfAction,
} from "./actions";

type CollectionOption = { id: string; name: string };
type MaterialImportWorkspaceProps = {
  collections: CollectionOption[];
  materials: MaterialLibraryItem[];
};

export function MaterialImportWorkspace({
  collections,
  materials,
}: MaterialImportWorkspaceProps) {
  return (
    <div className="materialImportLayout">
      <section className="skillPanel materialReusePanel" aria-labelledby="reuse-material-title">
        <div className="skillPanelHeader">
          <div>
            <h2 id="reuse-material-title">Reuse a material</h2>
            <p>Select a book or reference you already imported.</p>
          </div>
          <BookOpenText size={20} weight="bold" aria-hidden="true" />
        </div>
        {materials.length > 0 ? (
          <div className="materialCompactList">
            {materials.slice(0, 6).map((material) => (
              <article className="materialCompactRow" key={material.id}>
                <div>
                  <Link href={`/skills/materials/${material.id}`}>{material.title}</Link>
                  <p>{materialSummary(material)}</p>
                </div>
                <Link
                  className="secondaryButton"
                  href={
                    material.revisionStatus === "READY"
                      ? `/skills/materials/${material.id}/create`
                      : `/skills/materials/${material.id}`
                  }
                >
                  {material.revisionStatus === "READY" ? "Create" : "Open"}
                </Link>
              </article>
            ))}
          </div>
        ) : (
          <div className="materialInlineEmpty">
            <p>No reusable materials yet. Add a PDF or public textbook site below.</p>
          </div>
        )}
        {materials.length > 6 ? (
          <Link className="materialTextLink" href="/skills/materials">
            View all {materials.length} materials
          </Link>
        ) : null}
      </section>

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
          defaultValue="pdf"
          keepMounted={false}
        >
          <Tabs.List aria-label="Material source type">
            <Tabs.Tab leftSection={<FilePdf size={17} weight="bold" />} value="pdf">
              PDF
            </Tabs.Tab>
            <Tabs.Tab leftSection={<GlobeHemisphereWest size={17} weight="bold" />} value="website">
              Website
            </Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="pdf">
            <MaterialPdfForm collections={collections} />
          </Tabs.Panel>
          <Tabs.Panel value="website">
            <WebsiteMaterialForm collections={collections} />
          </Tabs.Panel>
        </Tabs>
      </section>
    </div>
  );
}

function MaterialPdfForm({ collections }: { collections: CollectionOption[] }) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  return (
    <form
      className="materialImportForm"
      onSubmit={(event) => {
        event.preventDefault();
        if (!file) {
          setError("Choose a PDF to import.");
          return;
        }
        if (file.type !== "application/pdf") {
          setError("Materials currently support PDF files only.");
          return;
        }
        if (file.size > MAX_MATERIAL_PDF_BYTES) {
          setError("Reusable PDFs can be up to 100 MB.");
          return;
        }
        const form = event.currentTarget;
        setError(null);
        setMessage("Preparing a private upload…");
        startTransition(() => {
          void submitPdf(form, file);
        });
      }}
    >
      <p className="materialImportIntro">
        Up to 100 MB or {MAX_MATERIAL_PDF_PAGES.toLocaleString()} pages. Scanned pages are kept for
        on-demand OCR.
      </p>
      <div className="skillTwoColumnFields">
        <label className="skillField">
          <span>Material title</span>
          <input
            disabled={isPending}
            maxLength={200}
            name="title"
            onChange={(event) => setTitle(event.currentTarget.value)}
            placeholder="Practical Spanish Grammar"
            required
            value={title}
          />
        </label>
        <CollectionSelect collections={collections} disabled={isPending} />
      </div>
      <label className="materialPdfDropzone">
        <input
          accept="application/pdf,.pdf"
          disabled={isPending}
          onChange={(event) => {
            const selected = event.currentTarget.files?.[0] ?? null;
            setFile(selected);
            setError(null);
            if (selected && !title.trim()) {
              setTitle(fileNameToTitle(selected.name));
            }
          }}
          ref={fileInputRef}
          type="file"
        />
        <UploadSimple size={22} weight="bold" aria-hidden="true" />
        <span>{file ? file.name : "Choose a PDF"}</span>
        <small>{file ? formatBytes(file.size) : "The original stays private in your storage."}</small>
      </label>
      <ActionMessage error={error} message={message} />
      <div className="skillFormActions materialImportActions">
        <button className="primaryButton" disabled={isPending} type="submit">
          {isPending ? "Importing PDF" : "Import PDF"}
        </button>
      </div>
    </form>
  );

  async function submitPdf(form: HTMLFormElement, selectedFile: File) {
    try {
      const formData = new FormData(form);
      formData.set("originalName", selectedFile.name);
      formData.set("mimeType", selectedFile.type);
      formData.set("byteSize", String(selectedFile.size));
      const prepared = await prepareMaterialPdfAction(formData);
      if (prepared.status === "error") {
        setError(prepared.message);
        setMessage(null);
        return;
      }
      setMessage("Uploading the original PDF…");
      const response = await fetch(prepared.uploadUrl, {
        method: "PUT",
        headers: prepared.headers,
        body: selectedFile,
      });
      if (!response.ok) {
        setError("The private upload failed. Try the PDF again.");
        setMessage(null);
        return;
      }
      setMessage("Building the book outline…");
      const queued = await completeMaterialPdfAction({
        materialRevisionId: prepared.materialRevisionId,
      });
      if (queued.status === "error") {
        setError(queued.message);
        setMessage(null);
        return;
      }
      router.push(queued.redirectTo);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not import the PDF.");
      setMessage(null);
    }
  }
}

function WebsiteMaterialForm({ collections }: { collections: CollectionOption[] }) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [collectionId, setCollectionId] = useState("");
  const [discovery, setDiscovery] = useState<WebsiteDiscovery | null>(null);
  const [selectedUrls, setSelectedUrls] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
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
            disabled={isPending}
            onChange={(event) => setUrl(event.currentTarget.value)}
            placeholder="https://openstax.org/details/books/..."
            type="url"
            value={url}
          />
        </label>
        <button
          className="secondaryButton"
          disabled={isPending || !url.trim()}
          onClick={() => {
            setError(null);
            setMessage("Reading the table of contents…");
            startTransition(() => {
              void discover();
            });
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
              <div className="skillTwoColumnFields materialDiscoveryFields">
                <label className="skillField">
                  <span>Material title</span>
                  <input
                    disabled={isPending}
                    maxLength={200}
                    onChange={(event) => setTitle(event.currentTarget.value)}
                    required
                    value={title}
                  />
                </label>
                <label className="skillField">
                  <span>Collection</span>
                  <select
                    disabled={isPending}
                    onChange={(event) => setCollectionId(event.currentTarget.value)}
                    value={collectionId}
                  >
                    <option value="">No collection</option>
                    {collections.map((collection) => (
                      <option key={collection.id} value={collection.id}>
                        {collection.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="skillFormActions materialImportActions">
                <span>{selectedCount} pages selected</span>
                <button
                  className="primaryButton"
                  disabled={isPending || selectedCount === 0 || !title.trim()}
                  onClick={() => {
                    setError(null);
                    setMessage("Saving the selected pages…");
                    startTransition(() => {
                      void confirmImport();
                    });
                  }}
                  type="button"
                >
                  {isPending ? "Importing website" : "Import selected pages"}
                </button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
      <ActionMessage error={error} message={message} />
    </div>
  );

  async function discover() {
    const result = await discoverWebsiteMaterialAction({ url });
    if (result.status === "error") {
      setError(result.message);
      setMessage(null);
      return;
    }
    setDiscovery(result.discovery);
    setTitle(result.discovery.title);
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
    router.push(result.redirectTo);
    router.refresh();
  }
}

function CollectionSelect({
  collections,
  disabled,
}: {
  collections: CollectionOption[];
  disabled: boolean;
}) {
  return (
    <label className="skillField">
      <span>Collection</span>
      <select disabled={disabled} name="collectionId">
        <option value="">No collection</option>
        {collections.map((collection) => (
          <option key={collection.id} value={collection.id}>
            {collection.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function ActionMessage({ error, message }: { error: string | null; message: string | null }) {
  if (!error && !message) {
    return null;
  }
  return (
    <p className="skillFormMessage materialActionMessage" data-tone={error ? "error" : "saved"} role="status">
      {error ? <WarningCircle size={17} weight="bold" aria-hidden="true" /> : <CheckCircle size={17} weight="bold" aria-hidden="true" />}
      {error ?? message}
    </p>
  );
}

function materialSummary(material: MaterialLibraryItem) {
  const parts = [material.collectionName, material.pageCount ? `${material.pageCount} pages` : null];
  return parts.filter(Boolean).join(" · ") || "Ready to organize";
}

function fileNameToTitle(fileName: string) {
  return fileName.replace(/\.pdf$/i, "").replace(/[-_]+/g, " ").trim();
}

function formatBytes(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}
