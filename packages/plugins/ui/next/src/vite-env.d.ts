/// <reference types="vite/client" />

/**
 * CSS Modules: a component imports its region's module and reads
 * `styles.foo`, so a name stays local to the region that owns it. The
 * rules for the modules live at the top of `styles/base.ts`.
 */
declare module "*.module.css" {
  const classes: Record<string, string>;
  export default classes;
}
