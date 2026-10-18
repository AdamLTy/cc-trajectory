import { MOD_KEY } from "../useShortcuts.ts";
import "./shortcuts.css";

const SHORTCUTS: { keys: string[]; label: string }[] = [
  { keys: ["j"], label: "Next step" },
  { keys: ["k"], label: "Previous step" },
  { keys: [MOD_KEY, "K"], label: "Focus the prompt (Live mode)" },
  { keys: ["Esc"], label: "Stop the running agent / close this" },
  { keys: ["?"], label: "Show or hide these shortcuts" },
];

// A quiet pointer to the keyboard shortcuts, in the page header next to the theme toggle.
export function ShortcutHint({ onHelp }: { onHelp: () => void }) {
  return (
    <button className="shortcut-hint" onClick={onHelp} title={`Keyboard shortcuts: j/k step through the run, ${MOD_KEY}+K prompt, Esc stop`}>
      ? shortcuts
    </button>
  );
}

// The list of keyboard shortcuts, as a card over the page. A click on the backdrop (or Esc) closes it.
export function ShortcutHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="shortcut-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="shortcut-card" role="dialog" aria-modal="true" aria-labelledby="shortcut-title">
        <h2 id="shortcut-title">Keyboard shortcuts</h2>
        <dl>
          {SHORTCUTS.map(({ keys, label }) => (
            <div key={label} className="shortcut-row">
              <dt>
                {keys.map((key) => (
                  <kbd key={key}>{key}</kbd>
                ))}
              </dt>
              <dd>{label}</dd>
            </div>
          ))}
        </dl>
        <p className="shortcut-note">j, k and ? are typed normally while a text field has focus.</p>
      </div>
    </div>
  );
}
