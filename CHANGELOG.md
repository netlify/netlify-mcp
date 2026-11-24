# Changelog

## [1.22.2](https://github.com/netlify/netlify-mcp/compare/mcp-v1.22.1...mcp-v1.22.2) (2026-11-24)


### Bug Fixes

* answer unsupported_grant_type for grant types the token endpoint does not support ([#112](https://github.com/netlify/netlify-mcp/issues/112)) ([dc60ba2](https://github.com/netlify/netlify-mcp/commit/dc60ba23e5fa19b600e13ddb6446a9762103d837))
* **deps:** update dependency @netlify/blobs to ^11.1.10 ([#115](https://github.com/netlify/netlify-mcp/issues/115)) ([d25845d](https://github.com/netlify/netlify-mcp/commit/d25845d6bc6426ab3acaf8ad340df65021d78476))
* **deps:** update dependency @netlify/dev-utils to ^6.1.1 ([#116](https://github.com/netlify/netlify-mcp/issues/116)) ([3b09b9a](https://github.com/netlify/netlify-mcp/commit/3b09b9a4026e524170d0ae5a8449bbcbeb7a9463))
* **deps:** update dependency @netlify/functions to ^6.1.2 ([#118](https://github.com/netlify/netlify-mcp/issues/118)) ([f570c11](https://github.com/netlify/netlify-mcp/commit/f570c11e640c9b4063a05fd44d721a44ae9524f2))
* guard MCP env-var and form-submission mutations against failed lookups and missing selectors ([#76](https://github.com/netlify/netlify-mcp/issues/76)) ([5e7ccb3](https://github.com/netlify/netlify-mcp/commit/5e7ccb39c3600531cbfdcfaeed31c436e76855c8))
* log rejections for a missing Mcp-Method header as warnings ([#111](https://github.com/netlify/netlify-mcp/issues/111)) ([1149dc3](https://github.com/netlify/netlify-mcp/commit/1149dc3199e5114f9133c20557f6691d0d75f188))

## [1.22.1](https://github.com/netlify/netlify-mcp/compare/mcp-v1.22.0...mcp-v1.22.1) (2026-11-13)


### Bug Fixes

* read the Netlify token through `@netlify/dev-utils` ([#101](https://github.com/netlify/netlify-mcp/issues/101)) ([f63d6c5](https://github.com/netlify/netlify-mcp/commit/f63d6c50e83e554c6c6f9571515c6ecd32ff27e8))

## [1.22.0](https://github.com/netlify/netlify-mcp/compare/mcp-v1.21.0...mcp-v1.22.0) (2026-11-03)


### Features

* add interactive deployment cards to hosted MCP ([#95](https://github.com/netlify/netlify-mcp/issues/95)) ([ff531e2](https://github.com/netlify/netlify-mcp/commit/ff531e2d1cf0e336044f44ea387ae33cef611c32))


### Bug Fixes

* confirm a tool-level 401 with /user before asking the agent to sign in ([#83](https://github.com/netlify/netlify-mcp/issues/83)) ([19ed461](https://github.com/netlify/netlify-mcp/commit/19ed461f99946999fb68720a2251afb312cd6451))
* preserve deployment card padding in chat hosts ([#97](https://github.com/netlify/netlify-mcp/issues/97)) ([955cb1a](https://github.com/netlify/netlify-mcp/commit/955cb1ae1f607afdeabf90e0bbf0f98bc495d231))
* rename deployment card to Netlify Deploys ([#98](https://github.com/netlify/netlify-mcp/issues/98)) ([c67980d](https://github.com/netlify/netlify-mcp/commit/c67980d8f4809b87d52e369e79fe31956c7b0c89))

## [1.21.0](https://github.com/netlify/netlify-mcp/compare/mcp-v1.20.0...mcp-v1.21.0) (2026-10-23)


### Features

* publish an MCP server card for discovery ([#81](https://github.com/netlify/netlify-mcp/issues/81)) ([c48b528](https://github.com/netlify/netlify-mcp/commit/c48b528aa37d9423c67c45727bf17d8f40a7c8e8))


### Bug Fixes

* **oauth:** keep the upstream Netlify token out of URLs ([#88](https://github.com/netlify/netlify-mcp/issues/88)) ([080752a](https://github.com/netlify/netlify-mcp/commit/080752a77c84c427958a6bf44efc2c82424cd4c9))

## [1.20.0](https://github.com/netlify/netlify-mcp/compare/mcp-v1.19.0...mcp-v1.20.0) (2026-10-20)


### Features

* **logging:** log Codex session, thread and turn ids on tool calls ([#79](https://github.com/netlify/netlify-mcp/issues/79)) ([8b88c6f](https://github.com/netlify/netlify-mcp/commit/8b88c6fb3e3fceae2155d9f6356f5a7fd5ef4fac))


### Bug Fixes

* **auth:** let OpenAI and Codex clients list tools before sign-in ([#77](https://github.com/netlify/netlify-mcp/issues/77)) ([2d4bf2c](https://github.com/netlify/netlify-mcp/commit/2d4bf2ca2c360ccf8d370f8e16d649b334aef3e6))

## [1.19.0](https://github.com/netlify/netlify-mcp/compare/mcp-v1.18.0...mcp-v1.19.0) (2026-10-13)


### Features

* add observability tools domain ([#11](https://github.com/netlify/netlify-mcp/issues/11)) ([30d660f](https://github.com/netlify/netlify-mcp/commit/30d660fd484f63fe75197bcebfac02bc9388019d))


### Bug Fixes

* actually enforce pagination bounds and timeout ([#74](https://github.com/netlify/netlify-mcp/issues/74)) ([1c0f64b](https://github.com/netlify/netlify-mcp/commit/1c0f64b8c22fecaab535c9e55406b4e4a17b0afa))
* **oauth:** sign the authorize state and type issued tokens (SEC-790) ([#68](https://github.com/netlify/netlify-mcp/issues/68)) ([79a81b8](https://github.com/netlify/netlify-mcp/commit/79a81b8b03496332e6bbbaf9c93d3e66eb656157))

## [1.18.0](https://github.com/netlify/netlify-mcp/compare/mcp-v1.17.0...mcp-v1.18.0) (2026-10-07)


### Features

* serve a granular, individually-annotated tool surface to OpenAI clients ([#60](https://github.com/netlify/netlify-mcp/issues/60)) ([1f8c2cb](https://github.com/netlify/netlify-mcp/commit/1f8c2cb7ca10e595ff7053184f20f26299141056))
* serve coding context from the hosted Netlify skills ([#56](https://github.com/netlify/netlify-mcp/issues/56)) ([760342e](https://github.com/netlify/netlify-mcp/commit/760342e8e8f3678fc254b98578cc6ccb221c55a3))


### Bug Fixes

* address app review on granular tool names and visitor-access hint ([#61](https://github.com/netlify/netlify-mcp/issues/61)) ([312cf63](https://github.com/netlify/netlify-mcp/commit/312cf63e414a2dfc9f7330b917428679e5284f3a))
* declare all tool behaviour hints explicitly ([#58](https://github.com/netlify/netlify-mcp/issues/58)) ([9501c56](https://github.com/netlify/netlify-mcp/commit/9501c569d84fbb472372bda2921cf5e595c06c12))
* mark project renames as destructive ([#62](https://github.com/netlify/netlify-mcp/issues/62)) ([e0b23f4](https://github.com/netlify/netlify-mcp/commit/e0b23f4b413c840c30696af2bbc5321a798e2e22))

## [1.17.0](https://github.com/netlify/netlify-mcp/compare/mcp-v1.16.0...mcp-v1.17.0) (2026-09-30)


### Features

* support subscribing to events ([#53](https://github.com/netlify/netlify-mcp/issues/53)) ([f669f52](https://github.com/netlify/netlify-mcp/commit/f669f5281968b9c8c57bda1c3d776b6cf261faff))


### Bug Fixes

* allow claude.ai/* to be aparat of the allowed urls for claude design to download from ([#50](https://github.com/netlify/netlify-mcp/issues/50)) ([57e547a](https://github.com/netlify/netlify-mcp/commit/57e547a1b23ace88227b6fc0ce014ec390e4c4f7))

## [1.16.0](https://github.com/netlify/netlify-mcp/compare/mcp-v1.15.1...mcp-v1.16.0) (2026-09-25)


### Features

* attribute local MCP logins to the driving agent (EX-3037) ([#45](https://github.com/netlify/netlify-mcp/issues/45)) ([73db306](https://github.com/netlify/netlify-mcp/commit/73db306939b8119f20d08db39be4e219d11695a2))
* **oauth:** log client_name at registration (EX-3039) ([#39](https://github.com/netlify/netlify-mcp/issues/39)) ([2f3bc2b](https://github.com/netlify/netlify-mcp/commit/2f3bc2bd48d62f08087fbc3ab7afca8678ccf0b3))
* **oauth:** tell the signup page which AI agent sent the user (EX-3036) ([#46](https://github.com/netlify/netlify-mcp/issues/46)) ([fee8f99](https://github.com/netlify/netlify-mcp/commit/fee8f9915cef8159810e0288554032cc6e331d7f))
