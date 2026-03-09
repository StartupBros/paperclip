---
title: "Open Source Contribution Strategy with Customized Fork"
category: integration-issues
tags: [git, open-source, fork-management, pr-strategy, contribution]
module: all
severity: critical
date_resolved: 2026-03-09
symptoms:
  - PRs with 300+ file changes not getting reviewed
  - Greptile bot rejecting PRs (100 file limit)
  - Snyk security errors blocking merges
  - PRs closed without merge despite positive maintainer feedback
  - Only 1 of 11 PRs merged
---

# Open Source Contribution Strategy with Customized Fork

## The Problem

We're contributing to **paperclipai/paperclip** (open source) while maintaining a heavily
customized fork at **StartupBros/paperclip** for local use. Our contribution record:

| Metric | Value | Problem |
|--------|-------|---------|
| Total PRs opened | 11 | — |
| PRs merged | **0** | **0% merge rate** |
| PRs closed unmerged | 4 | Snyk errors, too large |
| PRs still open | 7 | Stale, no reviewer activity |
| Average files changed | 200+ | Greptile can't review (100 file limit) |

Meanwhile, **mvanhorn** merged **9 PRs in 2 days** — all small, focused, < 10 files each.

### Root Cause

Every feature branch is based on `feat/plugin-agent-routines`, which includes the
entire plugin SDK + all examples. So each PR carries 300+ files of diff even when the
actual new work is 5-10 files. This triggers:

1. Greptile bot: "Too many files changed (307 files found, 100 file limit)" — no automated review
2. Snyk security scanner: errors on the massive diff — blocks merge
3. `pr-policy.yml`: fails if `pnpm-lock.yaml` is included
4. Human reviewers: won't review a 300-file PR for a 5-file plugin

## The Strategy

### Principle: Two Trees, One Garden

```
UPSTREAM (paperclipai/paperclip)          FORK (StartupBros/paperclip)
──────────────────────────────            ──────────────────────────────
Small, focused PRs that merge fast   ←→   Integration branch with everything
Each PR tells one clear story              merged together for local use
Target: top 1% contributor                 Target: production-ready local env
```

### 1. Upstream PR Strategy — "One PR, One Story"

**The rule: Each PR to upstream contains ONLY its own files.**

Do NOT base feature branches on other unmerged feature branches. Instead:

```bash
# WRONG: Stacking on unmerged work (300+ files)
git checkout feat/plugin-agent-routines
git checkout -b feat/circuit-breaker-plugin
# This carries the entire SDK + all plugins in the diff

# RIGHT: Branch from upstream, add ONLY your files
git checkout upstream/master
git checkout -b feat/circuit-breaker-plugin
# Copy or cherry-pick ONLY the circuit breaker files
# PR shows 8 files changed — reviewable, mergeable
```

**PR sizing targets:**

| PR Size | Files | Merge Likelihood | Example |
|---------|-------|-----------------|---------|
| Small | < 10 | High | Single plugin example |
| Medium | 10-30 | Medium | SDK capability addition |
| Large | 30-100 | Low | Core SDK engine |
| Mega | 100+ | Near zero | Never do this |

**PR dependency chain (declare, don't carry):**

```
PR description:
> Depends on #396 (Plugin SDK). This PR targets `master` and includes
> only the circuit breaker plugin files. Once #396 merges, this PR
> will have all required dependencies.
```

Don't include the dependency's code in your PR. Declare it. Maintainers understand
dependency chains and will merge in order.

### 2. Fork Integration Strategy — "develop" Branch

The fork's `develop` branch merges ALL features together for local use:

```bash
# Create integration branch
git checkout upstream/master
git checkout -b develop

# Merge each feature (not rebase — preserve PR-ability)
git merge feat/plugin-sdk              # Core SDK
git merge feat/plugin-sdk-agents-pause # Capabilities
git merge feat/notification-plugins    # Webhook + Discord
git merge feat/circuit-breaker-plugin  # Circuit breaker
git merge feat/general-action-approvals # Approvals
git merge feat/agent-trust             # Trust levels
# ... etc

# Push to fork
git push origin develop
```

**Rebuild `develop` when upstream merges a PR:**

```bash
git fetch upstream
git checkout develop
git rebase upstream/master
# Re-merge any features not yet merged upstream
git merge feat/still-pending-feature
git push origin develop --force-with-lease
```

### 3. The Contribution Arc — "Earn Trust, Then Spend It"

**Phase 1: Quick wins (build credibility)**
- Bug fixes, typos, small improvements
- 1-5 files, merge in days
- Goal: 5-10 merged PRs, establish yourself as reliable

**Phase 2: Incremental features (demonstrate capability)**
- Small, self-contained features
- 5-15 files, clear before/after
- Goal: maintainers start recognizing your username

**Phase 3: Architecture contributions (leverage trust)**
- Larger changes discussed in Discord first
- Split into reviewable chunks
- Goal: become a collaborator/maintainer

**Our current position:** We jumped straight to Phase 3 without Phase 1.
The maintainer (gsxdsm) likes our work but can't merge 300-file PRs.

### 4. Upstream PR Checklist

Before opening any PR to upstream:

```
[ ] Branched from upstream/master (not another feature branch)
[ ] Contains ONLY the files for this feature
[ ] < 100 files changed (ideally < 30)
[ ] pnpm-lock.yaml is NOT included
[ ] No Snyk security vulnerabilities introduced
[ ] PR title: conventional format (feat/fix/chore)
[ ] PR description: summary, motivation, testing
[ ] Tests pass locally (pnpm typecheck && pnpm test:run && pnpm build)
[ ] If depends on unmerged PR: declared in description, not carried in diff
[ ] For big features: discussed in Discord #dev first
```

### 5. Immediate Action Plan

**Step 1: Fix the existing PRs**

The open PRs (#398, #399, #402, #407, #409) need to be rebased on `upstream/master`
with ONLY their own files. Close the ones that are too stale and re-open clean ones.

**Step 2: Coordinate with gsxdsm on #396**

gsxdsm said they want to:
- Split #396 into core engine + examples
- Pull #403 and #408 into the main SDK release
- Add streaming and chat capabilities

Offer to help with the split. This is the single highest-leverage action — it unblocks
everything else.

**Step 3: Land quick wins**

While waiting for #396, find 3-5 small bug fixes or improvements to merge. Build the
merge track record. Look at open issues labeled "good first issue" or "help wanted".

**Step 4: Queue the circuit breaker**

Once #396 merges, open the circuit breaker PR:
- 8 files only (6 src + package.json + tsconfig)
- References #390 and #391
- Shows off 8 SDK capabilities
- Comprehensive tests (26 passing)
- Clean, focused, reviewable

## Git Remote Setup Reference

```bash
# Standard three-remote setup
git remote -v
# upstream  https://github.com/paperclipai/paperclip.git  (official)
# origin    https://github.com/StartupBros/paperclip.git   (our fork)
# gsxdsm    https://github.com/gsxdsm/paperclip.git        (maintainer)

# Keep upstream current
git fetch upstream
git fetch origin

# Feature work: always branch from upstream/master
git checkout -b feat/my-feature upstream/master

# Integration: develop branch on fork
git checkout develop
git pull origin develop
```

## Branch Naming Convention

```
feat/<scope>-<description>     # New features
fix/<issue>-<description>      # Bug fixes
chore/<description>             # Maintenance
docs/<description>              # Documentation only
```

## What Gets Merged (Evidence-Based)

From analyzing the last 20 merged PRs on paperclipai/paperclip:

| Contributor | Merged PRs | Avg Files | Pattern |
|------------|-----------|-----------|---------|
| mvanhorn | 9 | 4 | Small server-side fixes |
| cryppadotta | 6 | 12 | Releases + 1 feature |
| JOHNadonis | 1 | 50 | i18n (discussed first) |
| online5880 | 1 | 4 | Windows fix |
| StartupBros | **0** | 200+ | All PRs too large or closed |

**The pattern is clear:** Small PRs merge. Large PRs languish or die.

## Prevention

- Never open a PR with > 100 files to upstream
- Never base a feature branch on another unmerged feature branch for upstream PRs
- Always check `git diff --stat upstream/master` before opening a PR
- Maintain `develop` branch on fork for integrated local use
- Coordinate large features in Discord before coding

## Cross-References

- [CONTRIBUTING.md](/CONTRIBUTING.md) — upstream contribution guide
- [AGENTS.md](/AGENTS.md) — development standards
- [doc/DEVELOPING.md](/doc/DEVELOPING.md) — lockfile policy, CI requirements
