# Publishing builds to QAIT from your CI/CD pipeline

This guide is written to be handed to a customer. It covers publishing an
Android or Flutter-Android build from a pipeline so QAIT always tests the
build you just shipped.

Everything you need is in this folder:

| File | What it is |
|---|---|
| [`qait-publish.sh`](qait-publish.sh) | The publish script. Commit it to your repo — it does the work. |
| [`main_qait.dart`](main_qait.dart) | The Flutter entrypoint that makes a build drivable. Flutter apps only. |
| [`github-actions-check.yml`](github-actions-check.yml) | **Add this one first.** A 20-second GitHub Actions workflow that verifies the key and the network, and builds nothing. |
| [`github-actions.yml`](github-actions.yml) | Ready-to-paste GitHub Actions job. |
| [`gitlab-ci.yml`](gitlab-ci.yml) | Ready-to-paste GitLab CI job. |

---

## How it works

Three HTTP calls, and **the binary never passes through the QAIT backend**:

```
1. POST /api/v1/mobile/ci/app/upload-url   → { uploadUrl, storagePath, requiredHeaders, variant }
2. PUT  <uploadUrl>                        → the .apk goes straight to blob storage
3. POST /api/v1/mobile/ci/app/finalize     → QAIT parses it, checks it, records it
```

`qait-publish.sh` does all three. You never call them by hand.

Authentication is a single project-scoped key sent as
`Authorization: Bearer qai_ci_<64 hex>`. There is no project id in any request —
**the key is the project**.

---

## Before you start

- [ ] A QAIT project exists, and its workspace is on a **paid plan** (mobile testing is a Pro feature)
- [ ] Your pipeline already produces an `.apk` (or can)
- [ ] You can add a secret to your CI system
- [ ] Your CI runner can reach `api.qait.dev` and `qaiprodappsc3f4ef.blob.core.windows.net` on port 443
- [ ] `curl` and `jq` are available in the job (both are present on GitHub-hosted and GitLab SaaS runners; `jq` may need installing in a custom image)

---

## Step 1 — make the build drivable (Flutter only)

**Skip this step for a native Android app.** A native app is driven through the
accessibility layer and needs no changes at all.

QAIT drives Flutter through the Dart VM Service, which a **release build does
not expose**, and through the Flutter driver extension, which must be
**compiled in**. A stock `flutter build apk --release` cannot be automated and
is rejected at upload time.

The fix does not touch your production `lib/main.dart`. Add one file:

```dart
// lib/main_qait.dart
import 'package:flutter_driver/driver_extension.dart';
import 'main.dart' as app;

void main() {
  enableFlutterDriverExtension();
  app.main();
}
```

and build through it, in debug mode:

```bash
flutter pub add "dev:flutter_driver:{sdk: flutter}"
```

```bash
flutter build apk --debug --target=lib/main_qait.dart
```

`flutter_driver` is added as a **dev** dependency and the new entrypoint is only
used by the `--target` flag in your QAIT job, so none of this reaches the build
you ship to users.

> **Expect a bigger artifact.** A debug APK is considerably larger than your
> release build — no tree-shaking, no obfuscation, debug symbols included. The
> upload limit is 500 MB.

## Step 2 — generate the CI key

In the QAIT **web app**: your project → **Mobile Settings** → **CI API Key** →
**Generate CI Key**.

Four things to know:

- The key is shown **once**. Afterwards only the `qai_ci_xxxxxxxx` prefix is
  visible — there is no way to see it again.
- You need **owner** or **full_access** on the project to generate it.
- **Regenerating replaces the existing key**, immediately breaking any pipeline
  still using the old one.
- The key carries the **project owner's** write permission. If that account
  loses access to the workspace, uploads start failing with `WRITE_DENIED`.
  Generate the key from an account that will stay.

## Step 3 — store it as a CI secret

Never commit the key, never paste it into a pipeline file, never `echo` it.

| CI system | Where |
|---|---|
| GitHub Actions | Settings → Secrets and variables → Actions → New repository secret, named `QAIT_CI_KEY` |
| GitLab CI | Settings → CI/CD → Variables → `QAIT_CI_KEY`, tick **Masked** (see the note below before ticking **Protected**) |
| Bitbucket | Repository settings → Repository variables → tick **Secured** |
| Jenkins | Credentials → Secret text, bound with `withCredentials` |

If your repository accepts pull requests from forks, make sure the publish job
does **not** run on fork-triggered builds — otherwise a PR can read the secret.

> **GitLab only — the "Protected" tick has a catch.** A *protected* variable is
> handed only to jobs running on a **protected branch or tag**. If the branch
> that publishes your build isn't protected, GitLab silently omits the variable
> and the job fails with:
>
> ```
> qait: QAIT_CI_KEY is not set — add it as a CI secret
> ```
>
> which reads as "the variable didn't save" even though it is sitting right
> there in the settings page. So:
>
> - publishing from a **protected** branch (usually `main`) → tick Protected;
> - publishing from any **unprotected** branch → leave Protected **unticked**,
>   or protect that branch first.
>
> **Masked is a separate setting and you always want it** — it is what keeps the
> key out of job logs. Nothing about the catch above applies to it.

## Step 4 — check the key and the network *before* wiring the pipeline

Commit [`qait-publish.sh`](qait-publish.sh) to your repo (`ci/qait-publish.sh`
is a good home), make it executable, and run:

```bash
QAIT_CI_KEY=qai_ci_... ./ci/qait-publish.sh --check
```

It validates the key and confirms both hosts are reachable, and uploads
nothing:

```
qait: checking https://api.qait.dev ...
qait: key OK — project 7c1f...
qait: checking https://qaiprodappsc3f4ef.blob.core.windows.net ...
qait: blob storage reachable (HTTP 400)
qait: all checks passed
```

`HTTP 400` from blob storage is expected and means **reachable** — you got an
answer from the server. A hang or timeout means a proxy or firewall is in the
way, and that is a conversation with your network team, not with QAIT.

**Run this from inside a CI job too, not just your laptop** — that is what
actually matters, because your runner's network is not your laptop's.
[`github-actions-check.yml`](github-actions-check.yml) is a ready-made workflow
that does exactly this and nothing else: add it, run it once from the Actions
tab, and you have proved the key, the secret wiring and both hosts before any
build exists to go wrong.

It is worth the extra step because a publish job can fail for two unrelated
reasons — the key/network is wrong, or the build is wrong — and in a failed
publish job those look the same. Ruling out the first makes the second
diagnosable. It also does not consume the upload window, so you can re-run it
freely while sorting out access.

Self-hosted runners behind a corporate proxy are the usual place this fails, and
the blob host is the one people forget to allowlist: the API can be reachable
while the upload itself hangs.

## Step 5 — add it to the pipeline

Paste in [`github-actions.yml`](github-actions.yml) or
[`gitlab-ci.yml`](gitlab-ci.yml). The publish step is one line:

```yaml
- run: bash ./ci/qait-publish.sh build/app/outputs/flutter-apk/app-debug.apk
```

The script fills in the commit SHA, branch and pipeline id automatically on
GitHub Actions, GitLab CI, Bitbucket and Jenkins. On anything else, set
`QAIT_COMMIT_SHA` yourself.

That's the whole integration. Tests then run from the QAIT app against
whatever build last landed.

---

## Several environments

Publish each flavour into its own **variant lane** — one QAIT project, several
lanes, one key:

```bash
./ci/qait-publish.sh --variant Staging build/app/outputs/flutter-apk/app-staging-debug.apk
```

- Create and manage lanes in the web app: project → **Mobile Settings** → the
  build row (add / rename / delete / set default).
- Omit `--variant` and the build lands in the project's configured default lane.
- `default` is reserved — that's the main upload slot.
- Pruning is per-lane, so a Staging upload never evicts your Production build.
- **Limit: 3 named lanes per project and platform.** Ask QAIT support if you
  need more.
- For Flutter, lanes live under the `android` platform. This is also why the
  script sends `platform: android` — a Flutter Android build *is* an `.apk`.

There is **one key per project**, so lanes share a key and are distinguished by
`--variant`. If you need credentials that can be revoked per environment, use
separate QAIT projects — but note that separate projects also mean separate
test suites.

---

## Limits

| | |
|---|---|
| Max upload size | 500 MB |
| Accepted files | `.apk`, `.aab`, `.ipa`, `.zip` |
| Publish rate | **30 per project per hour** (configurable per deployment) |
| Named variant lanes | 3 per project and platform |

The limit is a ceiling on a runaway pipeline, not a budget you are expected to
spend: retention keeps only the 10 newest builds per lane, so publishing often
does not accumulate storage. A retry immediately after a success — or after a
rejected build — is fine, and a matrix that publishes several lanes in parallel
is fine.

What a 429 returns: `Retry-After` as a header **and** `retryAfterSeconds` in the
JSON body, both counting down the remainder of the current hour.

One publish at a time per project is serialised server-side. Parallel jobs are
not rejected — they queue, for up to 90 seconds, then get a 429 telling them to
retry. In practice a two-lane matrix simply takes twice one publish's time.

---

## When something fails

`qait-publish.sh` prints the server's own explanation, including the exact
remediation for a rejected build. Read the job log first — it usually contains
the fix.

| Code | Means | What to do |
|---|---|---|
| `DRIVER_EXTENSION_MISSING` | Flutter debug build without the driver extension | Step 1 — build via `main_qait.dart` |
| `BUILD_NOT_DEBUG` | A release or profile Flutter build | Step 1 — add `--debug` |
| `BUILD_UNVERIFIABLE` | The file could not be read, or its build mode is unknown | Check the pipeline uploaded the real artifact and the build completed |
| `VERSION_IDENTITY_REQUIRED` | No commit SHA or version sent | Set `QAIT_COMMIT_SHA` |
| `DUPLICATE_COMMIT` | This commit is already published in this lane | Nothing — the script treats it as success |
| `RATE_LIMITED` | Hourly publish quota spent, or another publish for this project is still running | Retry after `retryAfterSeconds` from the response body |
| `UPGRADE_REQUIRED` | Workspace is not on a paid plan | Upgrade |
| `WRITE_DENIED` | The key's owner lost write access to the project | Re-grant access, or regenerate the key from an account that has it |
| `RATE_LIMITER_UNAVAILABLE` | A transient server-side outage; publishing is briefly refused rather than run unmetered | Retry in a minute |
| `413` / too large | Over 500 MB | Reduce the build, or talk to QAIT support |
| `QAIT_CI_KEY is not set` | The variable exists but wasn't given to this job — on GitLab, almost always a **Protected** variable on an unprotected branch | See the note in Step 3. Not a QAIT error: the job never reached us |

A **non-JSON response** or a timeout is almost never QAIT — it means a proxy
answered instead of us. Re-run `--check` from the same runner.

---

## What's next: triggering test runs from CI

Publishing a build and *running tests* are separate. Most teams start with
publishing only, and run tests from the QAIT app on their own schedule.

When you want the pipeline to kick off a run as well, there is
`POST /api/v1/mobile/ci/run` (same key, same auth), which accepts
`savedTestCaseIds` or `planId`, plus an optional `callbackUrl` so your system is
notified when the run finishes without polling. Ask QAIT support to walk you
through it once builds are landing reliably.
