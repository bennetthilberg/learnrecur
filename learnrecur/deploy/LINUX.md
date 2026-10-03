# Linux deployment and restoration

The backend runs as three processes in Linux containers: the matching Rust sync server, the Python companion, and an optional generation worker. The image contains no desktop or Qt dependencies. Build it on a development machine or in CI, then transfer it to the VPS; the VPS does not need Rust or a GPU.

This first deployment keeps both HTTP ports on the host's loopback address. Reach them through an SSH tunnel. Public HTTPS access remains ahead. Fixtures are the default. OpenAI refills require the explicit setup below, an authorized allowance, and a private worker key. Restored deployments pause generation for inspection.

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


## Enable OpenAI generation

Get spending authorization first. Save the project key privately as `secrets/openai/openai-api-key`, owned by the service user, with mode `600` inside an `openai` folder with mode `700`. Transfer it over SSH or your credential system; never put it in a command, chat, repository, or desktop profile. Only the worker mounts this folder, read-only. The companion and sync server cannot read it. The key and generation configuration are excluded from backend backups.

Stop the deployment, then set the approved allowance in millionths of a dollar. For a $1 trial:

```sh
python3 -m learnrecur.deploy.manage \
  --state "$LEARNRECUR_STATE" --secrets "$LEARNRECUR_SECRETS" \
  --image "$LEARNRECUR_IMAGE" stop
python3 -m learnrecur.deploy.manage \
  --state "$LEARNRECUR_STATE" --secrets "$LEARNRECUR_SECRETS" \
  --image "$LEARNRECUR_IMAGE" configure-openai --monthly-limit-microusd 1000000
python3 -m learnrecur.deploy.manage \
  --state "$LEARNRECUR_STATE" --secrets "$LEARNRECUR_SECRETS" \
  --image "$LEARNRECUR_IMAGE" start-worker
```

The command checks key permissions and sets the database allowance before enabling OpenAI refills. It saves the provider choice in private `secrets/generation.json`, so later starts keep the same choice. Lowering a limit preserves all spending and held reservations. Increasing it or changing credits after attempts have begun is refused. No credits are assumed; apply only verified provider credits with an expiry before the first attempt. The companion queues OpenAI jobs; the worker uses the existing [GPT-6 Luna adapter](../companion/OPENAI.md) with `xhigh` reasoning. Ratings and answer reveals still use the local bank.

The allowance is an estimated monthly cap, not a provider invoice cap. A single trial's authorization does not renew each month. Stop the worker when the trial ends. `stop` stops all three services; `start` brings back sync and companion without restarting the stopped worker. Docker keeps it stopped across host reboots. Protect the key separately from backups, and revoke it through OpenAI if the host is lost.

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

Copy encrypted archives off the VPS after checking success. Keeping them only on the VPS doesn't protect against losing that machine. For scheduling, retention, and verified off-host copying, follow [Automatic backend backups](AUTOMATIC-BACKUPS.md).

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

Start sync and companion with the restored state, then download through a fresh synthetic client. Check ordinary cards, media, the skill card's exact schedule and history, its exercise bank, and an identical skill import. The restore leaves `.restore-pending` and `.paid-restore-pending` in the companion. The first blocks all generation; the second continues to block OpenAI even after fixture-only acknowledgement. The job runner checks these markers too, so running it directly does not bypass the pause.

Older paid job history needs reconciliation against the provider and the original host: a job that was queued when the backup was taken might have incurred a charge afterward. Don't remove the marker or recreate those requests to bypass that check. New paid work stays blocked after restoration. Saved response IDs and reservations remain intact. Inspect them without a provider key or network access:

```sh
python3 -m learnrecur.deploy.manage \
  --state /srv/learnrecur/restored --secrets "$LEARNRECUR_SECRETS" \
  --image "$LEARNRECUR_IMAGE" --project learnrecur-restored inspect-generation
```

The report shows recorded spending, held amounts, attempt states, and response IDs. These are the backup's records, not proof that no later calls happened. For a known saved response, stop the restored services and provide the private worker key separately:

```sh
python3 -m learnrecur.deploy.manage \
  --state /srv/learnrecur/restored --secrets "$LEARNRECUR_SECRETS" \
  --image "$LEARNRECUR_IMAGE" --project learnrecur-restored reconcile-openai \
  --job-id SAVED_JOB_ID --response-id resp_SAVED_RESPONSE_ID
```

Reconciliation retrieves that response through GET, checks its saved model and request identity, and records known usage without reserving or submitting another call. It can also finish a saved pending response after restoration. It leaves both restore markers in place. Missing usage or an unavailable response retains the hold.

If usage and the complete result were already saved but publication was interrupted, run `publish-ready` through the manager while services are stopped. It publishes only saved `result_ready` jobs, without a provider key or network access. Repeating it adds no duplicate batch and leaves both restore markers in place.

An ordinary backup cannot release the paid pause. Looking up its saved response IDs cannot recover requests it never recorded. If the original state survives, use the final handoff below. Otherwise, keep paid generation paused; there is no force option.

For a fixture-only restore, stop the restored services, run the manager's `allow-fixture-worker` command, then `start-worker`. The acknowledgement refuses any saved OpenAI job, including completed jobs. It permits the queued fixture job to finish once without changing its ID.

## Recover paid generation from the original host

A final handoff brings both stores across together, including work done after an older backup. It retires the source before taking the snapshot. Restore that snapshot into a fresh destination; this procedure does not merge rows into an older restored copy.

Use matching tools and an image that supports `handoff-backup`. Before retiring the source, sync any client reviews you want included. Finish pending automatic backups, then disable the source's backup timers and boot recovery service. Stop any active backup services too:

```sh
sudo systemctl disable --now learnrecur-backup.timer learnrecur-backup-check.timer \
  learnrecur-backup-recover.service
sudo systemctl stop learnrecur-backup.service learnrecur-backup-check.service
python3 -m learnrecur.deploy.manage \
  --state /srv/learnrecur/state --secrets "$LEARNRECUR_SECRETS" \
  --image "$LEARNRECUR_IMAGE" --project learnrecur handoff-backup \
  --archive /srv/learnrecur/backups/final-handoff.age \
  --recipient "$LEARNRECUR_BACKUP_RECIPIENT"
```

The command writes retirement markers in both stores, abandons known unsubmitted reservations, stops and removes the source containers, verifies that they stopped, and exports an encrypted archive. Abandoned jobs stay queued for the replacement. Attempts that might have contacted the provider keep their holds. It prints the handoff ID. It never restarts the source, including after an export failure. Retry a failed export with a new archive filename. Keep the source data, archive, matching image, and decryption identity until the replacement is checked.

Retirement blocks the supported sync, companion, and worker launchers, imports, and new generation. Do not remove the retirement markers or start the native server directly. These checks protect the normal deployment path; they cannot fence a separate writable clone on another machine. Keep only one active backend.

If a saved response is still pending, use `reconcile-openai` on the stopped, retired source to retrieve it through GET. Use `publish-ready` for a saved result awaiting publication. Then export another final handoff with a new filename. Every attempt must have recorded usage and charges, and no job may remain running, provider-pending, or in need of attention. An unknown response or uncertain charge keeps recovery paused.

Copy the final archive off-host and restore it with the matching image and existing private credentials, as above. Leave all replacement services stopped. Run `inspect-generation` and check its `handoff_id`, spending, and attempts. Then release the restore pause:

```sh
python3 -m learnrecur.deploy.manage \
  --state /srv/learnrecur/restored --secrets "$LEARNRECUR_SECRETS" \
  --image "$LEARNRECUR_IMAGE" --project learnrecur-restored allow-paid-worker \
  --handoff-id SAVED_HANDOFF_ID --confirm-sole-active-host
```

The acknowledgement means the retired source will stay retired and this replacement will be the only writable copy. The command verifies the final snapshot receipt, source identity, unchanged companion database, and settled generation records before removing both restore markers. It makes no provider call, changes no allowance, and starts no worker. Paid work still requires its private key, explicit provider configuration, and separate spending authorization.

Release the pause before running commands that change the restored companion database, including provider configuration. An altered database or uncheckpointed journal refuses release. Keep that destination for inspection and restore a fresh final snapshot. If you need to reconcile more source responses, do so on the retired source and export again. This deliberately favors preserving complete history over merging two writable copies.

After release, start sync and companion, check the restored cards and media through a fresh client, and only then start an authorized worker. Configure automatic backups for the replacement. Never reactivate the retired source or another copy of the handoff archive.

## Check the setup before a VPS

```sh
ANKI_TEST_MODE=1 PYTHONPATH=.:pylib:out/pylib out/pyenv/bin/python \
  -m learnrecur.deploy.check_restore \
  --root out/learnrecur/linux-restore-proof --image "$image"
```

The check needs the matching native Python backend (`./ninja pylib`), Docker, and fresh synthetic storage. It uploads ordinary and skill cards, media, and a rating to the Linux server. It creates an encrypted backup, stops the source, restores into another deployment, and downloads through a fresh client. It compares cards, reviews, identities, note content, media, and pending jobs, then explicitly resumes a fixture-only job once. A mocked OpenAI job and another review are created after that older backup. A final source handoff preserves their exercises, charges, and native history, while the old backup stays ineligible for paid release. No model call runs. It writes resource measurements and a result under the chosen ignored proof folder and removes only its own containers.

Separate containers on one Docker host prove the Linux runtime and restore procedure. They do not meet the milestone's different-host requirement. That needs a VPS and another restore target. Measure representative collection sizes and resource use before committing to a host; keep the $5/month hosting limit after credits and promotions, and get spending authorization before provisioning.

On October 2, 2026, the Apple Silicon Docker host ran both source and restored Linux deployments. The restored native client had two cards, four reviews, matching skill ownership and media, and six exercises. Native ratings queued both jobs through the app's refill endpoint. One queued fixture job then resumed once and expanded the bank to nine. A tampered encrypted archive failed authentication and created no destination. The three processes used about 43 MiB of memory in this tiny fixture. All 201 affected tests pass. That local ARM64 check did not establish x86-64 CI or recovery on another host. The Azure trial below adds the different-host evidence. Ignored evidence is in `out/learnrecur/linux-deploy/`.

## Azure student-credit trial

On October 2, 2026, an Ubuntu 24.04 ARM VM in Central US passed the different-host restore check. Its size is `Standard_B2pts_v2`: 2 vCPUs, 1 GiB RAM, a persistent 64 GiB P6 SSD, and 2 GiB swap. The x86 free size was unavailable in East US and could not allocate in West US 2. The failed deployment's resources were removed. The ARM size uses standard VM security because Azure rejects Trusted Launch on this size. SSH uses a dedicated key and a source-IP restriction; passwords and root login are disabled. Backend HTTP remains on loopback.

The tested image is `learnrecur-backend:dc85b214f49ae114e45f1737e8496101907395d7`. It was built and checked on the Mac's ARM Linux Docker host before transfer. CI's x86 image cannot run on this VM; build and preserve a matching ARM image for upgrades and recovery. The service user has UID 10001. Docker Engine, Compose, and Python 3.12 run on the host.

A Mac-host encrypted backup restored on Azure with two native cards, four reviews, matching identities and media, and the same companion snapshot and queued job. The worker stayed blocked until fixture-only acknowledgement. The queued job then completed once, and its cache import preserved all reviews. Azure created a new encrypted backup, copied off-host, that restored on the Mac's Linux Docker host. Both stores matched. A real Azure VM reboot restarted sync and companion; a fresh native client reconnected and fetched the saved exercise bank. The worker is now stopped. No provider key is mounted. The temporary recovery identity was removed from Azure, and the test SSH tunnel is closed. The ignored proof folders are under `out/learnrecur/linux-deploy/azure-*`.

The two running services used about 24 MiB of RAM. After reboot, about 566 MiB of host RAM remained available. This tiny synthetic fixture supports an initial private trial; it does not establish capacity for large collections or many users.

The subscription's spending limit remains enabled. Student credits expire August 4, 2027. Expected out-of-pocket hosting is $0 while credits remain. With the [published free VM and disk allowances](https://azure.microsoft.com/en-us/free/students), the standard IPv4 address uses about $3.65/month in credits at $0.005/hour, before traffic or other charges. Confirm actual billed usage once Azure reports it. Credit balance is shared with unrelated resources and is recorded privately in the ignored deployment metadata. Renew eligibility, stop, or move before the credit or free allowance ends; do not upgrade to pay-as-you-go without authorization.

This checks private SSH access, fixture generation, restart, and complete cross-host recovery. The hosted OpenAI trial is recorded below. Automatic off-host backups, retention, release of paid generation after restoring old state, and public HTTPS remain ahead.

## Hosted OpenAI trial

On October 2, 2026, the user authorized up to $1 in estimated trial spending. The Azure worker ran `gpt-6-luna` with `xhigh` reasoning on image `030796543a82865267603d7572532b366966bcbf`. Native Mac ratings of the synthetic Spanish card automatically queued one refill. Its saved example and nine existing prompts guided generation. One attempt produced three correct, in-scope exercises: `visité`, `escuché`, and `limpié`. Usage was 425 input and 224 output tokens. Saved pricing gives $0.000155 estimated cost; the $0.008596 reservation settled to that amount, with no hold left. No provider credits were assumed. This is an estimate from usage, not invoice confirmation. The earlier Mac trial's separate store and held reservation remain intact.

The visible Mac app automatically expanded its bank from nine exercises to twelve at the deck list. The exact card, schedule, reviews, and rating undo stayed unchanged. With external connections blocked and the SSH tunnel closed, the restarted app revealed and rated all three generated exercises; native undo and redo passed. Reopening and native sync retained two cards and twelve reviews. A fresh client matched the saved native rows and media. The check used the source-built Mac UI and the documented accessibility test flags; it does not close the Qt accessibility issue or establish a notarized package release.

Azure backed up both stores after those reviews synced. Its encrypted backup restored on the Mac's ARM Linux Docker host with matching native rows, media, companion snapshot, job, response ID, allowance, and $0.000155 spending. Both restore markers remained in place. Refills and direct paid-worker startup stayed blocked. A separate synthetic copy simulated interruption after saving the response ID; the existing CLI retrieved that real response through GET and recovered the same bank and usage without a new attempt. The original restored backup and Azure accounting were not changed by that simulation.

Only the worker had the read-only provider-key mount. Sync and companion had no access to it. The worker is stopped at the end of the trial; sync and companion remain available through private SSH access. The encrypted backup is copied off-host. Evidence is in the ignored `out/learnrecur/hosted-openai-20261002/` folder. The initial review's saved-result publication fix has regression coverage, including restored paid results published without a key or network access.
