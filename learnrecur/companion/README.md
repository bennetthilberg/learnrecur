# Companion service

This directory is for the LearnRecur API and generation worker. We haven't chosen a framework or written the service yet.

The service stores skill descriptions and revisions, exercise banks, reports, generation jobs, and API usage and cost records. It provides batch import that can be retried without creating duplicates. Provider keys stay on the server.

Anki's collection and sync server handle cards, scheduling, review history, and media. The companion must not write directly into collection files. The Mac client keeps local copies of exercises and keeps linked skill data consistent between the two services.

Build this during milestone 4, after checking ordinary deck transfer and skill review with cached exercises. See [ROADMAP.md](../../ROADMAP.md) and [AGENTS.md](../../AGENTS.md).
