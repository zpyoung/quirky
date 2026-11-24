// Ambient declarations for compile-time constants substituted by the build configs.

// Full commit the build was made from (`git rev-parse HEAD`); official skill installs pin to it.
declare const QUIRKY_BUILD_COMMIT: string

// QUIRKY_LAYOUT_OWNER is declared and read in one place: src/shared/layout-owner-switch.ts.
