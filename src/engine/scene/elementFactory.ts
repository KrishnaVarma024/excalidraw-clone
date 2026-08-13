/**
 * Element constructors.
 *
 * One place that knows how to build a valid element, so "what does a new
 * rectangle look like?" has exactly one answer. Every field is set explicitly —
 * no partial objects, no `undefined` holes to trip over three phases later.
 */

import { newId, newSeed } from '../util/id';
import { normalizeAngle } from '../util/math';
import type { Point } from '../util/geometry';
import {
  type DiamondElement,
  type Element,
  type ElementStyle,
  type EllipseElement,
  type FreedrawElement,
  type LinearElement,
  type RectangleElement,
  assertNever,
} from './element.types';

interface CommonArgs {
  x: number;
  y: number;
  width: number;
  height: number;
  style: ElementStyle;
  zIndex: number;
  angle?: number;
}

function base(args: CommonArgs) {
  return {
    id: newId(),
    version: 1,
    x: args.x,
    y: args.y,
    width: args.width,
    height: args.height,
    angle: normalizeAngle(args.angle ?? 0),
    strokeColor: args.style.strokeColor,
    backgroundColor: args.style.backgroundColor,
    fillStyle: args.style.fillStyle,
    strokeWidth: args.style.strokeWidth,
    strokeStyle: args.style.strokeStyle,
    roughness: args.style.roughness,
    opacity: args.style.opacity,
    seed: newSeed(),
    isDeleted: false,
    zIndex: args.zIndex,
  };
}

export function newRectangle(args: CommonArgs): RectangleElement {
  return { ...base(args), type: 'rectangle' };
}

export function newDiamond(args: CommonArgs): DiamondElement {
  return { ...base(args), type: 'diamond' };
}

export function newEllipse(args: CommonArgs): EllipseElement {
  return { ...base(args), type: 'ellipse' };
}

export function newLinear(
  args: CommonArgs & { type: 'line' | 'arrow'; points: readonly Point[] },
): LinearElement {
  return {
    ...base(args),
    type: args.type,
    points: args.points,
    startArrowhead: null,
    endArrowhead: args.type === 'arrow' ? 'arrow' : null,
  };
}

export function newFreedraw(
  args: CommonArgs & {
    points: readonly Point[];
    pressures: readonly number[];
    simulatePressure: boolean;
  },
): FreedrawElement {
  return {
    ...base(args),
    type: 'freedraw',
    points: args.points,
    pressures: args.pressures,
    simulatePressure: args.simulatePressure,
  };
}

/**
 * Build the right element for a tool, from a drag rectangle.
 *
 * The `never` default is the exhaustiveness guard: add a shape tool to the
 * union and this fails to compile until it is handled here.
 */
export type ShapeToolType = 'rectangle' | 'diamond' | 'ellipse' | 'line' | 'arrow';

export function newShape(
  type: ShapeToolType,
  args: CommonArgs & { points?: readonly Point[] },
): Element {
  switch (type) {
    case 'rectangle':
      return newRectangle(args);
    case 'diamond':
      return newDiamond(args);
    case 'ellipse':
      return newEllipse(args);
    case 'line':
    case 'arrow':
      return newLinear({
        ...args,
        type,
        points: args.points ?? [
          { x: 0, y: 0 },
          { x: args.width, y: args.height },
        ],
      });
    default:
      return assertNever(type, 'newShape');
  }
}

/**
 * Normalise a drag into a positive-size rectangle.
 *
 * Dragging up-and-left produces a negative width and height. Normalising here,
 * at the one place elements are born, means nothing downstream — bounds,
 * rendering, hit-testing, export — ever has to ask "what if width is negative?"
 *
 * Note that lines and arrows deliberately do *not* use this: for them the drag
 * direction is meaningful, since it decides which end gets the arrowhead. That
 * asymmetry is why this is a separate function rather than something baked into
 * the factory.
 */
export function normalizeDrag(
  origin: Point,
  current: Point,
): { x: number; y: number; width: number; height: number } {
  const width = current.x - origin.x;
  const height = current.y - origin.y;
  return {
    x: width >= 0 ? origin.x : current.x,
    y: height >= 0 ? origin.y : current.y,
    width: Math.abs(width),
    height: Math.abs(height),
  };
}
