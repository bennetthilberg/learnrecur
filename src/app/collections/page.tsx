import { auth, currentUser } from "@clerk/nextjs/server";
import Link from "next/link";
import { PlayCircle } from "@phosphor-icons/react/dist/ssr";

import { PanelHeaderCount } from "@/components/app/panel-header-count";
import { UserStatusPanel } from "@/components/app/user-status-panel";
import {
  getCollectionsHome,
  type CollectionSummary,
} from "@/lib/collections";
import { ensureDatabaseUser } from "@/lib/users";

import {
  CollectionArchiveForm,
  CollectionCreateForm,
  CollectionRestoreForm,
  CollectionUpdateForm,
} from "./collection-forms";
import { SkillsTopbar } from "../skills/skills-topbar";

export const dynamic = "force-dynamic";

export default async function CollectionsPage() {
  const { userId } = await auth.protect();
  const clerkUser = await currentUser();

  if (!clerkUser) {
    throw new Error(`Clerk returned no user for authenticated user ${userId}.`);
  }

  const databaseUser = await ensureDatabaseUser(clerkUser);

  if (databaseUser.status !== "ready") {
    return (
      <main className="skillShell">
        <SkillsTopbar current="collections" />
        <UserStatusPanel id="collections-setup-title" status={databaseUser} />
      </main>
    );
  }

  const home = await getCollectionsHome({
    userId,
    now: new Date(),
  });

  return (
    <main className="skillShell">
      <SkillsTopbar current="collections" />

      <header className="skillHeader">
        <div>
          <h1>Organize practice</h1>
          <p>
            Create, describe, archive, and restore the study areas that organize
            your skills.
          </p>
        </div>
        <Link className="secondaryButton" href="/skills/new">
          Add skill
        </Link>
      </header>

      <section className="skillPanel collectionCreatePanel" aria-labelledby="create-collection-title">
        <div className="skillPanelHeader">
          <div>
            <h2 id="create-collection-title">Add a study area</h2>
          </div>
        </div>
        <CollectionCreateForm />
      </section>

      <section className="skillPanel collectionManagementPanel" aria-labelledby="active-collections-title">
        <div className="skillPanelHeader">
          <div>
            <h2 id="active-collections-title">Current collections</h2>
          </div>
          <PanelHeaderCount
            ariaLabel="Active collections shown"
            label="Active"
            value={formatCount(home.activeCollections.length)}
          />
        </div>

        {home.activeCollections.length === 0 ? (
          <CollectionEmptyState
            title="No active collections yet"
            detail="Create a study area, then use its row to practice only that collection."
          />
        ) : (
          <div className="skillLibraryList">
            {home.activeCollections.map((collection) => (
              <ActiveCollectionRow collection={collection} key={collection.id} />
            ))}
          </div>
        )}
      </section>

      {home.archivedCollections.length > 0 ? (
        <section
          className="skillPanel collectionManagementPanel skillRecoveryPanel"
          aria-labelledby="archived-collections-title"
        >
          <div className="skillPanelHeader">
            <div>
              <h2 id="archived-collections-title">Archived collections</h2>
            </div>
            <PanelHeaderCount
              ariaLabel="Archived collections shown"
              label="Archived"
              value={formatCount(home.archivedCollections.length)}
            />
          </div>

          <div className="skillLibraryList">
            {home.archivedCollections.map((collection) => (
              <ArchivedCollectionRow collection={collection} key={collection.id} />
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}

function ActiveCollectionRow({
  collection,
}: {
  collection: CollectionSummary;
}) {
  return (
    <article className="skillLibraryRow collectionManagementRow">
      <div className="skillLibraryRowMain">
        <div>
          <strong>{collection.name}</strong>
          <p>{collection.description ?? "Description not set."}</p>
        </div>
        <div
          className="collectionReadyStat"
          data-ready={collection.readyNowCount > 0 ? "true" : "false"}
        >
          <span>Ready now</span>
          <strong>{formatCount(collection.readyNowCount)}</strong>
        </div>
      </div>
      <CollectionMetaLine collection={collection} />
      <div className="collectionRowActions">
        <CollectionArchiveForm collectionId={collection.id} collectionName={collection.name} />
        <CollectionUpdateForm collection={collection} />
        <Link
          aria-label={`Practice collection ${collection.name}`}
          className="secondaryButton collectionPracticeLink"
          data-ready={collection.readyNowCount > 0 ? "true" : "false"}
          href={`/practice?collectionId=${encodeURIComponent(collection.id)}`}
        >
          <PlayCircle aria-hidden="true" size={18} weight="regular" />
          {collection.readyNowCount > 0 ? "Practice now" : "Open practice"}
        </Link>
      </div>
    </article>
  );
}

function ArchivedCollectionRow({
  collection,
}: {
  collection: CollectionSummary;
}) {
  return (
    <article className="skillLibraryRow collectionManagementRow">
      <div className="skillLibraryRowMain">
        <div>
          <strong>{collection.name}</strong>
          <p>
            {collection.description ??
              "Archived from dashboard summaries. Skills inside remain recoverable."}
          </p>
        </div>
        <span className="dashboardChip">Archived</span>
      </div>
      <CollectionMetaLine collection={collection} />
      <CollectionRestoreForm collectionId={collection.id} collectionName={collection.name} />
    </article>
  );
}

function CollectionMetaLine({
  collection,
}: {
  collection: CollectionSummary;
}) {
  const skillMix = formatCollectionSkillMix(collection);

  return (
    <dl className="collectionFacts" aria-label={`${collection.name} collection details`}>
      <div data-priority="primary">
        <dt>Skill mix</dt>
        <dd className="collectionSkillMix">
          {skillMix.map((item) => (
            <span key={item.label}>
              <strong>{formatCount(item.count)}</strong> {formatSkillMixLabel(item)}
            </span>
          ))}
        </dd>
      </div>
      <div>
        <dt>Sources</dt>
        <dd>{formatSourceCount(collection.sourceCount)}</dd>
      </div>
      <div>
        <dt>Updated</dt>
        <dd>{formatDate(collection.updatedAt)}</dd>
      </div>
    </dl>
  );
}

function CollectionEmptyState({
  title,
  detail,
}: {
  title: string;
  detail: string;
}) {
  return (
    <div className="dashboardEmptyState">
      <h3>{title}</h3>
      <p>{detail}</p>
    </div>
  );
}

function formatSourceCount(count: number) {
  return count === 1 ? "1 source" : `${formatCount(count)} sources`;
}

function formatCollectionSkillMix(collection: CollectionSummary) {
  const mix = [
    { count: collection.skillCounts.active, label: "active" },
    { count: collection.skillCounts.draft, label: "draft" },
    { count: collection.skillCounts.paused, label: "paused" },
    { count: collection.skillCounts.archived, label: "archived" },
  ].filter((item) => item.count > 0);

  return mix.length > 0 ? mix : [{ count: 0, label: "skills" }];
}

function formatSkillMixLabel(item: { count: number; label: string }) {
  if (item.label === "draft") {
    return item.count === 1 ? "draft" : "drafts";
  }

  return item.label;
}

function formatCount(count: number) {
  return new Intl.NumberFormat("en-US").format(count);
}

function formatDate(date: Date) {
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}
