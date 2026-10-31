> 🧭 EXPLORATION — not a spec. No locked decisions; nothing here is build-ready.

# Exploring: ephemeral test environments

**Date**: 2026-10-30 · **Emphasis**: research-heavy · **Intensity**: 0.5 (Exploratory)

## Framing

This is for whoever decides how quirky's test suite gets compute after the fixed OVH and gcloud hosts. "Ephemeral test environment" covers six product categories, and only three of them fit a suite of test files with no deployed service.

The question was broad, so I surveyed all six and then measured the options against quirky's own numbers. All prices and release dates are a 2026-10-30 snapshot.

## What was explored

- PR preview platforms, Kubernetes-native isolation, API sandboxes and microVMs, ephemeral CI runners, ephemeral macOS, and throwaway test dependencies.
- About 44 Reddit threads across 21 subreddits, read through the Arctic Shift archive.
- Quirky's real per-file durations from the OVH box, and the Cloud Run Jobs trial recorded on the same day.
- Left out: long-tail and non-English tools, Windows, and anything needing a sales call to price.
- _Steered:_ the user asked for a direct deep dive, so scoping questions and the idea-gate checkpoint were skipped. The defaults taken were all six categories and a quirky-grounded lens.

## Findings

### Theme: quirky's numbers decide more than the vendor list does

Past about 32 parallel workers, more machines stop helping, because the slowest file sets a floor of about 3.6 minutes. That comes from the median duration per file in the OVH log: 946 files and 119 minutes of serial time, which matches the roughly 2 hours the suite took when it fell back to running one file at a time on the Mac.

| Parallel workers | Ideal wall time | Size at today's 2 vCPU per worker |
|---|---|---|
| 4 | 29.8 min | 8 vCPU (the OVH box) |
| 8 | 14.9 min | 16 vCPU |
| 16 | 7.4 min | 32 vCPU |
| 32 | 3.7 min | 64 vCPU |
| 64+ | 3.6 min | no further gain |

Treat these as a lower bound. They assume perfect slowest-first scheduling and no setup time, and the log includes some files that no longer exist (the repo has 929 today). The Cloud Run trial shows the gap: 40 workers took about 10 minutes end to end against a modelled 3.6. How much of that gap is startup and how much is task splitting wasn't measured.

The time is concentrated. The 50 slowest files take 54% of it and the slowest 10 take 20%, while the median file takes 1.2 seconds. The slowest is `plugins/quirky.vault/test/window-parity.test.ts` at 214 seconds.

Cost per run is small almost everywhere, so it probably won't separate the options unless run volume is very high. For scale, a c3-16 left on for a month is about $157 (730 hours at list price), which equals about 490 Cloud Run runs at $0.32.

| Option at about 32 vCPU (except Cloud Run) | Per run, ideal 7.4 min | Billing catch |
|---|---|---|
| Cloud Run Jobs, 40 × 2 vCPU / 4 GiB | about $0.32, measured at about 10 min | computed from list prices, not an invoice |
| Ubicloud, 4 × standard-8 | about $0.12 | per minute; size listed by vCPU only |
| Northflank, 4 × 8 vCPU / 16 GB | about $0.13 | per-second billing not confirmed |
| Fly Machines, 4 × performance-8x | about $0.18 | lifetime and limits unverified |
| Morph, 4 × 8 MCU | about $0.20 | isolation tech unverified |
| Vercel Sandbox, 4 × 8 vCPU / 16 GB | $0.22 to $0.67 | depends on CPU use; Pro's size cap is exactly this |
| Modal Sandbox, equivalent | about $0.47 | gVisor by default, 3× container rate |
| Runloop, equivalent | about $0.63 | maximum size unpublished |
| OVH c3-64, one 32-vCore VM | $0.11 to $0.86 | rounding rule not found |
| Hetzner, 4 × CCX33 | €0.89 | [rounds up to a full hour](https://docs.hetzner.com/cloud/billing/faq/) and bills while powered off |

These are my arithmetic from the list rates in the census below, leaving out setup time, storage and egress.

### Theme: three of the six categories don't fit a test suite

PR preview platforms and Kubernetes isolation exist to give a deployed web service its own copy. Quirky's suite spawns PTYs, daemons and git processes inside one machine, so these categories would add a cluster or platform without removing the actual constraint. Testcontainers-style dependencies solve a different problem: no package manifest here depends on Testcontainers, LocalStack, Compose or Postgres, and the repo has no Dockerfile.

Those three censuses are at the end of this doc because they answer the general question and would matter if quirky ever hosts a service.

### Theme: API sandboxes are plentiful, but the evidence is thin and vendor-heavy

The sandbox field fits the "burst and pay for one run" shape, but nearly all the numbers are vendor claims. The only independent timing found is [one August 2026 time-to-interactive run](https://www.superagent.sh/blog/ai-code-sandbox-benchmark-2026), and no vendor publishes PTY or process-tree limits, which is the thing quirky stresses most.

| Name | Isolation | Max size | Lifetime | Snapshot | $/hr 8c/16G | Source |
|---|---|---|---|---|---|---|
| E2B | Firecracker (secondary source) | 8 vCPU / 8 GiB | 24 h on Pro | yes; drops PTY connections | $0.53 at the 8 GiB cap | [pricing](https://e2b.dev/pricing) |
| Daytona | disputed | unstated | unstated | yes | $0.66 | [pricing](https://www.daytona.io/pricing) |
| Modal Sandbox | gVisor; VM runtime allowlisted | unstated | 24 h | filesystem, on VM runtime | $0.95 | [pricing](https://modal.com/pricing) |
| Vercel Sandbox | Firecracker | Pro 8 / 16; Enterprise 32 / 64 | 24 h on Pro | filesystem, plus fork | $0.44 to $1.36 | [pricing](https://vercel.com/docs/vercel-sandbox/pricing) |
| Fly Machines | unverified | performance-8x, 16 GB | none found | unverified | $0.367 | [pricing](https://fly.io/pricing.md) |
| Fly Sprites | hardware VM (vendor claim) | unstated | idle-based | disk checkpoint | up to $0.66 | [page](https://fly.io/sprites) |
| Morph Cloud | unverified | 64 vCPU / 256 GB | unstated | yes | $0.40 | [pricing](https://cloud.morph.so/pricing) |
| Runloop | unverified | unpublished | unstated | yes | $1.27 | [pricing](https://www.runloop.ai/pricing) |
| Blaxel | unverified | up to 256 GB | days | standby snapshot | $0.66, RAM-only billing | [pricing](https://blaxel.ai/pricing) |
| exe.dev | KVM | 16 vCPU / 32 GiB on Personal | none found | unverified | $0.42 | [pricing](https://exe.dev/docs/pricing) |
| Northflank | microVM and gVisor | 32 vCPU / 488 GB | unstated | unverified | $0.27 | [pricing](https://northflank.com/pricing) |
| Freestyle | unverified | Hobby 8 / 16; Pro 32 / 64 | unstated | yes | $0.53 | [pricing](https://www.freestyle.sh/pricing) |
| Cloudflare Containers | unverified | 4 vCPU / 12 GiB | unstated | none found | not offered at this size | [pricing](https://developers.cloudflare.com/containers/pricing/) |
| OVH c3-16 | VM | 8 vCores; c3-64 has 32, and c3-320 is the largest listed | none | image | $0.2154 | [prices](https://us.ovhcloud.com/public-cloud/prices) |
| Hetzner CCX33 | VM | 8 vCPU / 32 GB | none | snapshot | €0.2227 | [pricing](https://www.hetzner.com/cloud/general-purpose/) |
| Ubicloud standard-8 | VM | 8 vCPU | none | unverified | about $0.25 | [pricing](https://www.ubicloud.com/docs/about/pricing) |

Three behaviours matter most for a suite like this:

- gVisor isn't a real Linux kernel, and [Modal's default runtime doesn't preserve setuid bits faithfully](https://modal.com/docs/guide/vm-sandboxes). A process-heavy suite is a plausible worst case, but no benchmark confirms it.
- A filesystem snapshot is all that skipping `bun install` needs. Memory forks bring [shared RNG state and `boot_id`](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/random-for-clones.md), which is an avoidable risk here.
- Burst limits are real: [Vercel Pro starts at 150 vCPU per minute](https://vercel.com/docs/sandbox/pricing) and [Sprites creates 10 per minute on pay-as-you-go](https://fly.io/sprites). One Sprites user reported [a bill over $200 for RAM on mostly idle instances](https://community.fly.io/t/my-sprites-bill-ended-up-much-larger-than-i-expected/28416), later refunded.

Self-hosted building blocks are healthy. Firecracker, Kata, gVisor, Incus, Lima and Sysbox are Apache-2.0 and active. Weave Ignite is archived. The OVH box exposes `/dev/kvm`, so any of the KVM-based ones could run there.

### Theme: GitHub Actions already runs the whole suite for free in PR #77

Open PR #77 (`zpyoung/optimize-tests`) has a `Tests` workflow that runs all 940 files on six Linux shards plus a macOS job, in about 12 minutes. Linux shards took 6 to 8 minutes and the macOS job about 11. Each job gets a fresh VM, and [standard runners are free in public repositories](https://docs.github.com/en/billing/concepts/product-billing/github-actions) at [4 vCPU / 16 GB for Linux and 3 vCPU / 7 GB for macOS](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

GitHub Pro [allows 40 concurrent standard jobs, 5 of them macOS](https://docs.github.com/en/actions/reference/limits). If the repo went private, Linux drops to 2 vCPU / 8 GB and macOS bills at $0.062 per minute against $18 of included usage, which I estimate at roughly $1 per full run.

The PR reports 8 failures in 5 files that happen only on GitHub, cause unknown. Runs also need pushed code, while `scripts/suite.ts` copies the uncommitted working tree.

### Theme: Cloud Run Jobs has a measured result but costs money

Two full runs of commit 50dd0f72 at 40 tasks took about 10 minutes and about $0.32 each. Only `plugins/quirky.worktree/test/remote-create.test.ts` failed because of Cloud Run, since its containers have only link-local and `fddf:` addresses. Sixteen other files failed on OVH too, so they say nothing about Cloud Run.

It isn't wired into `scripts/suite.ts`. Running it automatically as overflow would break the spec's rule that nothing spends cloud money unless the developer chooses it. Source: the 2026-10-30 trial notes.

### Theme: ephemeral CI runners are cheap and churning

Fresh-VM runners at 4 vCPU now list at a third to two thirds of GitHub's hosted price, but two vendors have left this market in the last year. [Cirrus Labs is joining OpenAI](https://cirruslabs.org/), closed Cirrus Runners to new customers, and shut Cirrus CI on 2026-06-01. [BuildJet closed](https://www.warpbuild.com/blog/buildjet-shutting-down) (vendor post only). GitHub [postponed its $0.002 per minute self-hosted charge](https://github.blog/changelog/2025-12-16-coming-soon-simpler-pricing-and-a-better-experience-for-github-actions/) with no new date.

| Name | $/min 4 vCPU Linux | $/min macOS | Notes |
|---|---|---|---|
| [GitHub-hosted](https://docs.github.com/en/billing/reference/actions-runner-pricing) | 0.012 | 0.062 (M1), 0.102 (M2 Pro) | no nested virtualization on arm64 |
| [Namespace](https://namespace.so/pricing) | 0.004 to 0.006 | 0.04 to 0.06 | |
| [WarpBuild](https://www.warpbuild.com/pricing) | 0.008 | 0.08 (M4 Pro) | bring-your-own-cloud at +0.002 |
| [Tenki](https://tenki.cloud/docs/runner-billing) | 0.008 | about 0.08 | |
| [Blacksmith](https://www.blacksmith.sh/pricing) | about 0.008 (inferred) | 0.08 | |
| [Buildkite hosted](https://buildkite.com/pricing/) | 0.016 | 0.12 | |
| [CircleCI](https://circleci.com/pricing/price-list/) | about 0.012 | about 0.12 | |
| [Ubicloud](https://www.ubicloud.com/use-cases/github-actions) | 0.0025 to 0.004 | none | open source |
| [RunsOn](https://runs-on.com/pricing/) | AWS spot cost plus €300 to €3,600 a year | not stated | AWS only |
| [Actuated](https://actuated.com/pricing) | $150 per server per month | none | liveness unverified |

`bun test` has native sharding. Bun 1.4.0, the version quirky pins, accepts `--shard=M/N` and `--timings` for balancing by duration (checked with `bun test --help`). `scripts/suite.ts` already runs slowest-first per file, so the flag is only useful for splitting across machines, and its retry and slot logic wouldn't come along.

### Theme: ephemeral macOS is limited by Apple's licence more than by tools

Only 18 test files are pinned to the Mac, and 11 of those reasons mention Chrome. Six say outright that the Linux host has no Chrome or Chromium, so some of the pinned set may be an install away from moving, though others need macOS cookie formats. The rest need real macOS behaviour such as `plutil`, descriptor identity, or the `open` flow.

The [macOS Tahoe licence](https://www.apple.com/legal/sla/docs/macOSTahoe.pdf) allows "up to two (2) additional copies or instances" per Apple computer you own or control, and CI leases must run "a minimum period of twenty-four (24) consecutive hours". That is why EC2 Mac has a 24-hour minimum. How per-minute macOS vendors comply wasn't stated on any page read.

| Name | Ephemeral how | Minimum | $/hr | Catch |
|---|---|---|---|---|
| [Tart](https://github.com/openai/tart) | clone and destroy on your Macs | none | your hardware | FSL-1.1-ALv2 under OpenAI; [relicense promised](https://cirruslabs.org/), not yet in the LICENSE file |
| Per-minute runners (Namespace, Blacksmith, WarpBuild, Tenki) | vendor VM per job | per minute | $2.40 to $4.80 | compliance not explained |
| [GitHub macOS](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) | VM per job | per minute | $3.72 to $6.12 | |
| [EC2 Mac](https://aws.amazon.com/ec2/instance-types/mac/) | whole host | 24 h | about $1.23 to $1.56, third-party figure | |
| [Scaleway](https://www.scaleway.com/en/pricing/apple-silicon/) | dedicated Mac mini | 24 h, unverified | €0.22 to €0.49, snippet only | page blocked |
| [Orka](https://www.macstadium.com/orka) | VM per job | not stated | not listed | two VMs per node |
| [Lume](https://github.com/trycua/cua/blob/main/libs/lume/README.md) | Virtualization.framework | n/a | n/a | licence not verified |

Reddit's Tart evidence is thin and mixed. One admin wrote ["Tried Tart, tried Anka, tried VMware. Bought a bunch of Mac minis and went physical instead."](https://reddit.com/r/macsysadmin/comments/1qbl2xk) (2026-01), and [another user](https://reddit.com/r/macsysadmin/comments/1rt84sj) (2026-03) hit a Packer build problem after Apple changed the setup flow. A reported "game changer" comment and a 60 GB Tahoe image size couldn't be found when I re-read those threads, so I've left them out. No source confirmed how WebKit or native windows behave in a Tahoe VM.

### Theme: Reddit's experience is about operations, not vendors

Real users talk about cleanup, data, and build time far more than about any product. Dates below are thread dates.

- Teardown is the common failure. One reply warns of ending up with ["a pile of orphan environments"](https://reddit.com/r/devops/comments/1rn2r60) (2026-03), and another team runs a sweeper because environments ["fail to destroy post-merge"](https://reddit.com/r/devops/comments/1wm3y35) (2026-09).
- Compute often isn't the slow part. In that same thread, a 35 to 40 minute environment is mostly Java build and sequential Terraform.
- Data and secrets are harder than machines. One consultant's customer has ["almost a hundred secrets"](https://reddit.com/r/devops/comments/1tgsjel) (2026-05) to handle per environment.
- Teams often build their own, and a label-triggered Argo CD ApplicationSet was the top answer in that May thread. Half-finished internal efforts are the common failure ([example](https://reddit.com/r/devops/comments/1ixgkic), 2025-02).
- Sceptics are real: ["It easy enough to do docker compose up in cicd pipelines"](https://reddit.com/r/devops/comments/1p2eu8w) (2025-11).
- For runners, [one thread](https://reddit.com/r/devops/comments/1kjypf8) (2025-05) praises RunsOn at about 20 seconds of overhead and Namespace as the "fastest runner I've tried", though the vendors' own staff post there too.
- Vendor staff dominate. Founders or employees of Signadot, Qovery, mirrord, Okteto, Shipyard, Bunnyshell, WarpBuild and RunsOn all post in these threads. Signadot, Qovery and Okteto had no genuine positive user report in what was read.

### Idea landscape

These are shapes the evidence opens up for quirky. None is ranked.

#### Direction: start and stop one large VM per run

Boot a machine sized for the run, rsync as today, and delete or stop it afterwards. The gcloud `quirky-test` VM already exists and is stopped.
*why this might actually work:* `scripts/suite.ts` already speaks SSH and rsync, and hourly rounding stops mattering when one 32-vCore VM replaces four small ones.
*surfaced by:* first principles  ·  *sits at intensity:* Grounded

#### Direction: fan out on Cloud Run Jobs by explicit choice

Offer the trial's job as a flag a developer chooses, leaving OVH as the default.
*why this might actually work:* it has a measured quirky result, it can test unpushed work if built from the working tree, and the explicit choice satisfies the cloud-money rule.
*surfaced by:* research  ·  *sits at intensity:* Grounded

#### Direction: GitHub Actions for pushed code, a host for unpushed code

Land PR #77's workflow for PRs and `main`, and keep rsync-to-host for runs before a push.
*why this might actually work:* the runners are free while the repo is public, and only the pre-push case needs anything else.
*surfaced by:* user question  ·  *sits at intensity:* Grounded

#### Direction: burst to per-second VMs from a prepared snapshot

Keep a snapshot with dependencies installed and create N real-kernel VMs for one run.
*why this might actually work:* the cost table sits under about $0.25 for several vendors, and filesystem snapshots are the one snapshot type without clone hazards.
*surfaced by:* research  ·  *sits at intensity:* Exploratory

#### Direction: put each run in a throwaway microVM on the existing OVH box

Use the box's `/dev/kvm` with Firecracker or Incus so concurrent runs can't share processes or files.
*why this might actually work:* this adds isolation rather than capacity, and orphaned pty-host processes had to be killed repeatedly during the build loop.
*surfaced by:* assumption reversal ("ephemeral means new hardware")  ·  *sits at intensity:* Exploratory

#### Direction: shrink the suite instead of buying machines

Target the 50 files that take 54% of the time, and split the slowest ones.
*why this might actually work:* the 3.6-minute floor is one file's runtime, so past 32 workers only faster files can help.
*surfaced by:* first principles  ·  *sits at intensity:* Grounded

#### Direction: shrink the Mac-pinned list, then give the rest a disposable VM

Install Chromium on the Linux host, re-test the pinned files, and run what remains in Tart clones on a Mac you own.
*why this might actually work:* Apple's licence permits two VMs on your own hardware with no 24-hour minimum, and the remaining set may be small.
*surfaced by:* assumption reversal ("Mac tests need a Mac in the cloud")  ·  *sits at intensity:* Exploratory

#### Direction: one disposable machine per agent lane

Give each build-loop lane its own short-lived VM instead of having lanes compete for host slots.
*why this might actually work:* agent-driven PR volume is showing up as a driver elsewhere ([10 to 15 PRs at once in one account](https://reddit.com/r/selfhosted/comments/1sb7i7i), 2026-04), and the land lock already exists because lanes contend for the host.
*surfaced by:* analogy to per-PR environments  ·  *sits at intensity:* Exploratory

## Tensions & trade-offs

- Hourly rounding favours one big machine per run, while per-second billing favours many small ones, so the billing model partly decides the architecture.
- Hosted sandboxes need the least infrastructure work, but the same market produced Daytona's closure, Cirrus's exit and BuildJet's shutdown. Plain VMs from a commodity provider are duller and easier to replace.
- Isolation pulls toward containers and sandboxes, while fidelity pulls toward real kernels. Cloud Run's networking already failed one test, and gVisor could fail more.
- Automatic overflow is what the 2-hour fallback incident argues for, but the spec says cloud spending must be a developer's choice.
- Faster feedback from more machines competes with the 16 files that already fail on both hosts. Parallelism doesn't help them, and load-related flakes could get harder to reproduce on a different machine each run.

## Challenge notes

- **One large VM per run**: steelman: the smallest change to working code. Strongest counter: boot, rsync and install time run on every invocation, and the cost of a forgotten VM is unbounded without a sweeper, which Reddit says is where teams get hurt. Disproven if setup takes minutes rather than seconds, or if runs are frequent enough that a warm host costs less.
- **GitHub Actions**: steelman: free, disposable, and already working in PR #77. Strongest counter: it can't test unpushed work, its logs are public on a public repo, and 8 GitHub-only failures are unexplained. Disproven if those failures turn out to be runner limits that can't be worked around, or if most runs happen before a push.
- **Cloud Run Jobs**: steelman: already proven on the real suite. Strongest counter: 10 minutes against a modelled 3.6 suggests overhead that nobody has broken down yet, and link-local networking is a fidelity gap that may widen. Disproven if more tests turn out to depend on real network interfaces.
- **Per-second burst**: steelman: cheapest on paper and closest to "pay for one run". Strongest counter: no vendor documents PTY limits and almost all numbers are vendor claims. Disproven by a real run that shows new failures or a burst-limit stall.
- **MicroVMs on OVH**: steelman: fixes leaks without new spend. Strongest counter: Firecracker's snapshots are still [developer preview](https://github.com/firecracker-microvm/firecracker/blob/master/docs/snapshotting/snapshot-support.md), it adds no capacity, and systemd scopes or containers may contain leaks far more cheaply. Disproven if a process-group or cgroup cleanup solves the orphans.
- **Shrink the suite**: steelman: helps every host, including the Mac. Strongest counter: e2e tests are often slow because they exercise real behaviour, so splitting them may only move time around. Disproven if the slowest files turn out to spend their time in necessary real-app startup.
- **Shrink the Mac list**: steelman: removes a local bottleneck from each run. Strongest counter: several pinned files test macOS cookie formats or macOS Chrome specifically, so passing on Linux Chromium could drop coverage rather than move it. Disproven if a re-run shows they need macOS anyway.
- **One machine per lane**: steelman: it removes slot contention as a concept. Strongest counter: the build loop finished on 2026-10-29 and that busy period may not recur, so the need is unproven today. Disproven if run volume stays low enough that one warm box never queues.

## Open questions & gaps

- How many suite runs a month happen outside the build loop? That volume decides whether any cost difference matters.
- What did the 10-minute Cloud Run run spend its time on: startup, install, or uneven task splitting?
- Do vendor sandboxes survive quirky's PTY and process load? No source answers this, so only a trial would.
- Which of the Chrome-citing pinned files pass on Linux with Chromium installed?
- Is OVH hourly billing rounded up? The pricing page doesn't say, and an earlier claim that it does couldn't be confirmed.
- How do per-minute macOS vendors comply with the 24-hour lease rule? Has the Tart relicense shipped anywhere beyond the announcement?
- Coverage limits: Release, Humanitec, Anka, Earthly's replacement, Beam, Replit and Actions Runner Controller weren't verified. Reddit coverage was 123 of 504 planned subreddit-and-query pairs, focused on the likely ones, and non-English sources weren't searched. Thin Reddit results may reflect the archive and query plan rather than a lack of discussion.
- One survey agent reported that the PlanetScale pricing page appeared to show plaintext database credentials. It didn't use them, and this may be sample content. I didn't check it.

## Sources

Re-checked at the source on 2026-10-30: Bun flags (`bun test --help` on 1.4.0), repo state through the GitHub API (Tart, Daytona, MinIO, LocalStack, vCluster, Uffizzi, Firecracker), [Tart's LICENSE](https://raw.githubusercontent.com/openai/tart/main/LICENSE), [Cirrus Labs' post](https://cirruslabs.org/), [GitHub's changelog](https://github.blog/changelog/2025-12-16-coming-soon-simpler-pricing-and-a-better-experience-for-github-actions/), the [Apple licence](https://www.apple.com/legal/sla/docs/macOSTahoe.pdf), OVH and Hetzner pricing, Hetzner's billing FAQ, and the direct Reddit quotes above. Other rows come from survey agents reading the linked pages and weren't independently repeated.

Local evidence: `~/test-slots/durations.log` on the OVH box, `scripts/suite.ts`, `scripts/test-on-macos.txt`, and the 2026-10-30 Cloud Run trial notes.

### Census: PR preview platforms

Mostly alive, and mostly aimed at web services.

| Name | Target | Licence | Price | Status |
|---|---|---|---|---|
| [Qovery](https://www.qovery.com/pricing) | your cloud or K8s | engine GPL-3.0 | from $299/mo | active |
| [Bunnyshell](https://www.bunnyshell.com/pricing/) | theirs or your cloud | CLI MIT, platform proprietary | $0.007/min per environment | active |
| [Okteto](https://okteto.com/pricing) | Okteto Cloud or your K8s | Apache-2.0 | free to 5 users, then quote | active |
| [Northflank](https://northflank.com/pricing) | theirs or BYOC | proprietary | $0.01667/vCPU-hr | active; preview gating not stated |
| [Render](https://render.com/docs/preview-environments) | Render | proprietary | Pro workspace needed | active |
| [Railway](https://docs.railway.com/guides/environments) | Railway | proprietary | from $5/mo | active |
| [Heroku Review Apps](https://devcenter.heroku.com/articles/github-integration-review-apps) | Heroku | proprietary | per second | docs updated 2026-10-19 |
| [Coolify](https://coolify.io/docs/applications/deployments/preview-deployments) | your server | Apache-2.0 | free to self-host | v4.5.3, 2026-10-28 |
| [Dokploy](https://docs.dokploy.com/docs/core/applications/preview-deployments) | your server | Apache-2.0 core | free to self-host | v0.30.10, 2026-10-22 |
| [Porter](https://porter.run/pricing) | your cloud | not verified | $13/vCPU/mo + $6/GB/mo | active |
| [Shipyard](https://www.prnewswire.com/news-releases/shipyard-joins-stackgen-adding-ephemeral-environments-to-the-autonomous-operations-factory-302892641.html) | Shipyard Cloud | proprietary | $500/mo for 3 environments | acquired by StackGen |
| [Lagoon](https://docs.lagoon.sh/concepts-advanced/workflows/) | your K8s | Apache-2.0 | free | v2.34.0, 2026-09-22 |
| [Upsun](https://developer.upsun.com/docs/integrations/source/github) | Upsun | proprietary | not checked | active |
| [PullPreview](https://raw.githubusercontent.com/pullpreview/action/main/LICENSE) | your Lightsail or Hetzner | Prosperity 3.0.0, not OSI | €300/yr per org | v6.2.1, 2026-09-10 |
| [env zero](https://www.envzero.com/pricing) | your cloud, Terraform | proprietary | free to 30 environments | rebranded from env0 |

Frontend-first or partial: Vercel, Netlify (unverified), Cloudflare Pages, Azure Static Web Apps, AWS Amplify, DigitalOcean App Platform, Fly.io's review-app action, Cloud Run tagged revisions.

Stale: [Uffizzi](https://github.com/UffizziCloud/uffizzi), last push 2024-08-07 and last release 2023-11-13. [Preevy](https://github.com/livecycle/preevy) last released 2025-06-30.

### Census: Kubernetes-native isolation

| Name | Model | Licence | Price | Latest release |
|---|---|---|---|---|
| [vCluster](https://www.vcluster.com/pricing) | virtual cluster | Apache-2.0 | OSS free; Free tier to 64 CPU | v0.37.5, 2026-10-29 |
| [Signadot](https://www.signadot.com/pricing/) | request routing | CLI Apache-2.0, platform not found | free to 50 sandboxes/mo; $250/mo Business | CLI v1.9.1 |
| [mirrord](https://metalbear.com/mirrord/pricing/) | local process routed into cluster | MIT | free; Team $50/seat/mo | 3.282.0, 2026-10-30 |
| [Garden](https://garden.io/plans) | namespace | MPL-2.0 | not retrieved | 0.14.20, 2026-02-27 |
| [Telepresence](https://github.com/telepresenceio/telepresence/releases/tag/v2.32.3) | intercept | Apache-2.0 | not checked | v2.32.3, 2026-10-21 |
| [Kamaji](https://github.com/clastix/kamaji) | hosted control planes | Apache-2.0 | free | 26.10.5-edge |
| [Capsule](https://github.com/projectcapsule/capsule) | namespace tenancy | Apache-2.0 | free | v0.15.2, 2026-10-26 |
| [kind](https://github.com/kubernetes-sigs/kind) / [k3d](https://github.com/k3d-io/k3d) | cluster in Docker | Apache-2.0 / MIT | free | v0.33.0 / v5.9.0 |
| [Argo CD ApplicationSet](https://argo-cd.readthedocs.io/en/stable/operator-manual/applicationset/Generators-Pull-Request/) | one app per PR | Apache-2.0 | free | v3.5.6, 2026-10-20 |

Real-team lessons: [Uber's SLATE](https://www.uber.com/us/en/blog/simplifying-developer-testing-through-slate/) found async work loses routing keys and test traffic can fall through to production. [Uber's later post](https://www.uber.com/us/en/blog/shifting-e2e-testing-left/) describes a Kafka consumer proxy for this. No primary source gave a startup time for any of these tools.

### Census: throwaway test dependencies and environment definitions

The licence and shutdown changes are the useful part here:

- [LocalStack](https://blog.localstack.cloud/2026-upcoming-pricing-changes/): community repo archived 2026-03-23, image needs an auth token, free tier is non-commercial.
- [Daytona](https://www.daytona.io/dotfiles/updates/daytona-is-going-closed-source): core development went private in June 2026 and the public repo is archived. Community fork: [Nightona](https://github.com/nightona-co/nightona).
- [MinIO](https://github.com/minio/minio): repo archived, no official binaries now.
- [Earthly](https://earthly.dev/blog/shutting-down-earthfiles-cloud/): cloud ended 2025-07-16 and open-source development stopped.
- [Gitpod became Ona](https://www.theregister.com/2025/09/03/gitpod_rebrands_as_ona/), and OpenAI [agreed to buy it](https://www.infoworld.com/article/4184648/openai-buys-ona-to-help-rein-in-ai-agents.html) (close not confirmed).
- [Turso is joining Supabase](https://turso.tech/pricing). [Neon went to Databricks](https://neon.com/pricing).
- [DevPod](https://github.com/loft-sh/devpod) upstream has stalled, last release 2025-03-10.

Still active as of this snapshot: Testcontainers (MIT), Docker Compose, Moto, Dagger, Database Lab Engine (now Apache-2.0), Nix, devenv, Flox, Devbox, Coder, and Codespaces. Reddit's view of Testcontainers is the warmest of any tool here, with six or more independent mentions such as [this thread](https://reddit.com/r/ExperiencedDevs/comments/1czwr29) (2024-05), though not for full end-to-end environments.

---
*Exploration only. To build a direction: invoke `quirk:brainstorming` → an execution skill (which authors a tech spec when warranted, then plans in context).*
