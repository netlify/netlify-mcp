# Changelog

## [1.18.1](https://github.com/netlify/netlify-mcp/compare/mcp-v1.18.0...mcp-v1.18.1) (2026-10-08)


### Bug Fixes

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
