import { AdvancedDynamicTexture, Button, Control, StackPanel, TextBlock } from './babylon';
import type { Mesh } from '@babylonjs/core';

/**
 * In-world wall panel drawn with Babylon GUI 2D onto a mesh texture.
 * (GUI 3D "MRTK" controls are deliberately NOT used: they load textures from
 * assets.babylonjs.com.) Fonts are the platform's system sans-serif.
 * The panel only displays state and emits button callbacks; it never mutates
 * the document itself.
 */
export interface PanelModel {
  xrStatus: string;
  partLines: string[];
  historyLine: string;
  lastEvent: string;
  diagnostics: string;
  canUndo: boolean;
  canRedo: boolean;
  inXr: boolean;
}

export interface PanelActions {
  undo(): void;
  redo(): void;
  reset(): void;
  exitXr(): void;
}

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
const TEXT = '#e8edf2';
const MUTED = '#9fb0bf';
const ACCENT = '#38c9dc';

export class WallPanel {
  private tex: AdvancedDynamicTexture;
  private status: TextBlock;
  private part: TextBlock;
  private history: TextBlock;
  private event: TextBlock;
  private diag: TextBlock;
  private buttons: Record<'undo' | 'redo' | 'reset' | 'exit', Button>;

  constructor(mesh: Mesh, actions: PanelActions) {
    this.tex = AdvancedDynamicTexture.CreateForMesh(mesh, 1536, 880);
    this.tex.background = '#141a21';

    const root = new StackPanel('root');
    root.paddingLeft = '56px';
    root.paddingRight = '56px';
    root.paddingTop = '36px';
    root.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    root.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
    this.tex.addControl(root);

    const line = (name: string, size: number, color: string, height: number, bold = false) => {
      const t = new TextBlock(name, '');
      t.fontFamily = FONT;
      t.fontSize = size;
      t.color = color;
      t.height = `${height}px`;
      t.fontWeight = bold ? '600' : '400';
      t.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
      t.textWrapping = true;
      root.addControl(t);
      return t;
    };
    line('title', 52, TEXT, 72, true).text = 'Workshop · W0.1 foundation';
    this.status = line('status', 34, ACCENT, 56);
    this.part = line('part', 34, TEXT, 250);
    this.history = line('history', 30, MUTED, 48);
    this.event = line('event', 30, MUTED, 48);

    const row = new StackPanel('buttons');
    row.isVertical = false;
    row.height = '110px';
    row.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
    root.addControl(row);
    const button = (name: string, label: string, onClick: () => void) => {
      const b = Button.CreateSimpleButton(name, label);
      b.width = '300px';
      b.height = '92px';
      b.paddingRight = '24px';
      b.cornerRadius = 10;
      b.thickness = 3;
      b.color = ACCENT;
      b.background = '#1f2a35';
      b.fontFamily = FONT;
      b.fontSize = 38;
      b.textBlock!.color = TEXT;
      b.pointerEnterAnimation = () => (b.background = '#2c4252');
      b.pointerOutAnimation = () => (b.background = '#1f2a35');
      b.onPointerClickObservable.add(() => {
        if (b.isEnabled) onClick();
      });
      row.addControl(b);
      return b;
    };
    this.buttons = {
      undo: button('btn-undo', 'Undo', actions.undo),
      redo: button('btn-redo', 'Redo', actions.redo),
      reset: button('btn-reset', 'Reset part', actions.reset),
      exit: button('btn-exit', 'Exit VR', actions.exitXr),
    };

    const help = line('help', 26, MUTED, 130);
    help.text =
      'VR: point + trigger = select / press buttons · grip (squeeze) on part = grab, move & rotate; release to place.\n' +
      'Desktop: left-drag part = move on bench · Q / E rotate 15° · R reset · Esc cancel drag\n' +
      '⌘/Ctrl+Z undo · ⇧⌘/Ctrl+Z or ⌘/Ctrl+Y redo · right-drag orbit · wheel zoom · F reset camera';
    this.diag = line('diag', 24, MUTED, 40);
  }

  update(m: PanelModel) {
    this.status.text = m.xrStatus;
    this.part.text = m.partLines.join('\n');
    this.history.text = m.historyLine;
    this.event.text = m.lastEvent;
    this.diag.text = m.diagnostics;
    this.setEnabled(this.buttons.undo, m.canUndo);
    this.setEnabled(this.buttons.redo, m.canRedo);
    this.setEnabled(this.buttons.exit, m.inXr);
  }

  setDiagnostics(text: string) {
    if (this.diag.text !== text) this.diag.text = text;
  }

  private setEnabled(b: Button, on: boolean) {
    b.isEnabled = on;
    b.alpha = on ? 1 : 0.35;
  }
}
