# Companion service

This directory is reserved for the LearnRecur API and generation worker. No service implementation or framework has been selected yet.

The companion owns skill descriptions and revisions, retry-safe batch import, exercise banks, reports, durable generation/refill jobs, and estimated and actual API usage. Provider keys stay on the server.

Anki's native collection and sync server own cards, scheduling, review history, and media. The companion does not write directly into collection files. The Mac client caches exercises and reconciles both stores.

Implement this during roadmap milestone 4, after proving ordinary deck compatibility and locally cached skill review. See [ROADMAP.md](../../ROADMAP.md) and [AGENTS.md](../../AGENTS.md).
