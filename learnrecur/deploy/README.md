# Deployment

This directory is for setting up hosting, backups, restores, and moves between hosts. No hosting has been set up yet.

Run Anki's pinned sync server and the companion API and worker as separate components. Give each its own persistent storage, and keep sync-server storage separate from desktop profiles. Limit access to the personal account and use HTTPS or a private network.

Measure resource needs before choosing a host. Hosting must cost no more than $5/month out of pocket. AI generation has a separate configurable $5/month estimated out-of-pocket limit. Apply eligible student discounts, credits, promotions, and similar offers before checking these limits, and track when they expire. The Windows utility PC is the hosting fallback. Get authorization before spending money.

Back up the sync collection and media, companion database, and job state. Check that those backups restore on another host and that jobs recover after reboot before calling the setup reliable. Keep local credentials, runtime data, and backups out of Git.

Build this during milestone 4. See [ROADMAP.md](../../ROADMAP.md) and [AGENTS.md](../../AGENTS.md).
