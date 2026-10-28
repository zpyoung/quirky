export const RAIL_STYLES = `
.loop-view-root {
  container-type: inline-size;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  color: var(--ui-fg, inherit);
  font: inherit;
}
.loop-view-root *, .loop-view-root *::before, .loop-view-root *::after { box-sizing: border-box; }
.loop-view-grid { display: flex; flex-direction: column; gap: 1rem; min-width: 0; }
.loop-view-output, .loop-view-rail { min-width: 0; border: 1px solid var(--ui-border, #8885); border-radius: .5rem; padding: 1rem; }
.loop-view-output { order: 0; }
.loop-view-rail { order: 1; }
.loop-view-root h2, .loop-view-root h3, .loop-view-root h4 { margin: 0 0 .65rem; }
.loop-view-root p { overflow-wrap: anywhere; }
.loop-view-header { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
.loop-view-header h2 { margin: 0; }
.loop-state-pill, .loop-preset-pill { display: inline-flex; align-items: center; border: 1px solid var(--ui-border, #8888); border-radius: 999px; padding: .15rem .6rem; font-size: .85em; }
.loop-state-running { color: var(--ui-success, #237748); }
.loop-state-needs-you, .loop-state-unverifiable { color: var(--ui-warning, #9a5c00); }
.loop-state-paused { color: var(--ui-warning, #8a6300); }
.loop-state-completed, .loop-state-stopped { color: var(--ui-muted, #666); }
.loop-loop-meta, .loop-phase, .loop-progression, .loop-meters, .loop-next-time { margin: .5rem 0; }
.loop-status-strip { margin: .75rem 0; padding: .65rem .8rem; border-left: .25rem solid var(--ui-accent, #579); background: var(--ui-surface-raised, #8881); }
.loop-progress { display: flex; align-items: center; gap: .6rem; }
.loop-progress progress { flex: 1; min-width: 4rem; }
.loop-meters { display: flex; flex-wrap: wrap; gap: .5rem 1rem; }
.loop-warnings, .loop-detail-facts { margin: .75rem 0; }
.loop-detail-facts { display: grid; grid-template-columns: minmax(6rem, auto) 1fr; gap: .35rem .75rem; }
.loop-detail-facts dt { color: var(--ui-muted, #666); }
.loop-detail-facts dd { margin: 0; overflow-wrap: anywhere; }
.loop-output-messages { display: flex; flex-direction: column; gap: .75rem; min-height: 3rem; max-height: 60vh; overflow: auto; }
.loop-output-message { border-bottom: 1px solid var(--ui-border, #8884); padding-bottom: .65rem; min-width: 0; }
.loop-output-message header { display: flex; justify-content: space-between; gap: .75rem; font-size: .85em; color: var(--ui-muted, #666); }
.loop-output-message pre, .loop-iteration-detail pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; margin: .4rem 0 0; }
.loop-muted { color: var(--ui-muted, #666); }
.loop-error { color: var(--ui-danger, #a22); margin: .5rem 0; }
.loop-controls, .loop-queue-actions, .loop-dialog-actions { display: flex; flex-wrap: wrap; gap: .45rem; margin: .75rem 0; }
.loop-resume-control { display: flex; flex-wrap: wrap; align-items: end; gap: .5rem; }
.loop-resume-control label, .loop-rail-form label, .loop-queue label { display: flex; flex-direction: column; gap: .25rem; }
.loop-resume-control input, .loop-rail-form input, .loop-rail-form textarea, .loop-queue textarea { max-width: 100%; min-width: 0; }
.loop-rail-form textarea, .loop-queue textarea { min-height: 4.5rem; width: 100%; }
.loop-form-panel { margin: .75rem 0; border: 1px solid var(--ui-border, #8885); border-radius: .4rem; padding: .75rem; }
.loop-form-panel h3 { margin-top: 0; }
.loop-queue-list { list-style: none; padding: 0; margin: 0; }
.loop-queue-item { border-top: 1px solid var(--ui-border, #8885); padding: .7rem 0; min-width: 0; }
.loop-queue-item-heading { display: flex; align-items: center; gap: .45rem; }
.loop-queue-state { display: inline-grid; place-items: center; min-width: 1.2rem; font-weight: 700; }
.loop-queue-state-label, .loop-queue-position { color: var(--ui-muted, #666); font-size: .85em; }
.loop-queue-body { white-space: pre-wrap; overflow-wrap: anywhere; }
.loop-queue-add, .loop-queue-edit { margin-top: .6rem; }
.loop-iteration-list { list-style: none; padding: 0; margin: 0; }
.loop-iteration-list li { border-top: 1px solid var(--ui-border, #8885); padding: .6rem 0; }
.loop-iteration-entry { display: grid; width: 100%; grid-template-columns: minmax(0, 1fr) auto; text-align: left; gap: .25rem .75rem; }
.loop-iteration-entry-meta { color: var(--ui-muted, #666); font-size: .9em; }
.loop-iteration-detail section { margin-top: .85rem; }
.loop-view-root [role="dialog"] { border: 1px solid var(--ui-border, #8888); border-radius: .5rem; padding: 1rem; margin: .75rem 0; background: var(--ui-surface, Canvas); }
@container (min-width: 720px) {
  .loop-view-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(19rem, 24rem); align-items: stretch; height: 100%; }
  .loop-view-output { min-height: 0; overflow: hidden; }
  .loop-output-messages { max-height: none; height: calc(100% - 2rem); }
  .loop-view-rail { min-height: 0; overflow: auto; }
}
`;
