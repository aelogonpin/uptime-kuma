# Changelog

All notable changes to this project will be documented in this file.

## [Custom Subpath Edition] - 2026-08-28

### Added
- **Native Subpath Support (`UPTIME_KUMA_BASE_PATH`)**: Added the ability to host Uptime Kuma under a specific subpath (e.g. `http://your-domain.com/kuma/`) instead of the root directory.

### Changed
- Refactored `server.js` and `uptime-kuma-server.js` to mount the main Express application as a router under `UPTIME_KUMA_BASE_PATH`.
- Modified Vue Vite configuration (`vite.config.js`) to inject `import.meta.env.BASE_URL` based on the environment variable during build.
- Updated Vue Router (`createWebHistory`) and Axios initialization to use relative base URLs.
- Fixed hardcoded absolute paths (`/icon.svg`, `/serviceWorker.js`, `/api/...`) across Vue templates and components to resolve correctly relative to the subpath.
- Dynamically generate the correct `start_url` and `icon` links in the PWA manifest and injected DOM headers.

### Fixed
- Fixed UI linking issues in Dashboard to properly direct to `/kuma/status/` and `/kuma/manage-status-page` instead of root.
- Fixed 404 resource fetching errors on custom Status Pages when hosted under a subpath.
