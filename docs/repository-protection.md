# Repository protection baseline

AegisFlow treats CI and review controls as part of the release-safety boundary, not
as optional repository decoration.

## Required `main` protection

Configure a GitHub branch ruleset or branch-protection rule for `main` with these
minimum controls:

- require a pull request before merge;
- require the `ci / verify` status check to pass before merge;
- require branches to be up to date with `main` before merge when practical;
- block force pushes to `main`;
- block branch deletion;
- require conversation resolution before merge;
- apply the rule to repository administrators as well as ordinary collaborators;
- keep CODEOWNERS review routing enabled for durability/runtime-sensitive paths.

For a single-maintainer repository, a mandatory second-person approval may be
impractical. The non-negotiable control is that the verified CI gate cannot be
bypassed by a normal merge or direct push. If additional maintainers are added,
require at least one approving review and CODEOWNERS approval for protected paths.

## Required CI check

The current workflow is `.github/workflows/ci.yml`, job `verify`. It runs the
source/package verification gate, PostgreSQL migration/runtime tests, deterministic
failure and recovery scenarios, and the production dependency audit.

The branch rule should select the check GitHub exposes for that job (normally
`ci / verify`). Do not replace it with a weaker subset of the workflow.

## Verification after configuration

After enabling the rule:

1. Confirm GitHub reports `main` as protected or covered by an active ruleset.
2. Open a disposable pull request with a deliberately failing test and confirm merge
   is blocked while `ci / verify` is red.
3. Restore the test, confirm CI becomes green, and confirm the merge gate clears.
4. Verify a force push and branch deletion are rejected for `main`.
5. Re-check the rule whenever the workflow/job name changes, because required-check
   bindings can become stale after CI renames.

## Current automation boundary

Repository source changes can add CODEOWNERS and document the required protection,
but branch/ruleset enforcement is a GitHub repository setting. It must be enabled
through an account or integration with repository-administration permission; it
cannot be made authoritative by committed source files alone.
