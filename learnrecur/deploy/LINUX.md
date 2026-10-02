# Linux deployment and restoration

The backend runs as three processes in Linux containers: the matching Rust sync server, the Python companion, and an optional fixture worker. The image contains no desktop or Qt dependencies. Build it on a development machine or in CI, then transfer it to the VPS; the VPS does not need Rust or a GPU.

This first deployment keeps both HTTP ports on the host's loopback address. Reach them through an SSH tunnel. Public HTTPS access and production OpenAI generation are later changes. The companion accepts fixture refill requests. They remain queued until the optional worker starts; it can only run fixtures in this configuration. Restored deployments disable refills and block the worker until their job history is checked. No API key is mounted.

## Prepare the host

Use a supported Linux distribution with Docker Engine and the Compose plugin, plus Python 3.12 or later for the management command. Ubuntu 24.04 LTS is the first VPS target. Follow [Docker's Ubuntu installation instructions](https://docs.docker.com/engine/install/ubuntu/). Run the manager as a dedicated non-root service user with permission to run Docker. Its UID is also the container UID. Docker access is privileged host access; don't give it to untrusted users.

Keep the repository, backend state, credentials, and encrypted backups in separate directories. Keep inbound backend ports closed; SSH is enough for this private deployment. Don't expose the containers' HTTP listeners directly. [Compose port bindings](https://docs.docker.com/reference/compose-file/services/#ports) in the supplied file use `127.0.0.1` explicitly.

From a clean checkout, with the translation submodules available:

```sh
git submodule update --init ftl/core-repo ftl/qt-repo
revision=$(git rev-parse HEAD)
image="learnrecur-backend:$revision"
docker build -f learnrecur/deploy/Dockerfile \
  --build-arg BUILD_REVISION="$revision" -t "$image" .
```

The Dockerfile pins both base-image digests and builds this fork, not upstream Anki. The build context excludes profiles, `out/`, credentials, and arbitrary deployment files. Preserve the exact image for restoration. To move it to another host, use `docker image save` and `docker image load`, or an authorized private registry. Linux CI saves the checked x86-64 image as a seven-day GitHub Actions artifact. Download the artifact from a successful main-branch run, transfer it privately, and load it with `zstd -dc backend-image.tar.zst | docker image load`. Keep a protected copy beyond the artifact expiry. No registry publishing is configured here.

Choose new directories owned by the service user. These paths are examples, not directories the tool discovers:

```sh
export LEARNRECUR_IMAGE="$image"
export LEARNRECUR_STATE=/srv/learnrecur/state
export LEARNRECUR_SECRETS=/srv/learnrecur/secrets
python3 -m learnrecur.deploy.manage \
  --state "$LEARNRECUR_STATE" --secrets "$LEARNRECUR_SECRETS" \
  --image "$LEARNRECUR_IMAGE" init
python3 -m learnrecur.deploy.manage \
  --state "$LEARNRECUR_STATE" --secrets "$LEARNRECUR_SECRETS" \
  --image "$LEARNRECUR_IMAGE" start
```

Run those commands from the repository root. Initialization creates marked storage and private random credentials. It refuses existing directories. The sync username is `learnrecur`; its generated password is in `secrets/sync-account`. The companion token is in `secrets/companion-token`. Provision these through your private credential store; don't paste them into issues, logs, or this repository. [Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/) mount each credential only into the process that needs it.

From the Mac, replace `server` with the VPS's SSH address:

```sh
ssh -N -L 45331:127.0.0.1:45331 -L 45321:127.0.0.1:45321 server
```

The LearnRecur profile uses `http://127.0.0.1:45331/` for native sync and `http://127.0.0.1:45321` for the companion. Supply the companion token through its existing launch environment. Use a fresh synthetic LearnRecur profile for the first VPS test. A tunnel disconnect leaves cached review available. This does not use an Anki profile or AnkiWeb account.

## Back up both stores

Create an [age identity](https://github.com/FiloSottile/age#usage) on a separate trusted machine. Keep the private identity in your password manager and a second protected recovery location. Put only its public `age1…` recipient on the VPS. Losing the identity makes its backups unreadable. Server credentials and provider keys are deliberately excluded; keep them in the credential store separately.

```sh
python3 -m learnrecur.deploy.manage \
  --state "$LEARNRECUR_STATE" --secrets "$LEARNRECUR_SECRETS" \
  --image "$LEARNRECUR_IMAGE" backup \
  --archive /srv/learnrecur/backups/backend-2026-10-02.age \
  --recipient age1YOUR_PUBLIC_RECIPIENT
```

The manager stops all running services in this deployment, verifies that none remain running, copies both marked stores, checks their databases, hashes the files, and encrypts the archive. It then restarts only the services that were running before, including after a failed backup. Use the manager for starts and stops; don't launch another writer against these same folders during backup. Concurrent manager operations are locked.

The archive includes synced collections, media, trusted card identities, skill descriptions and revisions, exercise batches, job states, response IDs, attempts, reservations, usage, credits, and their expiry dates. It preserves committed SQLite journal data. The native binary checks collection integrity with Anki's pinned `unicase` comparison; other databases use SQLite's normal integrity check. Copying only the main database file can miss committed journal data. [SQLite's backup guidance](https://www.sqlite.org/howtocorrupt.html#_backup_or_restore_while_a_transaction_is_active)

A backend backup covers what reached the server. Reviews or media still offline on a client need that client's separate LearnRecur backup. This tool does not discover or back up desktop profiles.

Copy encrypted archives off the VPS after checking success. Keeping them only on the VPS doesn't protect against losing that machine. Scheduling, retention, and automatic off-host copying are not configured in this slice.

## Restore on another host

Load the exact saved image, recreate private credentials with the same sync username, and stop the original deployment before accepting writes on the replacement. Don't run two copies of a restored backend as independent production servers.

Use a new state directory and a different Compose project name while testing. Mount the private age identity only for the restore, then remove that recovery copy from the VPS through your normal credential procedure.

```sh
python3 -m learnrecur.deploy.manage \
  --state /srv/learnrecur/restored --secrets "$LEARNRECUR_SECRETS" \
  --image "$LEARNRECUR_IMAGE" --project learnrecur-restored restore \
  --archive /srv/learnrecur/backups/backend-2026-10-02.age \
  --identity /srv/learnrecur/recovery/identity
```

Restoration verifies the image revision, file hashes, path safety, size limits, both store markers, and database integrity. It never replaces an existing state directory. An interrupted restore leaves an unmarked, incomplete destination that cannot start. Keep it for inspection and choose another fresh destination when retrying.

Start sync and companion with the restored state, then download through a fresh synthetic client. Check ordinary cards, media, the skill card's exact schedule and history, its exercise bank, and an identical skill import. The restore leaves `.restore-pending` in the companion, and the worker cannot start while it exists.

Older paid job history needs reconciliation against the provider and the original host: a job that was queued when the backup was taken might have incurred a charge afterward. Don't remove the marker or recreate those requests to bypass that check. This deployment deliberately cannot resume paid work after restoration. Saved response IDs and reservations remain intact for the later recovery procedure.

For a fixture-only restore, stop the restored services, run the manager's `allow-fixture-worker` command, then `start-worker`. The acknowledgement refuses any saved OpenAI job, including completed jobs. It permits the queued fixture job to finish once without changing its ID.

## Check the setup before a VPS

```sh
ANKI_TEST_MODE=1 PYTHONPATH=.:pylib:out/pylib out/pyenv/bin/python \
  -m learnrecur.deploy.check_restore \
  --root out/learnrecur/linux-restore-proof --image "$image"
```

The check needs the matching native Python backend (`./ninja pylib`), Docker, and fresh synthetic storage. It uploads ordinary and skill cards, media, and a rating to the Linux server. It creates an encrypted backup, stops the source, restores into another deployment, and downloads through a fresh client. It compares cards, reviews, identities, note content, media, and pending jobs, then explicitly resumes a fixture-only job once. It writes resource measurements and a result under the chosen ignored proof folder and removes only its own containers.

Separate containers on one Docker host prove the Linux runtime and restore procedure. They do not meet the milestone's different-host requirement. That needs a VPS and another restore target. Measure representative collection sizes and resource use before committing to a host; keep the $5/month hosting limit after credits and promotions, and get spending authorization before provisioning.

On October 2, 2026, the Apple Silicon Docker host ran both source and restored Linux deployments. The restored native client had two cards, four reviews, matching skill ownership and media, and six exercises. Native ratings queued both jobs through the app's refill endpoint. One queued fixture job then resumed once and expanded the bank to nine. A tampered encrypted archive failed authentication and created no destination. The three processes used about 43 MiB of memory in this tiny fixture. All 201 affected tests pass. This is an ARM64 Linux proof; x86-64 Linux CI and a different VPS host remain separate checks. Ignored evidence is in `out/learnrecur/linux-deploy/`.
