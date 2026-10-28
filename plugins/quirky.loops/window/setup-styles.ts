export const setupStyles = `
.loop-setup-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: grid;
  place-items: center;
  padding: 12px;
  background: rgb(7 10 16 / 72%);
}
.loop-setup-dialog {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  width: min(1080px, 100%);
  max-height: min(900px, calc(100dvh - 24px));
  overflow: hidden;
  color: var(--color-text, #edf2f7);
  background: var(--color-panel, #171b24);
  border: 1px solid var(--color-border, #343b49);
  border-radius: 12px;
  box-shadow: 0 24px 80px rgb(0 0 0 / 42%);
}
.loop-setup-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--color-border, #343b49);
}
.loop-setup-header h2 { margin: 0; font-size: 16px; font-weight: 600; }
.loop-setup-close {
  padding: 4px 8px;
  color: inherit;
  background: transparent;
  border: 0;
  border-radius: 6px;
  cursor: pointer;
}
.loop-setup-main {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(280px, 0.8fr);
  min-height: 0;
  overflow: auto;
}
.loop-setup-left, .loop-setup-right { min-width: 0; padding: 20px; }
.loop-setup-left { border-right: 1px solid var(--color-border, #343b49); }
.loop-setup-right { display: flex; flex-direction: column; gap: 14px; }
.loop-setup-name {
  display: block;
  width: 100%;
  margin: 0 0 16px;
  padding: 0;
  color: inherit;
  font: inherit;
  font-size: clamp(24px, 4vw, 34px);
  font-weight: 650;
  letter-spacing: -0.025em;
  background: transparent;
  border: 0;
  outline-offset: 4px;
}
.loop-setup-name::placeholder { color: var(--color-text-muted, #858e9c); opacity: 1; }
.loop-code-label, .loop-field > span:first-child { display: block; margin-bottom: 6px; font-size: 12px; font-weight: 600; }
.loop-code-editor {
  display: block;
  box-sizing: border-box;
  width: 100%;
  min-height: 270px;
  resize: vertical;
  padding: 14px;
  color: inherit;
  font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  background: var(--color-input, #10141b);
  border: 1px solid var(--color-border, #343b49);
  border-radius: 8px;
}
.loop-field-error { display: block; margin-top: 5px; color: var(--color-danger, #ff7777); font-size: 12px; }
.loop-setup-empty-error { margin: 8px 0 0; color: var(--color-danger, #ff7777); font-size: 12px; }
.loop-queue-composer { display: grid; gap: 8px; margin: 10px 0 14px; }
.loop-queue-composer textarea, .loop-field textarea, .loop-field input, .loop-field select, .loop-queue-item textarea {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  padding: 8px 10px;
  color: inherit;
  font: inherit;
  background: var(--color-input, #10141b);
  border: 1px solid var(--color-border, #343b49);
  border-radius: 6px;
}
.loop-queue-composer textarea, .loop-queue-item textarea, .loop-field textarea { resize: vertical; }
.loop-queue-list { display: grid; gap: 10px; }
.loop-queue-item { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: start; }
.loop-queue-item textarea { min-height: 82px; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.loop-queue-controls { display: flex; flex-direction: column; gap: 4px; }
.loop-queue-controls button, .loop-settings button, .loop-setup-footer button, .loop-queue-composer button {
  min-height: 32px;
  padding: 6px 10px;
  color: inherit;
  background: var(--color-button, #232936);
  border: 1px solid var(--color-border, #343b49);
  border-radius: 6px;
  cursor: pointer;
}
.loop-queue-controls button:disabled, .loop-settings button:disabled, .loop-setup-footer button:disabled, .loop-queue-composer button:disabled { opacity: .5; cursor: not-allowed; }
.loop-queue-empty { margin: 8px 0; color: var(--color-text-muted, #a5adba); font-size: 12px; }
.loop-settings { display: grid; gap: 12px; }
.loop-field { display: grid; gap: 4px; min-width: 0; }
.loop-field-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 10px; }
.loop-check-field { display: flex; align-items: start; gap: 9px; font-size: 13px; }
.loop-check-field input { margin-top: 2px; }
.loop-advanced-toggle { justify-self: start; padding-inline: 0 !important; background: transparent !important; border: 0 !important; }
.loop-advanced-fields { display: grid; gap: 12px; padding-top: 4px; }
.loop-setup-warning, .loop-setup-error, .loop-setup-load-error {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid var(--color-warning-border, #735d34);
  border-radius: 7px;
  background: var(--color-warning-bg, #2c2619);
  font-size: 12px;
}
.loop-setup-error { border-color: var(--color-danger, #914646); background: rgb(128 38 38 / 18%); }
.loop-setup-load-error { border-color: var(--color-border, #343b49); background: var(--color-input, #10141b); }
.loop-setup-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 20px;
  border-top: 1px solid var(--color-border, #343b49);
}
.loop-setup-footer p { margin: 0; color: var(--color-text-muted, #a5adba); font-size: 12px; }
.loop-setup-footer-actions { display: flex; flex-shrink: 0; gap: 8px; }
.loop-setup-footer .loop-primary { color: white; background: var(--color-accent, #5268c6); border-color: var(--color-accent, #5268c6); }
.loop-visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
@media (max-width: 720px) {
  .loop-setup-main { grid-template-columns: minmax(0, 1fr); }
  .loop-setup-left { border-right: 0; border-bottom: 1px solid var(--color-border, #343b49); }
  .loop-setup-left, .loop-setup-right { padding: 16px; }
}
@media (max-width: 480px) {
  .loop-setup-backdrop { padding: 0; }
  .loop-setup-dialog { width: 100%; max-height: 100dvh; border-radius: 0; }
  .loop-setup-footer { align-items: stretch; flex-direction: column; padding: 12px 16px; }
  .loop-setup-footer-actions { justify-content: flex-end; }
  .loop-field-grid { grid-template-columns: minmax(0, 1fr); }
}
`;
