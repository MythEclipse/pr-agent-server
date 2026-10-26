## [1.5.8](https://github.com/asepharyana/pr-agent-server/compare/v1.5.7...v1.5.8) (2026-10-26)


### Bug Fixes

* **queue:** score the CURRENT review, and stop losing re-requests ([3d8ece9](https://github.com/asepharyana/pr-agent-server/commit/3d8ece920dd20697551976d42c622c93965a38da)), closes [hub#61](https://github.com/hub/issues/61)

## [1.5.7](https://github.com/asepharyana/pr-agent-server/compare/v1.5.6...v1.5.7) (2026-10-26)


### Bug Fixes

* auto-fix code quality ([fca53a2](https://github.com/asepharyana/pr-agent-server/commit/fca53a2ba75db1b13970f2e237f9c3a4277f4791))
* **deps:** move @moonrepo/cli to 2.6.4 — 2.6.3 never shipped its platform binaries ([0727f91](https://github.com/asepharyana/pr-agent-server/commit/0727f913c5a5ca06aa1e6fd130da665f2c4e805b))

## [1.5.6](https://github.com/asepharyana/pr-agent-server/compare/v1.5.5...v1.5.6) (2026-10-26)

### Bug Fixes

- **worker:** stop pinning a timeout, and refuse a bump that cannot install ([89b2338](https://github.com/asepharyana/pr-agent-server/commit/89b2338a5d844644df77cdbc8a1cb82a3c323fb2)), closes [hub#61](https://github.com/hub/issues/61)

## [1.5.5](https://github.com/asepharyana/pr-agent-server/compare/v1.5.4...v1.5.5) (2026-10-21)

### Bug Fixes

- **review:** collapse newlines inside rendered issue fields ([8cdfeb7](https://github.com/asepharyana/pr-agent-server/commit/8cdfeb70d64220660e60660f94f1d8c052d8c935))

## [1.5.4](https://github.com/asepharyana/pr-agent-server/compare/v1.5.3...v1.5.4) (2026-10-21)

### Bug Fixes

- **review:** stop publishing reviews that say nothing, and stop attributing them to a model that never ran ([b8fed30](https://github.com/asepharyana/pr-agent-server/commit/b8fed30e0b62bf6d4fcc38bdb7b79f7c6c470ef7))

## [1.5.3](https://github.com/asepharyana/pr-agent-server/compare/v1.5.2...v1.5.3) (2026-10-21)

### Bug Fixes

- auto-fix code quality ([69af158](https://github.com/asepharyana/pr-agent-server/commit/69af1583102dda97abbe1599746fd776bf089d8a))
- auto-fix code quality ([7f843c9](https://github.com/asepharyana/pr-agent-server/commit/7f843c9bb0a976b623eb2b5531a7be02129d4de8))
- auto-fix code quality ([4f89596](https://github.com/asepharyana/pr-agent-server/commit/4f89596c3bbf0308e0add5ac957972ca79ca335f))

## [1.5.2](https://github.com/asepharyana/pr-agent-server/compare/v1.5.1...v1.5.2) (2026-10-21)

### Bug Fixes

- auto-fix code quality [skip ci] ([fc3a670](https://github.com/asepharyana/pr-agent-server/commit/fc3a67043fc9c6878fa3ba08952f9f9e8efc1db8))
- **worker:** a green verdict requires a real suite, and the fix commit must run CI ([331a1f0](https://github.com/asepharyana/pr-agent-server/commit/331a1f0da9c40cf30f9adf0f62423d82eaa10b2f)), closes [#19](https://github.com/asepharyana/pr-agent-server/issues/19) [#19](https://github.com/asepharyana/pr-agent-server/issues/19)

## [1.5.1](https://github.com/asepharyana/pr-agent-server/compare/v1.5.0...v1.5.1) (2026-10-21)

### Bug Fixes

- auto-fix code quality [skip ci] ([5b7004d](https://github.com/asepharyana/pr-agent-server/commit/5b7004dc439645e62b512e870ff22bf890a5a0cc))

# [1.5.0](https://github.com/asepharyana/pr-agent-server/compare/v1.4.4...v1.5.0) (2026-10-21)

### Features

- **worker:** fix until CI is green, with the real failure in the prompt ([d8f8de1](https://github.com/asepharyana/pr-agent-server/commit/d8f8de1d9f1d28df934daade41c49f48dd675351)), closes [mcpedia#28](https://github.com/mcpedia/issues/28) [mcpedia#28](https://github.com/mcpedia/issues/28)

## [1.4.4](https://github.com/asepharyana/pr-agent-server/compare/v1.4.3...v1.4.4) (2026-10-21)

### Bug Fixes

- **web:** explain the empty review history instead of guessing ([2d0e72a](https://github.com/asepharyana/pr-agent-server/commit/2d0e72a30b8bd142f7e753c13cadab0d39b3d9bd))

## [1.4.3](https://github.com/asepharyana/pr-agent-server/compare/v1.4.2...v1.4.3) (2026-10-21)

### Bug Fixes

- **auth:** new sign-ins are admins, so Google login reaches a usable dashboard ([ecb905b](https://github.com/asepharyana/pr-agent-server/commit/ecb905b5cfba93d1b7fc07c3ca29c6496508ab78))

## [1.4.2](https://github.com/asepharyana/pr-agent-server/compare/v1.4.1...v1.4.2) (2026-10-21)

### Bug Fixes

- **auth:** stop the allowlist locking the admin out of their own dashboard ([e93aa65](https://github.com/asepharyana/pr-agent-server/commit/e93aa65fa7ce3e00817b8cd751625d22eb24dee1))

## [1.4.1](https://github.com/asepharyana/pr-agent-server/compare/v1.4.0...v1.4.1) (2026-10-21)

### Bug Fixes

- **web:** show why a Google sign-in failed instead of a blank form ([1ad092a](https://github.com/asepharyana/pr-agent-server/commit/1ad092a0da8637ffc40683d896dab293d990aeb1))

# [1.4.0](https://github.com/asepharyana/pr-agent-server/compare/v1.3.2...v1.4.0) (2026-10-21)

### Features

- **auth:** Google sign-in, gated by an email allowlist ([72dc68b](https://github.com/asepharyana/pr-agent-server/commit/72dc68bf25cb46b80f14b6719aad5b2e3d7c38ac))

## [1.3.2](https://github.com/asepharyana/pr-agent-server/compare/v1.3.1...v1.3.2) (2026-10-21)

### Bug Fixes

- **web:** show local time in the review history, and refresh without a reload ([96af3f6](https://github.com/asepharyana/pr-agent-server/commit/96af3f6161e5ec808e229e0d6c43defdd7597513))

## [1.3.1](https://github.com/asepharyana/pr-agent-server/compare/v1.3.0...v1.3.1) (2026-10-21)

### Bug Fixes

- **tools:** describe and improve threw away good retries, silently ([532b06c](https://github.com/asepharyana/pr-agent-server/commit/532b06cbf659ef1274447765c8a8ce293619acf1))

# [1.3.0](https://github.com/asepharyana/pr-agent-server/compare/v1.2.3...v1.3.0) (2026-10-21)

### Bug Fixes

- **llm:** the review never worked — model fabricated a tool call we never offered ([0c4d84d](https://github.com/asepharyana/pr-agent-server/commit/0c4d84d4f5d1e69072fdcf3c25796bc5172aa826))


### Features

- **review:** stop truncating at 128k, and disclose what was not analysed ([26ff77e](https://github.com/asepharyana/pr-agent-server/commit/26ff77e13ee4d9ddda4fa99d95d17a4876c6743c))

## [1.2.3](https://github.com/asepharyana/pr-agent-server/compare/v1.2.2...v1.2.3) (2026-10-21)

### Bug Fixes

- **api:** survive a failed history write, and set the public auth origin ([bb5521d](https://github.com/asepharyana/pr-agent-server/commit/bb5521d38b1c4cbdc7a39ecb764a586850661959))

## [1.2.2](https://github.com/asepharyana/pr-agent-server/compare/v1.2.1...v1.2.2) (2026-10-21)

### Bug Fixes

- **api:** build dist/seed.js, the only way an admin account can exist ([40ad56e](https://github.com/asepharyana/pr-agent-server/commit/40ad56ebd8810f97acf8e97a9979a5e3903c2db6))

## [1.2.1](https://github.com/asepharyana/pr-agent-server/compare/v1.2.0...v1.2.1) (2026-10-21)

### Bug Fixes

- **web:** stop the dashboard rendering a blank white page ([9729398](https://github.com/asepharyana/pr-agent-server/commit/9729398db78a1ed5551ecf9a035a89d2347922ef))

# [1.2.0](https://github.com/asepharyana/pr-agent-server/compare/v1.1.13...v1.2.0) (2026-10-21)

### Bug Fixes

- **api:** honour the coalesced rerun the db queue promised ([98e1234](https://github.com/asepharyana/pr-agent-server/commit/98e12347d70cf2f7950b23815f5becd8e9676a25))
- **api:** stop the webhook dropping a queued job onto the floor ([d3dd8a7](https://github.com/asepharyana/pr-agent-server/commit/d3dd8a75e9ff70d59ecf7134e6da29483defbe8f))
- **worker:** make the notify tests wait for delivery, not for a resolution ([ecd2843](https://github.com/asepharyana/pr-agent-server/commit/ecd28437948a6887d57b9540320a80f42d39b075))
- **worker:** treat every non-passing CI conclusion as red ([d8cdd12](https://github.com/asepharyana/pr-agent-server/commit/d8cdd123d298af3e9c991e8ce2cb6998b6e42049))


### Features

- **api:** record review history — the dashboard has never had any ([3e43700](https://github.com/asepharyana/pr-agent-server/commit/3e43700e5f6c528f34e260f2f9b2d365dd7bd3eb))

## [1.1.13](https://github.com/asepharyana/pr-agent-server/compare/v1.1.12...v1.1.13) (2026-10-21)

### Bug Fixes

- auto-fix code quality [skip ci] ([ae75fa1](https://github.com/asepharyana/pr-agent-server/commit/ae75fa163aaa8a05b70f4176dc5afdec50db364d))

## [1.1.12](https://github.com/asepharyana/pr-agent-server/compare/v1.1.11...v1.1.12) (2026-10-20)

### Bug Fixes

- auto-fix code quality [skip ci] ([215c3e5](https://github.com/asepharyana/pr-agent-server/commit/215c3e588013b01eb615b14bd150cf2ab10125f3))

## [1.1.11](https://github.com/asepharyana/pr-agent-server/compare/v1.1.10...v1.1.11) (2026-10-19)

### Bug Fixes

- **worker:** stop the test suite posting to the live Discord channel ([132399c](https://github.com/asepharyana/pr-agent-server/commit/132399c18ce20e2fde99c4c8983fccea2a4a9461))

## [1.1.10](https://github.com/asepharyana/pr-agent-server/compare/v1.1.9...v1.1.10) (2026-10-19)

### Bug Fixes

- auto-fix code quality [skip ci] ([5be19b8](https://github.com/asepharyana/pr-agent-server/commit/5be19b8bd55ee8e14b3b182c56ef454ab69ecdab))

## [1.1.9](https://github.com/asepharyana/pr-agent-server/compare/v1.1.8...v1.1.9) (2026-10-19)

### Bug Fixes

- auto-fix code quality [skip ci] ([4284f69](https://github.com/asepharyana/pr-agent-server/commit/4284f695d10914dde56825ab4a45232cdef39acc))

## [1.1.8](https://github.com/asepharyana/pr-agent-server/compare/v1.1.7...v1.1.8) (2026-10-19)

## [1.1.7](https://github.com/asepharyana/pr-agent-server/compare/v1.1.6...v1.1.7) (2026-10-19)

### Bug Fixes

- **worker:** record the PUSHED head, so a landed fix stops re-inviting the agent ([92e8e45](https://github.com/asepharyana/pr-agent-server/commit/92e8e457b5ee80b580e6978160c85f7325a83372)), closes [hub#53](https://github.com/hub/issues/53) [GMW#114](https://github.com/GMW/issues/114)

## [1.1.6](https://github.com/asepharyana/pr-agent-server/compare/v1.1.5...v1.1.6) (2026-10-17)

### Bug Fixes

- **worker:** reclaim the prompt audits too — the leak beside the clone ([0be3963](https://github.com/asepharyana/pr-agent-server/commit/0be3963d057836158cb07de8e642df5ab55e27bf))

## [1.1.5](https://github.com/asepharyana/pr-agent-server/compare/v1.1.4...v1.1.5) (2026-10-17)

### Bug Fixes

- **worker:** the sweep's empty-scan guard switched it off exactly when it was needed ([4bb0edc](https://github.com/asepharyana/pr-agent-server/commit/4bb0edcfdcca856b229cc36e3ef0cdaf969e8f10))

## [1.1.4](https://github.com/asepharyana/pr-agent-server/compare/v1.1.3...v1.1.4) (2026-10-17)

### Bug Fixes

- **worker:** run the workdir sweep before the empty-queue return, with an age floor ([581fd3f](https://github.com/asepharyana/pr-agent-server/commit/581fd3f86543727684f15a4e34db235629d5f95a))

## [1.1.3](https://github.com/asepharyana/pr-agent-server/compare/v1.1.2...v1.1.3) (2026-10-17)

### Bug Fixes

- **worker:** sweep clone workdirs for closed PRs — the leak that filled /tmp ([4a5ed06](https://github.com/asepharyana/pr-agent-server/commit/4a5ed061f9044576d9fba43fce45012a12c5949c))

## [1.1.2](https://github.com/asepharyana/pr-agent-server/compare/v1.1.1...v1.1.2) (2026-10-17)

### Bug Fixes

- **ci:** gate deploy on github.ref, not event_name — a dispatch can target a branch ([81b3e58](https://github.com/asepharyana/pr-agent-server/commit/81b3e58dccd421aeb85240912d241c07f5b78a86))

## [1.1.1](https://github.com/asepharyana/pr-agent-server/compare/v1.1.0...v1.1.1) (2026-10-16)

### Bug Fixes

- auto-fix code quality [skip ci] ([054deff](https://github.com/asepharyana/pr-agent-server/commit/054deff1ba70f36965ced65a90f1687156a268dc))
- auto-fix code quality [skip ci] ([bea6fd7](https://github.com/asepharyana/pr-agent-server/commit/bea6fd75f7019086adff8a1a46b7eb04550a7ef4))

# [1.1.0](https://github.com/asepharyana/pr-agent-server/compare/v1.0.12...v1.1.0) (2026-10-16)

### Features

- **worker:** invert close policy — close human PRs, never close dependabot ([52c5110](https://github.com/asepharyana/pr-agent-server/commit/52c5110b3becee26b5c48c9ee40b2a3e8cd69847))

## [1.0.12](https://github.com/asepharyana/pr-agent-server/compare/v1.0.11...v1.0.12) (2026-10-16)

### Bug Fixes

- **worker:** count red-CI waits on human PRs too, not only dependabot ([fca1778](https://github.com/asepharyana/pr-agent-server/commit/fca1778f7629cfdcd553ec2c1abcd84bd5237d78)), closes [GMW#109](https://github.com/GMW/issues/109)

## [1.0.11](https://github.com/asepharyana/pr-agent-server/compare/v1.0.10...v1.0.11) (2026-10-16)

### Bug Fixes

- **worker:** size PRUNE_THRESHOLD to the scan, not to a round number ([70aab59](https://github.com/asepharyana/pr-agent-server/commit/70aab595eb9b35422795af7ee8901f13db884008))

## [1.0.10](https://github.com/asepharyana/pr-agent-server/compare/v1.0.9...v1.0.10) (2026-10-16)

### Bug Fixes

- **worker:** prune fix-state entries for PRs that are no longer open ([0ee066a](https://github.com/asepharyana/pr-agent-server/commit/0ee066ad56756b9cb9dd1e32ffb8f93a6664664a)), closes [23-#28](https://github.com/23-/issues/28)

## [1.0.9](https://github.com/asepharyana/pr-agent-server/compare/v1.0.8...v1.0.9) (2026-10-16)

### Bug Fixes

- **worker:** a no-commit "fix" must not lock the agent out forever ([200b3e9](https://github.com/asepharyana/pr-agent-server/commit/200b3e9556bc8293296549b6b9d3639ca4524f26)), closes [mcpedia#28](https://github.com/mcpedia/issues/28)

## [1.0.8](https://github.com/asepharyana/pr-agent-server/compare/v1.0.7...v1.0.8) (2026-10-15)

### Bug Fixes

- auto-fix code quality [skip ci] ([44204b2](https://github.com/asepharyana/pr-agent-server/commit/44204b214ba70a0cc05d616444db27642d66a070))

## [1.0.7](https://github.com/asepharyana/pr-agent-server/compare/v1.0.6...v1.0.7) (2026-10-15)

### Bug Fixes

- auto-fix code quality [skip ci] ([0a95622](https://github.com/asepharyana/pr-agent-server/commit/0a95622f0eb1055def1577e09d57d9eb1a0945b3))

## [1.0.6](https://github.com/asepharyana/pr-agent-server/compare/v1.0.5...v1.0.6) (2026-10-15)

### Bug Fixes

- **worker:** never approve a PR whose mergeability is unknown ([8b34c58](https://github.com/asepharyana/pr-agent-server/commit/8b34c58f6f17cfedc0bbc79b81bb872de4ff5f81))

## [1.0.5](https://github.com/asepharyana/pr-agent-server/compare/v1.0.4...v1.0.5) (2026-10-15)

### Bug Fixes

- **worker:** a merge 405 is not necessarily branch protection ([71dfa00](https://github.com/asepharyana/pr-agent-server/commit/71dfa00f1e97057287d38ba4e464c73719e59b9c)), closes [hub#46](https://github.com/hub/issues/46) [pr-agent-server#5](https://github.com/pr-agent-server/issues/5) [#7](https://github.com/asepharyana/pr-agent-server/issues/7)

## [1.0.4](https://github.com/asepharyana/pr-agent-server/compare/v1.0.3...v1.0.4) (2026-10-15)

### Bug Fixes

- **worker:** a transient gateway failure must not pin a PR forever ([f29427d](https://github.com/asepharyana/pr-agent-server/commit/f29427d4cb062e53af61d5b743c06fb81fece870)), closes [hub#46](https://github.com/hub/issues/46) [pr-agent-server#5](https://github.com/pr-agent-server/issues/5)

## [1.0.3](https://github.com/asepharyana/pr-agent-server/compare/v1.0.2...v1.0.3) (2026-10-14)

### Bug Fixes

- auto-fix code quality [skip ci] ([32c38fd](https://github.com/asepharyana/pr-agent-server/commit/32c38fd3b4981b17efed37c27e3e5437f0d903c3))
- auto-fix code quality [skip ci] ([262acc4](https://github.com/asepharyana/pr-agent-server/commit/262acc4068f6da3f26c978c0b879ea5d83486dd0))
- auto-fix code quality [skip ci] ([0d97c7d](https://github.com/asepharyana/pr-agent-server/commit/0d97c7d394e237d59f4ace13c4a79f6541e4896f))
- auto-fix code quality [skip ci] ([d6bc9a3](https://github.com/asepharyana/pr-agent-server/commit/d6bc9a3e535557b705d7d706ea186d2c8f9d5fd5))
- auto-fix code quality [skip ci] ([11e41d3](https://github.com/asepharyana/pr-agent-server/commit/11e41d3ff054fa8c095fce604fe40f6db0e3befc))
- auto-fix code quality [skip ci] ([6c22cfc](https://github.com/asepharyana/pr-agent-server/commit/6c22cfce5289f85dc8683c12f6179c6d777992c9))
- auto-fix code quality [skip ci] ([8ceca5e](https://github.com/asepharyana/pr-agent-server/commit/8ceca5e1c5b33a909ce60e65014ba224733647b0))
- auto-fix code quality [skip ci] ([1a501fe](https://github.com/asepharyana/pr-agent-server/commit/1a501fec1eeefd5d1f9aea76e20746efc3d8ab84))

## [1.0.2](https://github.com/asepharyana/pr-agent-server/compare/v1.0.1...v1.0.2) (2026-10-14)

### Bug Fixes

- auto-fix code quality [skip ci] ([0fa7f55](https://github.com/asepharyana/pr-agent-server/commit/0fa7f55de12db25436b8a217515411286a4860c0))

## [1.0.1](https://github.com/asepharyana/pr-agent-server/compare/v1.0.0...v1.0.1) (2026-10-14)

# 1.0.0 (2026-10-14)

### Bug Fixes

- **api:** let the migrate step run without unrelated secrets ([19048a3](https://github.com/asepharyana/pr-agent-server/commit/19048a39486bfe3d402c13bf1eca9f2b9b21b839))
- **api:** never let the SPA catch-all answer an /api/* path ([9113417](https://github.com/asepharyana/pr-agent-server/commit/9113417056fa1a266c94619d18bdcd11de5d292c))
- **ci:** fetch full history so moon can resolve the base branch on PRs ([1f18087](https://github.com/asepharyana/pr-agent-server/commit/1f1808728b5b5cde5699a7808d4aad7ca8a4d94f))
- **ci:** never read an unreadable check-runs reply as "no CI configured" ([08f4c51](https://github.com/asepharyana/pr-agent-server/commit/08f4c51f77eb487945ea7045ae3c93025fa5acce))
- **ci:** pin moon as a devDependency so the runner resolves it ([fca37cb](https://github.com/asepharyana/pr-agent-server/commit/fca37cb941c3018ccbeaf527699939624d480449))
- **ci:** robust SSH key handling (base64/raw) + validation ([7ae7b66](https://github.com/asepharyana/pr-agent-server/commit/7ae7b6662d7b870fc6f1df7f45c0bc5c765f2082))
- **ci:** verify moon through pnpm exec, not a bare shell ([71dd4a4](https://github.com/asepharyana/pr-agent-server/commit/71dd4a422172fa2c1d1aa82ce6747137b3aaf40e))
- **cli:** fallback to user-local private key + record analytics ([4fa7d8b](https://github.com/asepharyana/pr-agent-server/commit/4fa7d8b6d0bb79b7f816702ac8b067f430ece13d))
- **deploy-worker:** run the test gate as the invoking user, not pr-agent ([294e534](https://github.com/asepharyana/pr-agent-server/commit/294e534e5e4323a59f964b44543c2b5f8bd7e70e))
- **deploy:** make the deploy workflow actually able to deploy ([fc6d971](https://github.com/asepharyana/pr-agent-server/commit/fc6d971d57f5b737e2780b9eb18a82a5f9849a47))
- **deploy:** make the remote half work — sudo, node install, unit install ([6f5b2d9](https://github.com/asepharyana/pr-agent-server/commit/6f5b2d9337213470fce71a414a0c0632911a82bb))
- **deploy:** pass StrictHostKeyChecking to the scp and health-poll calls ([b4fb52b](https://github.com/asepharyana/pr-agent-server/commit/b4fb52b80fa3ec57cf6d69a58ef14717947e94de))
- **deploy:** refuse to ship a stale worker bundle ([2bf2874](https://github.com/asepharyana/pr-agent-server/commit/2bf2874f300d50ffba040229048f7711635fc7c4))
- **deploy:** run migrate.js through bws-exec so it sees DATABASE_URL ([4cfc4a2](https://github.com/asepharyana/pr-agent-server/commit/4cfc4a29a3b953814bf0185387dc531088ad51ea))
- **deploy:** scp the systemd unit, and sudo the worker half ([9a5bdfe](https://github.com/asepharyana/pr-agent-server/commit/9a5bdfed6ace88e55ab2d9974bec8233a8d7f544))
- **deploy:** stop the legacy Bun server before starting the Node one ([2240d2f](https://github.com/asepharyana/pr-agent-server/commit/2240d2fe4ffe8593a5636b67b7b3154ef450d840))
- **deploy:** the worker has been running stateless since the cutover ([ce4e624](https://github.com/asepharyana/pr-agent-server/commit/ce4e624ddbb9ad2a38a1d6505f746fcab8fc800b))
- **discord:** review score scale is 0-100 not /10 ([3917437](https://github.com/asepharyana/pr-agent-server/commit/391743780d6d66edbbdab7a24bbccd1bf1e78feb))
- **discord:** strip HTML table markup from review notifications ([296f825](https://github.com/asepharyana/pr-agent-server/commit/296f8253476fb9004aacc05fdce8952d33632491))
- give the webhook the App key, and stop reporting failures as done ([d6b5f01](https://github.com/asepharyana/pr-agent-server/commit/d6b5f016ceaed8e80ffa3a243130da42f1d48e91)), closes [kbbi-api#7](https://github.com/kbbi-api/issues/7) [kbbi-api#8](https://github.com/kbbi-api/issues/8)
- health watchdog false 504s — Caddy header timeout + per-model logic ([2293428](https://github.com/asepharyana/pr-agent-server/commit/2293428421c352f7f3973ecfb10dc9f74ea1840e))
- health-check BWS token read as non-root cron user ([875ddfc](https://github.com/asepharyana/pr-agent-server/commit/875ddfcca96751ea2851a4fc4701dd815f0f3005))
- **health-check:** handle PermissionError on on-disk key file ([d516a0b](https://github.com/asepharyana/pr-agent-server/commit/d516a0b563ad1979068dd2590f601c3973f219cc))
- **health-check:** read key from on-disk file first, no BWS dependency ([ae5356a](https://github.com/asepharyana/pr-agent-server/commit/ae5356a4ead38970bf93c5af711f751029512d63))
- let a bad LLM body fall through to the next model ([93bf3c7](https://github.com/asepharyana/pr-agent-server/commit/93bf3c722cf86e25a625ce05aa91a02b01393572))
- monkey-patch litellm acompletion timeout 600s for 9router review diffs ([31f009b](https://github.com/asepharyana/pr-agent-server/commit/31f009bb89226481a660cf292e84e4b4a422b7fe))
- **nix:** add libstdc++ for tokenizers native dep ([09ed866](https://github.com/asepharyana/pr-agent-server/commit/09ed86652515f937870a197df41b16dee28b60c8))
- **nix:** restrict flake to x86_64-linux (nixpkgs 26.11 dropped darwin) ([081b2ad](https://github.com/asepharyana/pr-agent-server/commit/081b2ad4b57434f9af17b094aec8ae14d0eed6c3))
- parse PR-Agent analytics record-wrapped JSON format ([407819b](https://github.com/asepharyana/pr-agent-server/commit/407819b6470a65664d0bb6a2db9ca69794f90f72))
- pin autofix agent to claude-sonnet-5 via custom:9router provider ([0157029](https://github.com/asepharyana/pr-agent-server/commit/0157029da802e31203cf43d67d040c9ceaa3d78e))
- **pr:** say when a merge 403 had no owner PAT to retry with ([7342874](https://github.com/asepharyana/pr-agent-server/commit/7342874b94486126b0b62f1736b228bbf8a3359e))
- **pr:** stop the turn on an unknown CI gate, and call a 5xx merge a retry ([dde314e](https://github.com/asepharyana/pr-agent-server/commit/dde314e542de240f13d7b75f31ef818654da90ff))
- re-arm a failed review job, and restore the Discord channel ([f2340b8](https://github.com/asepharyana/pr-agent-server/commit/f2340b8081b13cc180138b0fc92a1198670a4682)), closes [#7](https://github.com/asepharyana/pr-agent-server/issues/7)
- repair instructions left stale by the move into apps/ ([c833a3c](https://github.com/asepharyana/pr-agent-server/commit/c833a3c5c1a2be06ab2183c955f48bb1be3cd296))
- repair two real LLM YAML shapes that killed reviews intermittently ([6c62ab9](https://github.com/asepharyana/pr-agent-server/commit/6c62ab9cb3289b680a93d3bc045432b803a1c66c))
- replace broken openai/auto fallback models with working 9router aliases ([06f3314](https://github.com/asepharyana/pr-agent-server/commit/06f331481906aae6e7b5128f6da16796fc875d94))
- restore auto-fix and auto-merge on two silent config bugs ([22a653e](https://github.com/asepharyana/pr-agent-server/commit/22a653ecffd6f3cd5326a018bac2d333aea64716))
- restore PR reviews, drop lost work, and unbreak the ops channel ([2bfd1cc](https://github.com/asepharyana/pr-agent-server/commit/2bfd1cc50a679336c3d1f2ca558c6944d2d678b2))
- route litellm via ANTHROPIC_API_* for 9router (no openai/ prefix) ([13156e7](https://github.com/asepharyana/pr-agent-server/commit/13156e76a53995fbbc4a4bc71e90b438536fbfc2))
- **scripts:** run the real suite in the worker deploy gate, and update docs ([7abb61e](https://github.com/asepharyana/pr-agent-server/commit/7abb61e7eb2947c2b45802973f32f21f3014aec5))
- **server:** parse-guard review, real Bun network errors, single-layer improve fallback ([22e4cfb](https://github.com/asepharyana/pr-agent-server/commit/22e4cfbc9c1900974abfadea22e0921628742760))
- **server:** re-queue a PR whose deduped webhook arrived mid-review ([f3585fb](https://github.com/asepharyana/pr-agent-server/commit/f3585fb032f8ce73732e3c812be9074d0564c822)), closes [owner/repo#pr](https://github.com/owner/repo/issues/pr)
- **server:** repoint e2e.ts to core/token after core/ extraction ([ef37a86](https://github.com/asepharyana/pr-agent-server/commit/ef37a86080e7b4528d63caefa048b1d320337635))
- **sync:** restore the pr-opened Discord post the port had dropped ([f59a88c](https://github.com/asepharyana/pr-agent-server/commit/f59a88cd78105c7e8c07a1ec1afbdb1f8435b055))
- **sync:** trim the commit detail, require a report port, make pr-path reachable ([8a7d48e](https://github.com/asepharyana/pr-agent-server/commit/8a7d48edfbdd4a69f88acfa0bc3409e934fc07c5))
- **test:** claim the test's own lock file, not the production one ([ae82ffe](https://github.com/asepharyana/pr-agent-server/commit/ae82ffe32461f0a4c880c5a1af4e881e700b835a))
- **tsconfig:** drop baseUrl, which TypeScript 7 removed ([57ef3bd](https://github.com/asepharyana/pr-agent-server/commit/57ef3bd563782cea2bcec8063dc2d1b34e1afd9c)), closes [#2](https://github.com/asepharyana/pr-agent-server/issues/2)
- unterminated triple-quote in setup_all.py secrets template ([e0e591a](https://github.com/asepharyana/pr-agent-server/commit/e0e591a63cdc3d25020d9f7fa3639af716ec3ed8))
- use 9router-compatible model names (claude-opus-5, no openai/ prefix) ([889a8d0](https://github.com/asepharyana/pr-agent-server/commit/889a8d0a8d4db938ee16c5b54ac55ec27d718d47))
- **web:** generate the route tree in the typecheck script ([c59ab43](https://github.com/asepharyana/pr-agent-server/commit/c59ab43bcf11882df80df24cea9c2a81074bc49c))
- **worker:** make a repeating failure escalate instead of looping forever ([09891b5](https://github.com/asepharyana/pr-agent-server/commit/09891b5051dbd8a067a36476dcbefd39ee9e2dfd)), closes [GMW#109](https://github.com/GMW/issues/109)
- **worker:** make the fix-state mutators persist like the Python ones ([3e2f40c](https://github.com/asepharyana/pr-agent-server/commit/3e2f40c0282060ed25f06f3d526dd96951f8c844))
- **worker:** make the Report suite hermetic and resolve its config at call time ([7e51933](https://github.com/asepharyana/pr-agent-server/commit/7e519339eedadcdcb4ffd32fc9fb7f1c47c7d038))
- **worker:** pure --dry runs + Claude Code MCP-server hang ([0653f6c](https://github.com/asepharyana/pr-agent-server/commit/0653f6c508487a522dd26b9b22c330514df26acb))
- **worker:** redact credentials from reported git errors ([80f12a8](https://github.com/asepharyana/pr-agent-server/commit/80f12a867e3f83642c4f48cb7f28801a2c2cdb56))
- **worker:** redact the agent snippet, keep Python's KeyError on a missing filename ([c862e39](https://github.com/asepharyana/pr-agent-server/commit/c862e396602c21863d26c49163be78ffd0195eca))
- **worker:** redact the gateway key from the success snippet too ([cc15d06](https://github.com/asepharyana/pr-agent-server/commit/cc15d060183b28c29cbe5eeb4b7b72dad2d8f675))
- **worker:** restore Python's three-way lockfile guard and its silent skip ([c9975ea](https://github.com/asepharyana/pr-agent-server/commit/c9975ead60971b8a43631278470034b7b1b99927))
- **worker:** resume the worktree instead of re-cloning from zero every attempt ([c6f7e5d](https://github.com/asepharyana/pr-agent-server/commit/c6f7e5d49b147baf1954751e934b33f91544b3dc))
- **worker:** retry a response whose body is truncated mid-stream ([1ba93f3](https://github.com/asepharyana/pr-agent-server/commit/1ba93f3a37d65bc421d9ef61a3cd7b11c3eda723))
- **worker:** send a provider slug the gateway can actually resolve ([c002d3e](https://github.com/asepharyana/pr-agent-server/commit/c002d3e1b61d804cfde9c76949858e3a1b84bcfe))
- **worker:** share TMP_BASE between the autofix and lockfix workdirs ([5eacae0](https://github.com/asepharyana/pr-agent-server/commit/5eacae01f88d5bdd393d185e38380bf01eb4c212))
- **worker:** typecheck the test suite and fail a missing key cleanly ([f603912](https://github.com/asepharyana/pr-agent-server/commit/f603912a931be4af054e5ee83a87c11a42964944))
- **worker:** unblock the PR queue — verdict parsing, prompt leaks, fix loop ([1ef9e02](https://github.com/asepharyana/pr-agent-server/commit/1ef9e029cb1e7ac677569ce15e33dcfa0e274078)), closes [GMW#109](https://github.com/GMW/issues/109) [GMW#109](https://github.com/GMW/issues/109)


### Features

- add dependabot config (npm) ([33928c7](https://github.com/asepharyana/pr-agent-server/commit/33928c78f5cff810a9c84726cb46ec6b6033ddec))
- add health watchdog, key auto-sync, analytics, Discord notifications, trivial-PR merge ([690f96a](https://github.com/asepharyana/pr-agent-server/commit/690f96aacbc6fef1c0edfedba8943ca3ba627e65))
- **api:** add oRPC, better-auth, and split the legacy routes onto Hono ([6b8ee80](https://github.com/asepharyana/pr-agent-server/commit/6b8ee805f769b5098e833fb9f9de8bb4b4dca25f))
- **api:** add Postgres + Drizzle, and make the review queue restart-safe ([653ffae](https://github.com/asepharyana/pr-agent-server/commit/653ffae840f0f9bfadcbdd016bc66f2f3b863e07))
- **api:** serve the SPA, expose OpenAPI, and fix the missing auth migration ([8027505](https://github.com/asepharyana/pr-agent-server/commit/802750550db07a35227943d5cd07fe54a482102c))
- **ops:** add PR queue worker with toolchain pin guard ([835552c](https://github.com/asepharyana/pr-agent-server/commit/835552c5cabf305723dfe7b98c4b30576c4ceb85))
- PR-Agent GitHub App server — sanitized source + Nix flake + CI deploy ([163a1ef](https://github.com/asepharyana/pr-agent-server/commit/163a1ef7abc11d88f9bd3c5e927c045ec295d6da))
- run the AI fix through the Claude Code CLI, not the Hermes gateway ([0cd4dd5](https://github.com/asepharyana/pr-agent-server/commit/0cd4dd586b49a357010c9974b78051fb37495e27)), closes [#4](https://github.com/asepharyana/pr-agent-server/issues/4)
- **server:** Bun/TypeScript re-implementation of PR review engine ([055501a](https://github.com/asepharyana/pr-agent-server/commit/055501aed1f922473de010033cbc48cc15b0d070)), closes [asepharyana/nextjs-template#19](https://github.com/asepharyana/nextjs-template/issues/19)
- **server:** in-process review queue with dedupe and concurrency cap ([1a6b92e](https://github.com/asepharyana/pr-agent-server/commit/1a6b92e2190aa97af96cdb6a4d0d77f44148c292))
- **server:** port /describe and /improve tools + real analytics ([608b52a](https://github.com/asepharyana/pr-agent-server/commit/608b52a0e5dc09c927de6e515735f4e07ea1b11c)), closes [#19](https://github.com/asepharyana/pr-agent-server/issues/19)
- **server:** production cut-over to Bun — notify_review, setup/callback, key resolution ([bc69998](https://github.com/asepharyana/pr-agent-server/commit/bc69998d8e27ed0c492d7a33232ecb8048ea75f0))
- update models to claude-opus-5/sonnet-5/haiku-4-5-20251001 (tested live on 9router) ([017656d](https://github.com/asepharyana/pr-agent-server/commit/017656d97b19d6d79bdb27a00d079b021da15505))
- **web:** add the review history browser ([76a24be](https://github.com/asepharyana/pr-agent-server/commit/76a24bea1983918ae42fc4d340fffa8a1f32e2e0))
- **worker:** cut over to the Bun worker, deployed as a systemd timer ([91e7479](https://github.com/asepharyana/pr-agent-server/commit/91e74792aebf8ba4a3f61c2ea792a9858e7008c7))
- **worker:** drive Hermes gateway API server instead of claude -p ([99d47c8](https://github.com/asepharyana/pr-agent-server/commit/99d47c8ff884e4b1367ff6ad63cfc2bda83d6804))
- **worker:** git helpers with push-url strategy and error classification ([51195d0](https://github.com/asepharyana/pr-agent-server/commit/51195d08909cf729d49af77113f4a612b3ad1734))
- **worker:** github api client with RS256 jwt, retry and token cache ([1cc7d52](https://github.com/asepharyana/pr-agent-server/commit/1cc7d52da2bbb4163f3bb4e9c3ae06b6f12f1c21))
- **worker:** hermes api client and discord ops notifier ([b631179](https://github.com/asepharyana/pr-agent-server/commit/b63117910f7a461efb7585a9f530b9b845d6f589))
- **worker:** lockfile fixes, ai autofix and merge actions ([10b80e4](https://github.com/asepharyana/pr-agent-server/commit/10b80e49a2db782518a4ebe6b45671568363d7a3))
- **worker:** migrate pr-ops-notifier to ops/syncHooks (ts) ([9398642](https://github.com/asepharyana/pr-agent-server/commit/93986422c75d47875ef7f0c7f33553c8ec78acca))
- **worker:** per-fork session header + 3600s sync timeout + merge salvage ([66b567a](https://github.com/asepharyana/pr-agent-server/commit/66b567a6bcf078d6bc869084f47e3dac103262f3))
- **worker:** per-pr pipeline, tick runner and CLI flags ([4c42890](https://github.com/asepharyana/pr-agent-server/commit/4c428906fa3f7bceedfb7d5de388449143bf8806))
- **worker:** pr scan, review trigger, safety, ci and toolchain pins ([42cb809](https://github.com/asepharyana/pr-agent-server/commit/42cb809e496179de376e83642e5762c095009628))
- **worker:** scaffold TS worker with lock, state and report ([758d7ca](https://github.com/asepharyana/pr-agent-server/commit/758d7ca8270be3ede240a4a71d056628711a4682))
- **worker:** skip-on-error no loop + conflict auto-fix + deduped notif ([1dc4d09](https://github.com/asepharyana/pr-agent-server/commit/1dc4d098fa304eaf747d980c71fe963ade2a2dac))
- **worker:** upstream fork auto-sync — pull+merge fork repos hourly ([c48adea](https://github.com/asepharyana/pr-agent-server/commit/c48adea6c35f9a774e51cd4c614a7c0bc9f67d1a))
- **worker:** upstream fork sync with salvage, protected-pr path and ci revert ([f765ce4](https://github.com/asepharyana/pr-agent-server/commit/f765ce438e465e4c4d9ba95248ac97e5795ee161))
- **worker:** wire the fork-config sync to a gated CLI mode ([1064879](https://github.com/asepharyana/pr-agent-server/commit/1064879d94ec6af661ea6b2c2a2a03f5443f4110))

# Changelog

All notable changes to pr-agent-server are documented here.
Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
and are derived automatically from
[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).
