/**
 * The visualisation registry.
 *
 * Lives in its own module so that both the Activity (`main.js`) and the
 * development harness (`preview.js`) build their menus from one list. Keeping it
 * in `main.js` would have meant the harness either importing that file - which
 * constructs a `DiscordSDK` at module scope and immediately runs `main()`, so it
 * cannot be imported outside Discord - or duplicating the list and drifting from
 * it the first time a visualisation was added.
 */

import { ShaderVisualizer } from './visualizer.js';
import { StickMenVisual } from './stickmen.js';
import { PainterVisual } from './painter.js';
import {
  BarsVisual, ScopeVisual, TunnelVisual, ColoursVisual,
  ParticlesVisual, KaleidoscopeVisual, VinylVisual, NoneVisual,
} from './visuals.js';
import {
  GalaxyVisual, TerrainVisual, RainVisual, FirefliesVisual, RibbonsVisual, MosaicVisual, AuroraVisual,
  PulseVisual,
} from './visuals2.js';

/**
 * Available visualisations, in menu order.
 *
 * `webgl` entries need a WebGL context and are dropped if it is unavailable; the
 * rest need only 2D canvas, which every Discord client provides.
 */
export const VISUALS = [
  { id: 'none', name: 'None (no visuals)', mode: '2d', make: (c) => new NoneVisual(c) },
  { id: 'stickmen', name: 'Stick Men', mode: '2d', make: (c) => new StickMenVisual(c) },
  { id: 'painter', name: 'Painter', mode: '2d', make: (c) => new PainterVisual(c) },
  { id: 'ambience', name: 'Lava Lamp', mode: 'webgl', make: (c) => new ShaderVisualizer(c) },
  { id: 'bars', name: 'Bars & Waves', mode: '2d', make: (c) => new BarsVisual(c) },
  { id: 'scope', name: 'Scope', mode: '2d', make: (c) => new ScopeVisual(c) },
  { id: 'tunnel', name: 'Tunnel', mode: '2d', make: (c) => new TunnelVisual(c) },
  { id: 'colours', name: 'Musical Colours', mode: '2d', make: (c) => new ColoursVisual(c) },
  { id: 'alchemy', name: 'Alchemy', mode: '2d', make: (c) => new ParticlesVisual(c) },
  { id: 'kaleidoscope', name: 'Kaleidoscope', mode: '2d', make: (c) => new KaleidoscopeVisual(c) },
  { id: 'vinyl', name: 'Vinyl', mode: '2d', make: (c) => new VinylVisual(c) },
  { id: 'galaxy', name: 'Galaxy', mode: '2d', make: (c) => new GalaxyVisual(c) },
  { id: 'terrain', name: 'Terrain', mode: '2d', make: (c) => new TerrainVisual(c) },
  { id: 'rain', name: 'Rain', mode: '2d', make: (c) => new RainVisual(c) },
  { id: 'fireflies', name: 'Fireflies', mode: '2d', make: (c) => new FirefliesVisual(c) },
  { id: 'ribbons', name: 'Ribbons', mode: '2d', make: (c) => new RibbonsVisual(c) },
  { id: 'mosaic', name: 'Mosaic', mode: '2d', make: (c) => new MosaicVisual(c) },
  { id: 'aurora', name: 'Aurora', mode: '2d', make: (c) => new AuroraVisual(c) },
  { id: 'pulse', name: 'Pulse', mode: '2d', make: (c) => new PulseVisual(c) },
];
