import type { Engine } from '@engine/Engine';
import type { FillStyle, StrokeStyle } from '@engine/scene/element.types';
import { TRANSPARENT } from '@engine/scene/element.types';
import { useEngineState } from './useEngineState';

interface Props {
  engine: Engine;
}

const STROKE_COLORS = ['#1b1b1f', '#e03131', '#2f9e44', '#1971c2', '#f08c00'];
const BACKGROUNDS = [TRANSPARENT, '#ffc9c9', '#b2f2bb', '#a5d8ff', '#ffec99'];

const FILL_STYLES: readonly { value: FillStyle; label: string }[] = [
  { value: 'hachure', label: 'Hachure' },
  { value: 'cross-hatch', label: 'Cross' },
  { value: 'solid', label: 'Solid' },
];

const STROKE_STYLES: readonly { value: StrokeStyle; label: string }[] = [
  { value: 'solid', label: 'Solid' },
  { value: 'dashed', label: 'Dashed' },
  { value: 'dotted', label: 'Dotted' },
];

const WIDTHS = [1, 2, 4];
const ROUGHNESS = [
  { value: 0, label: 'Architect' },
  { value: 1, label: 'Artist' },
  { value: 2, label: 'Cartoon' },
];

/**
 * Style controls for the next shape you draw.
 *
 * Note what this edits: the *pending* style held by the tool manager, not any
 * existing element. It has to exist before an element does, which is why
 * `ElementStyle` is a type in its own right rather than a subset of `Element`.
 *
 * Phase 6 adds selection, at which point these controls gain a second job —
 * editing whatever is selected — and the panel will need to show mixed values
 * ("three elements, two red and one blue"). Deliberately not built yet: there
 * is nothing to select.
 *
 * Every value here is discrete and human-driven, so this is the right side of
 * the two-channel split — plain `useSyncExternalStore`, plain re-renders.
 */
export function StylePanel({ engine }: Props) {
  const { style } = useEngineState(engine);

  return (
    <div className="style-panel" aria-label="Element style">
      <Group label="Stroke">
        <div className="swatches">
          {STROKE_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              className={style.strokeColor === color ? 'swatch swatch-active' : 'swatch'}
              style={{ background: color }}
              onClick={() => engine.setStyle({ strokeColor: color })}
              aria-label={`Stroke ${color}`}
              aria-pressed={style.strokeColor === color}
            />
          ))}
        </div>
      </Group>

      <Group label="Background">
        <div className="swatches">
          {BACKGROUNDS.map((color) => (
            <button
              key={color}
              type="button"
              className={[
                'swatch',
                color === TRANSPARENT ? 'swatch-transparent' : '',
                style.backgroundColor === color ? 'swatch-active' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              style={color === TRANSPARENT ? undefined : { background: color }}
              onClick={() => engine.setStyle({ backgroundColor: color })}
              aria-label={color === TRANSPARENT ? 'No background' : `Background ${color}`}
              aria-pressed={style.backgroundColor === color}
            />
          ))}
        </div>
      </Group>

      {/* Fill style only means something when there is a fill to style. Hiding
          it rather than disabling it keeps the panel short — a disabled control
          you can never reach from here is just noise. */}
      {style.backgroundColor !== TRANSPARENT && (
        <Group label="Fill">
          <Segmented
            options={FILL_STYLES}
            value={style.fillStyle}
            onChange={(fillStyle) => engine.setStyle({ fillStyle })}
          />
        </Group>
      )}

      <Group label="Stroke width">
        <div className="segmented">
          {WIDTHS.map((w) => (
            <button
              key={w}
              type="button"
              className={style.strokeWidth === w ? 'seg seg-active' : 'seg'}
              onClick={() => engine.setStyle({ strokeWidth: w })}
              aria-pressed={style.strokeWidth === w}
              aria-label={`Stroke width ${w}`}
            >
              <span className="width-preview" style={{ height: `${w}px` }} />
            </button>
          ))}
        </div>
      </Group>

      <Group label="Stroke style">
        <Segmented
          options={STROKE_STYLES}
          value={style.strokeStyle}
          onChange={(strokeStyle) => engine.setStyle({ strokeStyle })}
        />
      </Group>

      <Group label="Sloppiness">
        <Segmented
          options={ROUGHNESS}
          value={style.roughness}
          onChange={(roughness) => engine.setStyle({ roughness })}
        />
      </Group>

      <Group label={`Opacity ${style.opacity}%`}>
        <input
          type="range"
          min={10}
          max={100}
          step={10}
          value={style.opacity}
          onChange={(e) => engine.setStyle({ opacity: Number(e.target.value) })}
          aria-label="Opacity"
        />
      </Group>
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="style-group">
      <div className="style-label">{label}</div>
      {children}
    </div>
  );
}

function Segmented<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          className={value === o.value ? 'seg seg-active' : 'seg'}
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          title={o.label}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
