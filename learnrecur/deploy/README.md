# Deployment

This directory is reserved for reproducible hosting, backup, restore, and host-migration configuration. No infrastructure has been provisioned.

Deploy Anki's pinned standalone sync server and the companion API/worker as separate components. Give each its own persistent storage; sync-server storage must also be separate from desktop profiles. Restrict access to the personal account and use HTTPS or a private network.

Choose a host after measuring resource needs. Total hosting must stay at or below $5/month; the Windows utility PC is the fallback. Generation has a separate configurable $5/month estimated-use limit. Obtain authorization before incurring costs.

Backups must cover the sync collection and media, companion database, and durable job state. Demonstrate restoration on a different host and recovery after reboot before claiming operational readiness. Keep local credentials, runtime state, and backups out of Git.

Implement this during roadmap milestone 4. See [ROADMAP.md](../../ROADMAP.md) and [AGENTS.md](../../AGENTS.md).
